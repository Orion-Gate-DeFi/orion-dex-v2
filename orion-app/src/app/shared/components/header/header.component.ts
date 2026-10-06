/**
 * Header Component
 * Main navigation header with wallet connection
 */
import { Component, ChangeDetectionStrategy, ElementRef, Injector, afterNextRender, inject, signal, computed, viewChild, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, IsActiveMatchOptions } from '@angular/router';
import { WalletService } from '../../../core/services/wallet.service';
import { AuthService } from '../../../core/services/auth.service';
import { ToastService } from '../../../core/services/toast.service';
import { NETWORKS, NetworkInfo } from '../../../core/constants/networks.constant';

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './header.component.html',
  // Safe for OnPush: every template binding reads signals (own or
  // WalletService's), so change notification is fully signal-driven.
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HeaderComponent {
  walletService = inject(WalletService);
  private authService = inject(AuthService);
  private toastService = inject(ToastService);
  private readonly injector = inject(Injector);
  isMenuOpen = signal(false);

  /**
   * Home ("/") active-match: path must match exactly (so it never lights up
   * on /swap etc.), but query params and fragment are ignored. Redirect-based
   * Privy social logins land back on `/?privy_oauth_code=…`; the router's
   * NavigationEnd carries those params, and Privy's later replaceState cleanup
   * fires no navigation event — so a queryParams-exact match ({ exact: true })
   * would leave Home un-highlighted for the whole post-login session.
   */
  readonly homeActiveOptions: IsActiveMatchOptions = {
    paths: 'exact',
    queryParams: 'ignored',
    matrixParams: 'ignored',
    fragment: 'ignored',
  };

  /**
   * Export-wallet visibility: embedded-wallet sessions only (Privy custodies
   * the key — external wallets export from their own UI, not ours).
   */
  readonly isEmbeddedWallet = this.authService.isEmbeddedSession;

  /**
   * In-menu confirm step for the private-key reveal — the menu swaps the
   * 'Export wallet' row for a warning + Reveal/Cancel pair, so a stray click
   * can't open the key modal directly.
   */
  readonly isExportConfirmOpen = signal(false);

  /** Account-menu trigger — focus returns here when the menu closes via
   *  Escape or a menu action, instead of silently dropping to <body>. */
  private readonly menuTrigger = viewChild<ElementRef<HTMLButtonElement>>('menuTrigger');

  /** Connect button — the focus target after disconnect destroys the whole
   *  connected-state UI, menu trigger included. */
  private readonly connectButton = viewChild<ElementRef<HTMLButtonElement>>('connectBtn');

  currentNetwork = computed<NetworkInfo | null>(() => {
    const id = this.walletService.chainId();
    return NETWORKS.find((n) => n.id === id) || null;
  });

  /**
   * Wallet is connected but on a chain we don't support — without this the
   * network chip silently disappears and the user has no idea why quotes
   * fail. Render an explicit "Unsupported network" chip instead.
   */
  readonly isUnsupportedNetwork = computed(() =>
    this.walletService.isConnected() &&
    !!this.walletService.chainId() &&
    !this.currentNetwork()
  );

  /**
   * Native-token ticker for the connected chain. The account menu used to
   * hardcode 'ETH', mislabeling the POL/MATIC balance on Polygon. Empty
   * string on unsupported chains — no ticker beats a wrong one.
   */
  readonly nativeSymbol = computed<string>(() =>
    this.walletService.currentChain()?.nativeToken.symbol ?? ''
  );

  @HostListener('document:click')
  onDocumentClick(): void {
    // The trigger button stops propagation, so any click that reaches the
    // document is by definition "outside" — close the menu.
    if (this.isMenuOpen()) {
      this.closeMenu();
    }
  }

  @HostListener('document:keydown.escape', ['$event'])
  onEscape(event: KeyboardEvent): void {
    // Keyboard users had no way to dismiss the menu short of activating an
    // item; closing must also restore focus, or it falls to <body>.
    if (this.isMenuOpen()) {
      this.closeMenu();
      this.menuTrigger()?.nativeElement.focus();
      // One Escape = one layer: consume the event so a popover open at the
      // same time (e.g. swap settings, whose document listener registers
      // after this app-shell one) doesn't close in the same keystroke.
      // Only when we actually closed something — otherwise let it through.
      event.stopImmediatePropagation();
    }
  }

  toggleMenu(event: Event): void {
    event.stopPropagation();
    if (this.isMenuOpen()) {
      this.closeMenu();
    } else {
      this.isMenuOpen.set(true);
    }
  }

  onConnect(): void {
    this.walletService.connect();
  }

  async onCopyAddress(event: Event): Promise<void> {
    event.stopPropagation();
    const address = this.walletService.address();
    if (address) {
      try {
        await navigator.clipboard.writeText(address);
        this.toastService.success('Address copied', `${address.slice(0, 6)}…${address.slice(-4)} is in your clipboard.`);
      } catch {
        this.toastService.error('Copy failed', 'Your browser blocked clipboard access. Copy the address manually.');
      }
    }
    this.closeMenu();
    // The activated menu item is destroyed with the menu — without this,
    // keyboard focus silently drops to <body>.
    this.menuTrigger()?.nativeElement.focus();
  }

  /** Step 1: swap the menu row for the in-menu confirm block. */
  onExportWallet(event: Event): void {
    event.stopPropagation();
    this.isExportConfirmOpen.set(true);
  }

  onExportCancel(event: Event): void {
    event.stopPropagation();
    this.isExportConfirmOpen.set(false);
  }

  /**
   * Step 2: user confirmed the reveal — close our menu and hand off to
   * Privy's export modal (the key itself renders only inside Privy's iframe).
   */
  async onExportConfirm(event: Event): Promise<void> {
    event.stopPropagation();
    this.closeMenu();
    this.menuTrigger()?.nativeElement.focus();
    try {
      await this.authService.exportWallet();
    } catch {
      // Covers both "Privy not mounted yet" and a Privy-side rejection.
      this.toastService.error(
        'Export unavailable',
        'Couldn\'t open the wallet export. Please try again in a moment.'
      );
    }
  }

  onDisconnect(event: Event): void {
    event.stopPropagation();
    this.authService.logout();
    this.walletService.disconnect();
    this.closeMenu();
    // Disconnect tears down the menu AND its trigger (the whole connected
    // branch), so focus can't return to the trigger like the other menu
    // actions — park it on the Connect button once that branch renders.
    afterNextRender(() => this.connectButton()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  /** Closing the menu must also discard a half-finished export confirm. */
  private closeMenu(): void {
    this.isMenuOpen.set(false);
    this.isExportConfirmOpen.set(false);
  }
}
