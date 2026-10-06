/**
 * =============================================================================
 * ORION SWAP PILL — floating active-swap status (bottom-LEFT corner)
 * =============================================================================
 *
 * Companion surface for ActiveSwapHubService: once a cross-chain swap is in
 * flight, this pill keeps it visible on EVERY route (the agent FAB owns the
 * bottom-RIGHT corner; this one is bottom-LEFT, so no overlap by
 * construction). Hidden on /swap — the status screen itself renders there.
 *
 * Collapsed: chip with a phase dot and `ETH→BASE · Bridging`-style copy.
 * Terminal variants: success auto-dismisses after 10 s; failed/partial turn
 * danger-toned and persist until the user engages; untracked/timeout stay
 * neutral with "Check explorer" copy.
 *
 * Expanded (click): card opening upward with the swap amounts, the mini
 * step-timeline from the hub's tracking state (with per-step explorer links
 * and the end-to-end tracker link when known), plus "Open swap" (restores
 * the live status screen) and a close control. Closing a SETTLED swap
 * dismisses the pill entirely — the user has seen the outcome; closing a
 * live one only collapses (the transfer is still being watched).
 *
 * Money honesty: amounts are the quote summary strings as-is — nothing is
 * re-derived, so no fabricated `$0.00`-style values can appear here.
 *
 * @author Orion DEX Team
 * @version 1.0.0
 */
import { ChangeDetectionStrategy, Component, DestroyRef, HostListener, computed, effect, inject, signal } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { ActiveSwapHubService, isSwapSettled } from '../../../core/services/swap/active-swap-hub.service';
import type { ActiveSwapPhase } from '../../../core/services/swap/active-swap-hub.service';
import { getNetworkById } from '../../../core/constants';

/** Success is good news, not homework — the pill leaves on its own. */
export const SUCCESS_AUTO_DISMISS_MS = 10_000;

type PillTone = 'live' | 'ok' | 'danger' | 'neutral';

