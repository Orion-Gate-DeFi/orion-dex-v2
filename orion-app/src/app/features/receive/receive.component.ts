/**
 * =============================================================================
 * RECEIVE COMPONENT
 * =============================================================================
 *
 * Receive tokens by sharing wallet address or payment link.
 * Designed for crypto beginners with clear, simple UI.
 *
 * Features:
 * - Display wallet address with copy button
 * - QR code for easy scanning
 * - Payment Link generator with token selection
 * - Network selection
 *
 * @author Orion DEX Team
 * @version 1.2.0 — invalidate the generated link on ANY edit (amount, token,
 *                  network): Copy/Share could distribute a link carrying the
 *                  old amount. v1.1.0: surface clipboard failures, validate
 *                  the requested amount before generating.
 */

import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit, effect, ElementRef, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { toCanvas } from 'qrcode';
import { WalletService } from '../../core/services/wallet.service';
import { LifiService } from '../../core/services/lifi.service';
import { ToastService } from '../../core/services/toast.service';
import { AnalyticsService } from '../../core/services/analytics.service';
import { StatusIconComponent } from '../../shared/components/status-icon/status-icon.component';
import {
  NETWORKS,
  NetworkInfo,
} from '../../core/constants';

// =============================================================================
// TYPES
// =============================================================================

interface TokenOption {
  address: string;
  symbol: string;
  name: string;
  logoURI: string;
  chainId: number;
}

// =============================================================================
// COMPONENT
// =============================================================================

@Component({
  selector: 'app-receive',
  standalone: true,
  imports: [CommonModule, FormsModule, StatusIconComponent],
  // Safe on OnPush: all view state is signals/computed; the one plain field
  // (requestAmount) is only written by its own ngModel input event, which
  // marks the component dirty. The copied/linkCopied setTimeout resets write
  // signals, so the hybrid scheduler picks them up too.
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './receive.component.html'
})
export class ReceiveComponent implements OnInit {
  /**
   * Canvas the QR code is drawn into. Rendering client-side avoids a
   * round-trip to api.qrserver.com — that round-trip leaked the user's
   * wallet address (and the associated browser-IP fingerprint) to a
   * third-party service that has no operational reason to know either.
   *
   * Signal-based viewChild, not the decorator: the canvas lives inside the
   * connected branch of the template, so when the wallet connects while the
   * user is already on this page, the element mounts in the same CD cycle
   * as the address effect run. A decorator query saw `undefined`, bailed
   * out, and never retried (the address didn't change) — blank white square
   * instead of a QR. The signal re-fires the render effect once the canvas
   * actually exists (same wiring as the dashboard's allocCard).
   */
  private readonly qrCanvas = viewChild<ElementRef<HTMLCanvasElement>>('qrCanvas');
  // Services
  walletService = inject(WalletService);
  private lifiService = inject(LifiService);
  private toastService = inject(ToastService);
  private analytics = inject(AnalyticsService);

  // Networks
  readonly networks = NETWORKS;

  // State
  activeTab = signal<'address' | 'payment-link'>('address');
  selectedNetwork = signal<NetworkInfo | null>(NETWORKS[0]);
  selectedToken = signal<TokenOption | null>(null);
  availableTokens = signal<TokenOption[]>([]);
  isLoadingTokens = signal(false);
  showTokenSelector = signal(false);
  copied = signal(false);
  linkCopied = signal(false);

  /** QR rendering failed — drives a visible fallback instead of a blank square. */
  qrError = signal(false);

  // Token search
  tokenSearchQuery = signal('');
  filteredTokens = computed(() => {
    const query = this.tokenSearchQuery().toLowerCase().trim();
    const tokens = this.availableTokens();

    if (!query) {
      return tokens.slice(0, 10); // Show top 10 by default
    }

    return tokens.filter(t =>
      t.symbol.toLowerCase().includes(query) ||
      t.name.toLowerCase().includes(query)
    ).slice(0, 10);
  });

  // Payment Link form
  requestAmount = '';
  generatedLink = signal('');

  /** Requested amount failed validation on the last generate attempt. */
  requestAmountInvalid = signal(false);

  constructor() {
    // Load tokens when network changes
    effect(() => {
      const network = this.selectedNetwork();
      if (network && this.walletService.isConnected()) {
        this.loadTokensForNetwork();
      }
    }, { allowSignalWrites: true });

    // Re-render the QR whenever the canvas mounts (connect while already on
    // this page) or the wallet address changes (login, account swap).
    effect(() => {
      const canvas = this.qrCanvas()?.nativeElement;
      const address = this.walletService.address();
      if (canvas && address) {
        void this.renderQrCode(canvas, address);
      }
    });
  }

  ngOnInit(): void {
    if (this.walletService.isConnected()) {
      this.loadTokensForNetwork();
    }
  }

  private async renderQrCode(canvas: HTMLCanvasElement, address: string): Promise<void> {
    try {
      await toCanvas(canvas, address, {
        width: 200,
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      });
      this.qrError.set(false);
    } catch {
      // Surface the failure in the UI — the canvas stays mounted (hidden, not
      // removed) so a later address change can retry and clear the error.
      this.qrError.set(true);
    }
  }

