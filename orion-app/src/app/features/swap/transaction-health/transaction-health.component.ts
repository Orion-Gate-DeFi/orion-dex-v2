/**
 * =============================================================================
 * TRANSACTION HEALTH COMPONENT
 * =============================================================================
 *
 * Displays security analysis for tokens in a swap.
 * Shows risks, warnings, and positive indicators.
 *
 * The scoring stays 5-level (the API and the CTA gates use it), but the
 * VISUAL language collapses to 3 tiers — safe/low were indistinguishable
 * greens and the distinction carries no user action:
 *   safe+low → ok (green) · medium → caution (gold) · high+critical → risk (red)
 *
 * @author Orion DEX Team
 * @version 2.1.0 — tier colours read CSS-var rgb triplets from _tokens.scss
 *                  (hardcoded triplets had gone stale vs --orion-danger).
 *                  v2.0.0: 3 visual tiers; Starlight tokens.
 */

import { Component, input, computed, inject, effect, signal, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  TokenSecurityService,
  TokenSecurityResult,
  RiskLevel,
  RiskItem,
} from '../../../core/services/token-security.service';
import { Token } from '../../../core/models/token.model';

@Component({
  selector: 'app-transaction-health',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './transaction-health.component.html',
  styleUrl: './transaction-health.component.scss'
})
export class TransactionHealthComponent implements OnDestroy {
  securityService = inject(TokenSecurityService);

  // Inputs
  fromToken = input<Token | null>(null);
  toToken = input<Token | null>(null);
  /**
   * When true, the component is controlled by its parent (no self-rendered
   * header / toggle) — used when the details panel slides out from the
   * info-strip's Safety cell.
   */
  embedded = input<boolean>(false);

  // State
  fromTokenSecurity = signal<TokenSecurityResult | null>(null);
  toTokenSecurity = signal<TokenSecurityResult | null>(null);
  isLoading = signal<boolean>(false);
  isExpanded = signal<boolean>(false);

  // Computed
  overallRisk = computed<RiskLevel>(() => {
    const from = this.fromTokenSecurity();
    const to = this.toTokenSecurity();

    if (!from && !to) return 'safe';

    const risks: RiskLevel[] = [];
    if (from) risks.push(from.riskLevel);
    if (to) risks.push(to.riskLevel);

    const order: RiskLevel[] = ['safe', 'low', 'unknown', 'medium', 'high', 'critical'];
    return risks.reduce((max, r) => (order.indexOf(r) > order.indexOf(max) ? r : max), 'safe');
  });

  /** 5 API levels → 3 visual tiers. */
  static tierOf(level: RiskLevel): 'ok' | 'caution' | 'risk' {
    if (level === 'safe' || level === 'low') return 'ok';
    if (level === 'medium' || level === 'unknown') return 'caution';
    return 'risk';
  }

  /**
   * Starlight tier colours (success / gold / danger) as CSS-var rgb
   * triplets, composed into rgb()/rgba() by the computed colors below.
   * The values live in _tokens.scss next to their hex counterparts —
   * hardcoded triplets here silently went stale when --orion-danger moved
   * from #E8555A to #EC6A6E for AA contrast.
   */
  private static readonly TIER_RGB: Record<'ok' | 'caution' | 'risk', string> = {
    ok: 'var(--orion-success-rgb)',
    caution: 'var(--orion-health-medium-rgb)',
    risk: 'var(--orion-danger-rgb)',
  };

  overallTier = computed(() => TransactionHealthComponent.tierOf(this.overallRisk()));

  /** Badge label keeps severity visible inside the red tier. */
  riskInfo = computed(() => {
    const tier = this.overallTier();
    if (tier === 'ok') return { label: 'Looks safe', icon: 'verified_user' };
    if (tier === 'caution') {
      return this.overallRisk() === 'unknown'
        ? { label: 'Not verified', icon: 'help' }
        : { label: 'Caution', icon: 'warning' };
    }
    return {
      label: this.overallRisk() === 'critical' ? 'Critical risk' : 'High risk',
      icon: 'dangerous',
    };
  });

