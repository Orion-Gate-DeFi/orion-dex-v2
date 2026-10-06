/**
 * =============================================================================
 * PRIVY PROVIDER ANGULAR COMPONENT
 * =============================================================================
 *
 * Angular wrapper for React Privy component.
 * Renders React component inside Angular and handles communication.
 *
 * The React tree (react, react-dom, PrivyWrapper → @privy-io/react-auth and
 * its wallet SDKs, ~2 MB minified) is imported DYNAMICALLY after first paint
 * so none of it lands in the initial bundle. Early consumers are served by
 * the queueing bridge — see privy-bridge.ts (module-level token channel +
 * window shim for __privyLogout). onReady/auto-reconnect simply starts a few
 * hundred ms later than with the old eager mount.
 *
 * Also the session owner: starts IdleLogoutService and relays the embedded-
 * wallet flag / export function from the React side into AuthService.
 *
 * @author Orion DEX Team
 * @version 2.3.1 — the relayed fiat on-ramp now returns a FundingStatus
 *                  (useFiatOnramp migration). v2.3.0: fiat on-ramp relayed to
 *                  WalletService (callback prop, same contract as wallet
 *                  export). v2.2.0: token/export window globals removed; idle
 *                  logout wired.
 */

import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  afterNextRender,
  inject,
  signal,
  effect,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import type { Root } from 'react-dom/client';
import { WalletService } from '../../../core/services/wallet.service';
import type { FundingStatus } from '../../../core/services/wallet.service';
import { AuthService } from '../../../core/services/auth.service';
import { ToastService } from '../../../core/services/toast.service';
import { IdleLogoutService } from '../../../core/services/idle-logout.service';
import { AnalyticsService } from '../../../core/services/analytics.service';
import {
  installPrivyBridgeShims,
  unregisterAccessTokenGetter,
  PrivyBridgeShimState,
} from './privy-bridge';

/** LocalStorage key for the address at last connect (mid-session account switches intentionally not tracked) */
const LAST_ACTIVE_ADDRESS_KEY = 'orion_last_active_address';

@Component({
  selector: 'app-privy-provider',
  standalone: true,
  imports: [CommonModule],
  template: `
    <!-- React mount point -->
    <div #privyContainer></div>
  `
})
export class PrivyProviderComponent implements OnInit, OnDestroy {
  @ViewChild('privyContainer', { static: true }) containerRef!: ElementRef;

  private walletService = inject(WalletService);
  private authService = inject(AuthService);
  private toastService = inject(ToastService);
  private idleLogoutService = inject(IdleLogoutService);
  private analytics = inject(AnalyticsService);

  /** React root — created only after the lazy chunk resolves. */
  private root: Root | null = null;

  /** Lazily imported modules; null until the deferred mount completes. */
  private reactModule: typeof import('react') | null = null;
  private privyWrapper: typeof import('./PrivyWrapper').PrivyWrapper | null = null;

  /** Shared with the bridge shims: aborts queued calls on destroy/failure. */
  private shimState: PrivyBridgeShimState = { aborted: false };

  /** True once ngOnDestroy ran — a late-resolving import must not mount. */
  private destroyed = false;

  /** Handles for the idle-time mount scheduling (cancelled on destroy). */
  private idleHandle: number | null = null;
  private idleFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  // Signal to trigger login from Angular
  private triggerLogin = signal(false);

  // Flag: user clicked Connect button (not auto-restore)
  private userInitiatedLogin = false;

  constructor() {
    // Re-render React when triggerLogin changes (must propagate both true AND
    // false). No-ops until the lazy mount completes; the signal is re-read on
    // the post-mount render, so a Connect click that lands before the mount
    // is not lost — it queues in the signal.
    effect(() => {
      this.triggerLogin(); // subscribe to signal
      this.renderReact();
    });

    // Defer the React/Privy mount past first paint: react/react-dom/@privy-io
    // stay out of the initial bundle and load once the main thread goes idle
    // (or after the ~200 ms ceiling, whichever comes first).
    afterNextRender(() => this.scheduleLazyMount());
  }