  selectNetwork(network: NetworkInfo): void {
    this.selectedNetwork.set(network);
    this.selectedToken.set(null);
    this.generatedLink.set('');
    this.linkCopied.set(false);
    this.loadTokensForNetwork();
  }

  async loadTokensForNetwork(): Promise<void> {
    const network = this.selectedNetwork();
    if (!network) {
      this.availableTokens.set([]);
      return;
    }

    this.isLoadingTokens.set(true);

    try {
      // Get tokens for this network from LI.FI (load more for search)
      const tokens = await this.lifiService.getTokensForChain(network.id);

      // Map to TokenOption - load more tokens for better search
      const tokenOptions: TokenOption[] = tokens
        .slice(0, 100)
        .map((t: { address: string; symbol: string; name: string; logoURI?: string; chainId: number }) => ({
          address: t.address,
          symbol: t.symbol,
          name: t.name,
          logoURI: t.logoURI || '',
          chainId: t.chainId,
        }));

      this.availableTokens.set(tokenOptions);
    } catch (error) {
      console.error('Error loading tokens:', error);
      this.availableTokens.set([]);
    } finally {
      this.isLoadingTokens.set(false);
    }
  }

  selectToken(token: TokenOption): void {
    this.selectedToken.set(token);
    this.showTokenSelector.set(false);
    this.tokenSearchQuery.set('');
    this.generatedLink.set(''); // Reset link when token changes
    this.linkCopied.set(false);
  }

  clearTokenSelection(): void {
    this.selectedToken.set(null);
    this.tokenSearchQuery.set('');
    this.generatedLink.set('');
    this.linkCopied.set(false);
  }

  onTokenSearch(query: string): void {
    this.tokenSearchQuery.set(query);
    this.showTokenSelector.set(true);
  }

  /**
   * Clear the inline validation error as soon as the user edits the amount,
   * and invalidate any previously generated link — Copy/Share kept serving
   * the link with the OLD amount until the user pressed Generate again.
   * Same invalidation as token/network changes: edits force an explicit
   * re-generate before the link can be distributed.
   */
  onRequestAmountChange(value: string): void {
    this.requestAmount = value;
    this.requestAmountInvalid.set(false);
    this.generatedLink.set('');
    this.linkCopied.set(false);
  }

  generatePaymentLink(): void {
    const address = this.walletService.address();
    const token = this.selectedToken();
    const network = this.selectedNetwork();

    if (!address || !token || !network) return;

    // Same plain-decimal rule the send side enforces on the `amount` URL
    // param (send.component parseUrlParams) — anything else would silently
    // be dropped there, producing a link that doesn't do what the user
    // typed. Block generation with inline feedback instead.
    const requestedAmount = this.requestAmount.trim();
    if (requestedAmount && !(/^\d+(\.\d+)?$/.test(requestedAmount) && parseFloat(requestedAmount) > 0)) {
      this.requestAmountInvalid.set(true);
      return;
    }
    this.requestAmountInvalid.set(false);

    const baseUrl = window.location.origin;
    const params = new URLSearchParams();
    params.set('to', address);
    params.set('chain', network.id.toString());
    params.set('token', token.symbol);
    // Contract address is the source of truth on the send side — symbols are
    // not unique, so a counterfeit can share a symbol. The symbol stays for
    // readability and back-compat with links generated before this param.
    params.set('tokenAddress', token.address);

    if (requestedAmount) {
      params.set('amount', requestedAmount);
    }

    const link = `${baseUrl}/send?${params.toString()}`;
    this.generatedLink.set(link);

    // Deliberately parameterless: the link itself carries the recipient
    // address + amount, none of which may ever reach analytics.
    this.analytics.track('payment_link_created');

    this.toastService.success('Link generated', 'Your payment link is ready to share');
  }

  // Clipboard writes can be denied (permissions policy, insecure context) —
  // without the .catch the promise rejection was swallowed and the user saw
  // neither the success state nor any hint why nothing happened. Same error
  // idiom as the header's copy action.
  copyAddress(): void {
    const address = this.walletService.address();
    if (!address) return;

    navigator.clipboard.writeText(address).then(() => {
      this.copied.set(true);
      this.toastService.success('Copied', 'Address copied to clipboard');
      setTimeout(() => this.copied.set(false), 2000);
    }).catch(() => {
      this.toastService.error('Copy failed', 'Your browser blocked clipboard access. Copy the address manually.');
    });
  }

  copyPaymentLink(): void {
    const link = this.generatedLink();
    if (!link) return;

    navigator.clipboard.writeText(link).then(() => {
      this.linkCopied.set(true);
      this.toastService.success('Copied', 'Payment link copied to clipboard');
      setTimeout(() => this.linkCopied.set(false), 2000);
    }).catch(() => {
      this.toastService.error('Copy failed', 'Your browser blocked clipboard access. Copy the link manually.');
    });
  }

  shareLink(): void {
    const link = this.generatedLink();
    const token = this.selectedToken();
    if (!link) return;

    if (navigator.share) {
      navigator.share({
        title: 'Payment request',
        text: `Send me ${this.requestAmount || ''} ${token?.symbol || 'crypto'}`.trim(),
        url: link,
      }).catch(() => {
        this.copyPaymentLink();
      });
    } else {
      this.copyPaymentLink();
    }
  }

}