  /** Per-token mini badge (detail footer). */
  tierInfo(level: RiskLevel): { icon: string; color: string } {
    const tier = TransactionHealthComponent.tierOf(level);
    const icons = { ok: 'verified_user', caution: 'warning', risk: 'dangerous' } as const;
    return {
      icon: icons[tier],
      color: `rgb(${TransactionHealthComponent.TIER_RGB[tier]})`,
    };
  }

  healthColor = computed(() => `rgb(${TransactionHealthComponent.TIER_RGB[this.overallTier()]})`);
  healthTint = computed(() => `rgba(${TransactionHealthComponent.TIER_RGB[this.overallTier()]}, 0.14)`);
  healthBg = computed(() => `rgba(${TransactionHealthComponent.TIER_RGB[this.overallTier()]}, 0.04)`);
  healthBorder = computed(() => `rgba(${TransactionHealthComponent.TIER_RGB[this.overallTier()]}, 0.22)`);

  // All risks from both tokens (deduplicated)
  allRisks = computed<RiskItem[]>(() => {
    const risks: RiskItem[] = [];
    const from = this.fromTokenSecurity();
    const to = this.toTokenSecurity();

    if (from) risks.push(...from.risks);
    if (to) {
      // Add only unique risks from toToken
      for (const risk of to.risks) {
        if (!risks.some((r) => r.message === risk.message)) {
          risks.push(risk);
        }
      }
    }

    // Sort by severity
    const severityOrder = { critical: 0, high: 1, medium: 2, info: 3, good: 4 };
    return risks.sort((a, b) => severityOrder[a.type] - severityOrder[b.type]);
  });

  allPositives = computed<RiskItem[]>(() => {
    const positives: RiskItem[] = [];
    const from = this.fromTokenSecurity();
    const to = this.toTokenSecurity();

    if (from) positives.push(...from.positives);
    if (to) {
      for (const p of to.positives) {
        if (!positives.some((r) => r.message === p.message)) {
          positives.push(p);
        }
      }
    }
    return positives;
  });

  hasRisks = computed(() => this.allRisks().length > 0);
  hasCriticalRisk = computed(() =>
    this.allRisks().some((r) => r.type === 'critical')
  );

  // Effect to check security when tokens change
  private checkEffect = effect(() => {
    const from = this.fromToken();
    const to = this.toToken();
    this.checkSecurity(from, to);
  }, { allowSignalWrites: true });

  ngOnDestroy(): void {
    this.checkEffect.destroy();
  }

  toggleExpanded(): void {
    this.isExpanded.update((v) => !v);
  }

  private async checkSecurity(from: Token | null, to: Token | null): Promise<void> {
    // Reset if no tokens
    if (!from && !to) {
      this.fromTokenSecurity.set(null);
      this.toTokenSecurity.set(null);
      return;
    }

    this.isLoading.set(true);

    try {
      const promises: Promise<void>[] = [];

      if (from) {
        promises.push(
          this.securityService
            .checkTokenSecurity(from.chainId, from.address)
            .then((result) => this.fromTokenSecurity.set(result))
        );
      } else {
        this.fromTokenSecurity.set(null);
      }

      if (to) {
        promises.push(
          this.securityService
            .checkTokenSecurity(to.chainId, to.address)
            .then((result) => this.toTokenSecurity.set(result))
        );
      } else {
        this.toTokenSecurity.set(null);
      }

      await Promise.all(promises);
    } catch (error) {
      console.error('[TransactionHealth] Error:', error);
    } finally {
      this.isLoading.set(false);
    }
  }

  /** Detail rows keep finer granularity than the 3-tier badge — this is
   *  the expert zone the beginner never opens. */
  getRiskItemColor(type: RiskItem['type']): string {
    switch (type) {
      case 'critical':
        return 'var(--orion-danger)';
      case 'high':
        return 'var(--orion-health-high)';
      case 'medium':
        return 'var(--orion-health-medium)';
      case 'info':
        return 'var(--orion-muted)';
      case 'good':
        return 'var(--orion-success)';
    }
  }
}