  ngOnInit(): void {
    // The bridge must be armed EARLY — WalletService fires __privyLogout
    // without awaiting and AuthService awaits the module-level token channel.
    // installPrivyBridgeShims installs the __privyLogout queueing shim AND
    // hands the bridge our abort state so queued token calls settle on
    // destroy/mount-failure.
    installPrivyBridgeShims(this.shimState);

    // Expose login trigger globally for WalletService to call
    (window as any).__privyTriggerLogin = () => {
      this.userInitiatedLogin = true;
      this.triggerLogin.set(true);
    };

    // Session hygiene: 60-min inactivity logout (see IdleLogoutService).
    // Started here because this component owns the session lifecycle and is
    // mounted exactly once in the app shell.
    this.idleLogoutService.start();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    // Settle queued bridge calls — nothing will ever serve them now.
    this.shimState.aborted = true;

    // Cancel a not-yet-started mount (destroy can beat the idle callback).
    if (this.idleHandle !== null && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(this.idleHandle);
      this.idleHandle = null;
    }
    if (this.idleFallbackTimer !== null) {
      clearTimeout(this.idleFallbackTimer);
      this.idleFallbackTimer = null;
    }

    // Cleanup React component (root exists only if the mount completed; a
    // destroy that wins the race against the import is handled by the
    // `destroyed` guard in mountReactComponent).
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }

    // Cleanup global functions and module-bridge registrations — nothing
    // serves tokens or exports once the React tree is gone.
    delete (window as any).__privyTriggerLogin;
    delete (window as any).__privyLogout;
    unregisterAccessTokenGetter();
    this.authService.registerWalletExport(null);
    this.walletService.registerWalletFunding(null);
    this.idleLogoutService.stop();
  }

  /**
   * Schedule the deferred mount: idle callback with a 200 ms ceiling, plain
   * 200 ms timeout where requestIdleCallback is unavailable (Safari).
   */
  private scheduleLazyMount(): void {
    const start = (): void => {
      this.idleHandle = null;
      this.idleFallbackTimer = null;
      void this.mountReactComponent();
    };
    if (typeof window.requestIdleCallback === 'function') {
      this.idleHandle = window.requestIdleCallback(start, { timeout: 200 });
    } else {
      this.idleFallbackTimer = setTimeout(start, 200);
    }
  }

  /**
   * Lazily import React + PrivyWrapper, then mount into the Angular DOM.
   * The dynamic import() calls are the point of this design — a static
   * import would drag the entire Privy/React dependency tree back into the
   * initial chunk.
   */
  private async mountReactComponent(): Promise<void> {
    try {
      const [reactModule, reactDomClient, wrapperModule] = await Promise.all([
        import('react'),
        import('react-dom/client'),
        import('./PrivyWrapper'),
      ]);
      // Destroy raced the import — do not mount into a dead view.
      if (this.destroyed) return;

      // CJS↔ESM interop: in the optimized prod bundle a dynamic import() of a
      // CommonJS module (react / react-dom/client) can expose the API under
      // `.default` instead of on the namespace — so `reactDomClient.createRoot`
      // is undefined and mounting throws "createRoot is not a function" (works
      // in dev, breaks in prod). Pick whichever shape actually carries the API.
      const reactNs = ((reactModule as any).createElement
        ? reactModule
        : (reactModule as any).default) as typeof reactModule;
      const reactDomNs = (reactDomClient as any).createRoot
        ? reactDomClient
        : (reactDomClient as any).default;

      this.reactModule = reactNs;
      this.privyWrapper = wrapperModule.PrivyWrapper;
      this.root = reactDomNs.createRoot(this.containerRef.nativeElement);
      this.renderReact();
    } catch (error) {
      // Chunk load failed (offline / deploy race). Abort queued bridge calls
      // and drop the trigger so WalletService.connect() falls back to its
      // direct-connection path instead of spinning forever.
      this.shimState.aborted = true;
      delete (window as any).__privyTriggerLogin;
      this.walletService.cancelConnecting();
      console.error('Failed to load Privy/React bundle:', error);
    }
  }

  /**
   * Render React component with current props
   */
  private renderReact(): void {
    if (!this.root || !this.reactModule || !this.privyWrapper) return;

    const element = this.reactModule.createElement(this.privyWrapper, {
      onConnect: this.handleConnect.bind(this),
      onDisconnect: this.handleDisconnect.bind(this),
      onLoginCancelled: this.handleLoginCancelled.bind(this),
      onWalletSelectionError: this.handleWalletSelectionError.bind(this),
      onExportWalletReady: this.handleExportWalletReady.bind(this),
      onFundWalletReady: this.handleFundWalletReady.bind(this),
      triggerLogin: this.triggerLogin(),
      onLoginTriggered: () => this.triggerLogin.set(false),
      onReady: this.handleReady.bind(this),
    });

    this.root.render(element);
  }

  /**
   * Handle wallet connection from Privy
   * @param address - Connected wallet address
   * @param provider - Ethereum provider from wallet
   * @param isEmbedded - True for Privy's embedded wallet (social/email login)
   * @param connectorType - Privy transport class, analytics-only (see below)
   */
  private async handleConnect(address: string, provider: any, isEmbedded: boolean, connectorType: string): Promise<void> {
    // Warn when the connected address differs from the previous session's —
    // a silently different address looks like "missing" balances to the user.
    const lastAddress = localStorage.getItem(LAST_ACTIVE_ADDRESS_KEY);
    if (lastAddress && lastAddress.toLowerCase() !== address.toLowerCase()) {
      const short = `${address.slice(0, 6)}...${address.slice(-4)}`;
      this.toastService.warning(
        'Different address',
        `Connected as ${short} — a different address than your last session.`
      );
    }
    localStorage.setItem(LAST_ACTIVE_ADDRESS_KEY, address);

    // Classify the session BEFORE the connected state lands, so the header
    // never renders a connected menu with a stale embedded flag.
    this.authService.setEmbeddedSession(isEmbedded);

    await this.walletService.connectWithProvider(address, provider);

    // Coarse connector class only — a fixed allowlist, so an exotic wallet's
    // client name (or anything else Privy adds later) can never leak into
    // analytics. The address NEVER goes near this event.
    this.analytics.track('wallet_connected', {
      connector: isEmbedded ? 'embedded'
        : connectorType === 'injected' ? 'injected'
        : connectorType === 'wallet_connect' ? 'walletconnect'
        : 'other',
    });

    // Only authenticate if user clicked Connect button
    if (!this.userInitiatedLogin) {
      return;
    }

    // Reset flag
    this.userInitiatedLogin = false;

    // Authenticate with backend API to get JWT token
    try {
      const authenticated = await this.authService.authenticate();
    } catch (error) {
      console.error('API authentication error:', error);
    }
  }

  /**
   * Handle wallet disconnection from Privy
   */
  private handleDisconnect(): void {
    this.userInitiatedLogin = false;
    this.authService.logout();
    this.walletService.disconnect();
  }

  /**
   * User dismissed the Privy modal without logging in — OR clicked Connect
   * while a restored session was still waiting for its wallet (login() is a
   * no-op when already authenticated, so the React side routes that click
   * here too). Either way: stop showing 'connecting', no error toast.
   */
  private handleLoginCancelled(): void {
    this.userInitiatedLogin = false;
    this.walletService.cancelConnecting();
  }

  /**
   * Wallet selection failed on the React side (the wallet matching the
   * session's login method never appeared within the retry window). Tell the
   * user explicitly and run the regular logout path so they can retry cleanly
   * — never leave them silently on the embedded wallet.
   */
  private handleWalletSelectionError(message: string): void {
    this.userInitiatedLogin = false;
    this.toastService.error('Couldn\'t connect to your wallet', message);
    this.authService.logout();
    this.walletService.disconnect();
  }

  /**
   * React handed up Privy's exportWallet (private-key reveal). Relay it into
   * AuthService where the header's 'Export wallet' action invokes it — a
   * callback-prop chain end to end, never a window global.
   */
  private handleExportWalletReady(exportFn: () => Promise<void>): void {
    this.authService.registerWalletExport(exportFn);
  }

  /**
   * React handed up Privy's funding flow (fiat on-ramp). Relay it into
   * WalletService where the /buy page invokes it — a callback-prop chain end
   * to end, never a window global. The resolved FundingStatus rides along so
   * the page can tell a confirmed purchase from a still-settling one.
   */
  private handleFundWalletReady(fundFn: (address: string) => Promise<FundingStatus>): void {
    this.walletService.registerWalletFunding(fundFn);
  }

  private handleReady(isConnected: boolean): void {
    this.walletService.setConnectedStatus(isConnected);
  }
}