@Component({
  selector: 'app-orion-swap-pill',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible(); as summary) {
      @if (!expanded()) {
        <button
          type="button"
          class="swap-pill"
          [class]="'swap-pill tone-' + tone()"
          (click)="expanded.set(true)"
          aria-label="Show active swap status"
        >
          @if (tone() === 'live') {
            <span class="pill-dot orion-pulse-dot" aria-hidden="true"></span>
          } @else if (tone() === 'ok') {
            <span class="material-symbols-outlined pill-icon" aria-hidden="true">check</span>
          } @else if (tone() === 'danger') {
            <span class="material-symbols-outlined pill-icon" aria-hidden="true">close</span>
          } @else {
            <span class="material-symbols-outlined pill-icon" aria-hidden="true">travel_explore</span>
          }
          <span class="pill-label" aria-live="polite">{{ pillLabel() }}</span>
        </button>
      } @else {
        <div class="swap-pill-card" role="dialog" aria-label="Active swap status">
          <div class="card-header">
            <span class="card-amounts orion-tabular">
              {{ summary.fromAmount }} {{ summary.fromSymbol }}
              <span class="card-arrow" aria-hidden="true">→</span>
              {{ summary.toAmount }} {{ summary.toSymbol }}
            </span>
            <button type="button" class="card-close" (click)="close()" aria-label="Close swap status">
              <span class="material-symbols-outlined" aria-hidden="true">close</span>
            </button>
          </div>

          <div class="card-status" [class]="'card-status tone-' + tone()" aria-live="polite">
            {{ statusLabel() }}
          </div>

          @if (steps().length > 0) {
            <ul class="card-steps">
              @for (step of steps(); track step.id) {
                <li class="card-step">
                  <span class="step-dot" [class]="'step-dot step-' + step.status" aria-hidden="true"></span>
                  <span class="step-title" [class.step-title-pending]="step.status === 'pending'">
                    {{ step.title }}
                  </span>
                  @if (step.status === 'completed') {
                    <span class="sr-only">Completed</span>
                  } @else if (step.status === 'failed') {
                    <span class="sr-only">Failed</span>
                  }
                  @if (step.explorerLink) {
                    <a class="step-link" [href]="step.explorerLink" target="_blank" rel="noopener">
                      View
                      <span class="material-symbols-outlined" aria-hidden="true">open_in_new</span>
                    </a>
                  }
                </li>
              }
            </ul>
          }

          @if (trackerUrl(); as url) {
            <a class="card-tracker" [href]="url" target="_blank" rel="noopener">
              Track transfer
              <span class="material-symbols-outlined" aria-hidden="true">open_in_new</span>
            </a>
          }

          <button type="button" class="card-open" (click)="openSwap()">
            Open swap
          </button>
        </div>
      }
    }
  `,
  styles: [`
    :host { display: contents; }

    /* Bottom-LEFT anchor — the agent FAB owns the bottom-RIGHT corner. */
    .swap-pill,
    .swap-pill-card {
      position: fixed;
      left: 20px;
      bottom: calc(20px + env(safe-area-inset-bottom, 0px));
      z-index: var(--z-sticky);
      font-family: var(--orion-font-display);
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.38);
    }

    .swap-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      height: 48px;
      padding: 0 18px 0 14px;
      border: 1px solid var(--orion-border-strong);
      border-radius: var(--orion-radius-chip);
      background: var(--orion-surface-2);
      color: var(--orion-text);
      font-size: 13.5px;
      font-weight: 600;
      line-height: 1;
      cursor: pointer;
      transition: background 160ms ease, transform 120ms ease;

      &:active { transform: scale(0.97); }
      &:focus-visible { outline: 2px solid var(--orion-accent-text); outline-offset: 2px; }
    }
    /* Live bridging mirrors the agent FAB: accent bg, white text (AA). */
    .swap-pill.tone-live {
      background: var(--orion-accent);
      border-color: transparent;
      color: #fff;
      &:hover { background: var(--orion-accent-hover); }
    }
    .swap-pill.tone-ok {
      background: var(--orion-success-tint);
      border-color: transparent;
      color: var(--orion-success);
    }
    .swap-pill.tone-danger {
      background: var(--orion-danger-tint);
      border-color: transparent;
      color: var(--orion-danger);
    }
    .swap-pill.tone-neutral:hover { background: var(--orion-surface-3); }

    .pill-dot {
      width: 8px;
      height: 8px;
      border-radius: var(--orion-radius-chip);
      background: currentColor;
      flex: none;
    }
    .pill-icon { font-size: 18px; flex: none; }
    .pill-label { white-space: nowrap; }

    /* Expanded card: anchored to the same corner, grows upward. */
    .swap-pill-card {
      width: min(320px, calc(100vw - 40px));
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 14px;
      border: 1px solid var(--orion-border-strong);
      border-radius: var(--orion-radius-panel);
      background: var(--orion-surface-2);
      color: var(--orion-text);
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .card-amounts {
      font-size: 14px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card-arrow { color: var(--orion-muted); }
    .card-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      /* 44px touch target via padding around the 20px glyph. */
      width: 32px;
      height: 32px;
      margin: -4px -6px -4px 0;
      border: none;
      border-radius: var(--orion-radius-chip);
      background: transparent;
      color: var(--orion-muted);
      cursor: pointer;
      .material-symbols-outlined { font-size: 20px; }
      &:hover { background: var(--orion-surface-3); color: var(--orion-text); }
      &:focus-visible { outline: 2px solid var(--orion-accent-text); outline-offset: 2px; }
    }

    .card-status {
      font-size: 12.5px;
      font-weight: 600;
    }
    .card-status.tone-live { color: var(--orion-accent-text); }
    .card-status.tone-ok { color: var(--orion-success); }
    .card-status.tone-danger { color: var(--orion-danger); }
    .card-status.tone-neutral { color: var(--orion-muted); }

    .card-steps {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .card-step {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
    }
    .step-dot {
      width: 8px;
      height: 8px;
      border-radius: var(--orion-radius-chip);
      background: var(--orion-surface-3);
      flex: none;
    }
    .step-dot.step-completed { background: var(--orion-success); }
    .step-dot.step-failed { background: var(--orion-danger); }
    .step-dot.step-in_progress { background: var(--orion-accent-text); }
    .step-title { color: var(--orion-text); min-width: 0; }
    .step-title-pending { color: var(--orion-subtle); }
    .step-link,
    .card-tracker {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      color: var(--orion-muted);
      font-size: 12px;
      text-decoration: none;
      .material-symbols-outlined { font-size: 12px; }
      &:hover { color: var(--orion-accent-text); }
      &:focus-visible { outline: 2px solid var(--orion-accent-text); outline-offset: 2px; }
    }
    .step-link { margin-left: auto; flex: none; }
    .card-tracker { align-self: flex-start; }

    .card-open {
      height: 40px;
      border: none;
      border-radius: var(--orion-radius-button);
      background: var(--orion-accent);
      color: #fff;
      font: 600 13.5px/1 var(--orion-font-display);
      cursor: pointer;
      &:hover { background: var(--orion-accent-hover); }
      &:focus-visible { outline: 2px solid var(--orion-accent-text); outline-offset: 2px; }
    }
  `],
})
export class OrionSwapPillComponent {
  protected readonly hub = inject(ActiveSwapHubService);
  private readonly router = inject(Router);

  /** Re-evaluates the current URL on every completed navigation. */
  private readonly navEnd = toSignal(
    this.router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd)),
  );

  private readonly onSwapRoute = computed<boolean>(() => {
    const url = this.navEnd()?.urlAfterRedirects ?? this.router.url;
    return url === '/swap' || url.startsWith('/swap?') || url.startsWith('/swap#');
  });

  /**
   * The summary to render, or null when the pill must not show: no active
   * swap, or the user is already on /swap where the status screen itself
   * renders the same state.
   */
  protected readonly visible = computed(() => {
    const summary = this.hub.activeSwap();
    if (!summary || this.onSwapRoute()) return null;
    return summary;
  });

  protected readonly expanded = signal<boolean>(false);

  protected readonly tone = computed<PillTone>(() => {
    switch (this.hub.activeSwap()?.phase) {
      case 'success': return 'ok';
      case 'failed':
      case 'partial': return 'danger';
      case 'untracked':
      case 'timeout': return 'neutral';
      default: return 'live';
    }
  });

  /** `ETH→BASE`-style chain route for the collapsed chip. */
  private readonly routeLabel = computed<string>(() => {
    const summary = this.hub.activeSwap();
    if (!summary) return '';
    const from = getNetworkById(summary.fromChainId)?.shortName ?? `#${summary.fromChainId}`;
    const to = getNetworkById(summary.toChainId)?.shortName ?? `#${summary.toChainId}`;
    return `${from}→${to}`;
  });

  protected readonly statusLabel = computed<string>(() => {
    const phase = this.hub.activeSwap()?.phase;
    return phase ? OrionSwapPillComponent.phaseCopy(phase) : '';
  });

  protected readonly pillLabel = computed<string>(() => {
    const phase = this.hub.activeSwap()?.phase;
    if (!phase) return '';
    // Success needs no route prefix — the checkmark + copy carry it.
    if (phase === 'success') return OrionSwapPillComponent.phaseCopy(phase);
    return `${this.routeLabel()} · ${OrionSwapPillComponent.phaseCopy(phase)}`;
  });

  protected readonly steps = computed(() => this.hub.trackingState()?.steps ?? []);

  /** End-to-end tracker link: summary verdict first, live poll state second. */
  protected readonly trackerUrl = computed<string | null>(() => {
    const summary = this.hub.activeSwap();
    if (summary?.trackingUrl) return summary.trackingUrl;
    return this.hub.trackingState()?.trackingUrl ?? null;
  });

  private dismissTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Success auto-dismisses: good news should not require cleanup. Any
    // phase change (or replacement/dismissal) cancels the pending timer so
    // a stale timeout can't dismiss a NEW swap's pill.
    effect(() => {
      const phase = this.hub.activeSwap()?.phase;
      if (this.dismissTimer) {
        clearTimeout(this.dismissTimer);
        this.dismissTimer = null;
      }
      if (phase === 'success') {
        this.dismissTimer = setTimeout(() => this.hub.dismiss(), SUCCESS_AUTO_DISMISS_MS);
      }
    }, { allowSignalWrites: true });

    // Collapse whenever the pill hides (navigated to /swap, dismissed, or
    // replaced) so it never re-appears pre-expanded somewhere else.
    effect(() => {
      if (!this.visible()) {
        this.expanded.set(false);
      }
    }, { allowSignalWrites: true });

    // Defensive: the pill lives in the app shell today (app-lifetime), but
    // if the mount ever changes, a pending auto-dismiss timer must not
    // outlive the component and dismiss a pill nobody renders.
    inject(DestroyRef).onDestroy(() => {
      if (this.dismissTimer) {
        clearTimeout(this.dismissTimer);
        this.dismissTimer = null;
      }
    });
  }

  /** Escape collapses the expanded card (one Escape closes one layer). */
  @HostListener('document:keydown.escape', ['$event'])
  protected handleEscape(event: KeyboardEvent): void {
    if (!this.expanded()) return;
    this.expanded.set(false);
    event.stopImmediatePropagation();
  }

  /**
   * Close control: a SETTLED swap is dismissed for good (the user has seen
   * the outcome); a live one only collapses — the hub keeps watching and
   * the chip stays available.
   */
  protected close(): void {
    const summary = this.hub.activeSwap();
    if (summary && isSwapSettled(summary.phase)) {
      this.hub.dismiss();
    }
    this.expanded.set(false);
  }

  /** Jump back to the swap screen — it restores the live status view. */
  protected openSwap(): void {
    this.expanded.set(false);
    void this.router.navigateByUrl('/swap');
  }

  private static phaseCopy(phase: ActiveSwapPhase): string {
    switch (phase) {
      case 'success': return 'Swap complete ✓';
      case 'failed': return 'Swap failed';
      case 'partial': return 'Fallback token delivered';
      case 'untracked':
      case 'timeout': return 'Check explorer';
      case 'confirming': return 'Confirming';
      default: return 'Bridging';
    }
  }
}
