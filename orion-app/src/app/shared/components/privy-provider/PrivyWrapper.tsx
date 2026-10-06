/**
 * =============================================================================
 * PRIVY REACT WRAPPER
 * =============================================================================
 *
 * This React component provides Privy wallet connection modal.
 * It's embedded in Angular using a wrapper component.
 *
 * Privy handles:
 * - Wallet selection UI (MetaMask, Coinbase, OKX, WalletConnect, etc.)
 * - Connection flow
 * - Account management
 *
 * @author Orion DEX Team
 * @version 2.6.0 — fiat on-ramp moved from `useAddFunds` to `useFiatOnramp`,
 *                  Privy's dedicated multi-provider card on-ramp (Stripe /
 *                  MoonPay / Meld / Coinbase routing, 50+ fiat currencies once
 *                  Meld is live). Its result status is now propagated up to
 *                  Angular — see FUNDING_DESTINATION and FiatOnrampStatus.
 *                  v2.5.0: 3.29 → 3.37 bump, re-verified against the new d.ts:
 *                  `useLogin`, `exportWallet` (on usePrivy), `showWalletUIs`
 *                  (embeddedWallets config), `WalletListEntry`,
 *                  `SUPPORTED_CHAINS` (re-exported as DEFAULT_SUPPORTED_CHAINS)
 *                  and `addRpcUrlOverrideToChain` all unchanged.
 *                  v2.4.1: 3.10 → 3.29 bump; WALLET_LIST typed as
 *                  WalletListEntry[].
 */

import React, { useEffect } from 'react';
import { PrivyProvider, usePrivy, useWallets, useLogin, useFiatOnramp, SUPPORTED_CHAINS, addRpcUrlOverrideToChain } from '@privy-io/react-auth';
import type { WalletListEntry } from '@privy-io/react-auth';
import { environment } from '../../../../environments/environment';
// Session classification lives in a React-free module so Karma specs can
// test it without pulling the Privy dependency tree into the webpack bundle.
import { SESSION_LOGIN_METHOD_KEY, getSessionLoginMethod } from './session-login';
// Module-level token channel — replaces the old window.__privyGetAccessToken
// global (window slots are writable by any script; the JWT getter is not).
import { registerAccessTokenGetter } from './privy-bridge';

/**
 * Privy's bundled chain registry (`@privy-io/chains`) hardcodes Avalanche
 * C-Chain's RPC to `https://api.avax.network/ext/bc/C/rpc` with no fallback
 * — that's what embedded wallets broadcast `eth_sendRawTransaction` to
 * unless overridden here. It has been observed rejecting valid transactions
 * with `InvalidInputRpcError` in production. `addRpcUrlOverrideToChain`
 * layers a `privyWalletOverride` RPC on top of Privy's default chain list
 * (`SUPPORTED_CHAINS`) without redefining every other chain, matching the
 * publicnode-first order already used for wallet_addEthereumChain and the
 * app's own JsonRpcProviders (see PUBLIC_RPCS in public-rpcs.constant.ts).
 */
const SUPPORTED_CHAINS_WITH_AVALANCHE_RPC_OVERRIDE = SUPPORTED_CHAINS.map(chain =>
  chain.id === 43114
    ? addRpcUrlOverrideToChain(chain, 'https://avalanche-c-chain-rpc.publicnode.com')
    : chain
);

// Wallet list configuration. Typed against the SDK's WalletListEntry union so
// a renamed/removed entry fails the build instead of silently dropping a
// wallet button from the login modal.
const WALLET_LIST: WalletListEntry[] = [
  'metamask',
  'coinbase_wallet',
  'okx_wallet',
  'detected_ethereum_wallets',
  'wallet_connect'
];

/**
 * Where the fiat on-ramp delivers the purchased funds.
 *
 * `useFiatOnramp` requires an explicit destination (address + CAIP-2 chain +
 * token). USDC on Base is the deliberate landing spot: it is a stablecoin
 * (no price surprise between purchase and arrival), Base has the cheapest
 * gas of our supported chains, and every provider Privy routes to supports
 * it — so the user can immediately swap it into anything else in the app.
 */
const FUNDING_DESTINATION = {
  /** CAIP-2 id for Base mainnet (chain 8453). */
  chain: 'eip155:8453',
  /** USDC on Base — same address the token catalogue ships (token.model.ts). */
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
} as const;

/**
 * How `useFiatOnramp` reports a completed flow. 'confirmed' means the user
 * sat through Privy's confirmation step; 'submitted' means the payment went
 * through at the provider but the user closed the modal before that step, so
 * the funds are on their way without a final ack. Declared locally rather
 * than imported from the SDK — Privy does not export the union — and
 * re-declared (not shared) on the Angular side, which keeps the React island
 * out of Karma's module graph the same way session-login.ts does.
 */
type FiatOnrampStatus = 'submitted' | 'confirmed';

/**
 * Privy's on-ramp providers run their own sandbox environments. Anything
 * that is not a production build funds through them in sandbox mode, so
 * local/preprod testing never touches a real card or real money. Derived
 * from envName rather than hardcoded — a hardcoded 'sandbox' would silently
 * ship a non-functional Buy page to production.
 */
/**
 * Local escape hatch for the sandbox's biggest limitation: sandbox mode routes
 * exclusively through Stripe's test environment, which only serves the US and
 * EU-by-IP — from anywhere else the flow dies at checkout, so the on-ramp is
 * untestable end-to-end. Setting `localStorage['orion.onramp.env'] =
 * 'production'` lets a dev opt a NON-production build into the live provider
 * routing (real card, real money — use the provider's minimum amount). It is
 * deliberately opt-in per browser: production stays production regardless, and
 * a plain dev session stays sandboxed so nobody moves real funds by accident.
 */
const FIAT_ONRAMP_ENVIRONMENT: 'production' | 'sandbox' =
  environment.envName === 'production' || localStorage.getItem('orion.onramp.env') === 'production'
    ? 'production'
    : 'sandbox';

/** How long to keep waiting for the session's wallet before failing selection */
const WALLET_RETRY_WINDOW_MS = 5000;

/**
 * How long a social session may sit with NO wallet at all before we treat
 * embedded-wallet creation as failed. Creation normally completes in 1-3 s;
 * this window is deliberately generous to survive slow networks.
 */
const WALLET_SETUP_WINDOW_MS = 20000;

/** Delay between wallet-availability re-checks inside the retry window */
const WALLET_RETRY_INTERVAL_MS = 500;

/**
 * Props for PrivyContent component
 */
interface PrivyContentProps {
  /**
   * `isEmbedded` flags a Privy embedded-wallet session (walletClientType
   * 'privy') — the Angular side gates the header's 'Export wallet' action on
   * it (export is meaningless for external wallets).
   *
   * `connectorType` is Privy's transport class ('injected', 'wallet_connect',
   * 'embedded', …) — analytics-only, mapped to a coarse allowlist on the
   * Angular side. Never the wallet's address or client name.
   */
  onConnect: (address: string, provider: any, isEmbedded: boolean, connectorType: string) => void;
  onDisconnect: () => void;
  onLoginCancelled: () => void;
  onWalletSelectionError: (message: string) => void;
  /**
   * Hands Privy's exportWallet up to Angular as a plain function — a callback
   * prop like onConnect, NOT a window global: the export flow reveals the
   * embedded wallet's private key, so it must only be reachable through code
   * that imports this component, never via a publicly writable window slot.
   */
  onExportWalletReady: (exportFn: () => Promise<void>) => void;
  /**
   * Hands Privy's funding flow up to Angular as a plain function — same
   * callback-prop contract as onExportWalletReady, NOT a window global: a
   * publicly writable slot that opens a payment modal is a phishing surface.
   * The caller only supplies the receiving address; chain/token/environment
   * are fixed here so no caller can redirect a purchase elsewhere.
   */
  onFundWalletReady: (fundFn: (address: string) => Promise<FiatOnrampStatus>) => void;
  triggerLogin: boolean;
  onLoginTriggered: () => void;
  onReady: (connected: boolean) => void;
}

/**
 * Inner component that uses Privy hooks
 * Must be inside PrivyProvider
 */
function PrivyContent({ onConnect, onDisconnect, onLoginCancelled, onWalletSelectionError, onExportWalletReady, onFundWalletReady, triggerLogin, onLoginTriggered, onReady }: PrivyContentProps) {
  const { logout, authenticated, ready, exportWallet, getAccessToken, user } = usePrivy();
  const { login } = useLogin({
    onComplete: ({ loginMethod }) => {
      // Capture the ACTUAL login method for later session restores — the
      // linkedAccounts heuristic in getSessionLoginMethod is only a fallback.
      // 'siwe'/'siws' are the wallet logins; every other method is social.
      if (loginMethod) {
        sessionStorage.setItem(
          SESSION_LOGIN_METHOD_KEY,
          loginMethod === 'siwe' || loginMethod === 'siws' ? 'wallet' : 'social'
        );
      }
    },
    onError: () => {
      onLoginCancelled();
    },
  });
  const { wallets } = useWallets();
  // Dedicated card on-ramp. `useFiatOnramp` (not `useAddFunds`, which opens
  // the general fiat-or-crypto funding menu, nor the deprecated
  // `useFundWallet`, which its own d.ts says "does not surface Stripe onramp
  // even when it is enabled") is Privy's multi-provider fiat flow: it routes
  // to Stripe / Meld / MoonPay / Coinbase by region and unlocks Meld's 50+
  // fiat currencies. Provider selection stays Privy's, not ours.
  const { fund } = useFiatOnramp();

  // Track if we've already connected to prevent loops
  const hasConnectedRef = React.useRef(false);
  const hasDisconnectedRef = React.useRef(true);
  // Deadlines (epoch ms) for waiting on the session's wallet. Time-budgeted,
  // not count-budgeted: wallets-store emissions during a slow WalletConnect
  // handshake would burn an attempt counter long before the intended window.
  // The 20 s no-wallet setup window and the 5 s session-wallet wait hold
  // SEPARATE refs: with a shared ref, a wallet session briefly misclassified
  // as social would inherit the 20 s window, and a social session whose
  // embedded wallet appears late would fail instantly against the
  // nearly-expired setup deadline. Each branch nulls the other's ref on
  // control transfer.
  const setupDeadlineRef = React.useRef<number | null>(null);
  const retryDeadlineRef = React.useRef<number | null>(null);
  // One-shot guard: a selection failure was already surfaced and logout is in
  // flight — blocks re-entry until `authenticated` actually flips false.
  const selectionFailedRef = React.useRef(false);
  // Pending re-check timer for the no-wallet-at-all branch. Held in a ref so
  // it can be cancelled the moment a wallet appears or the session ends —
  // the deadline must never fire after either event.
  const setupTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pending re-check timer for the session-wallet wait inside the selection
  // branch. Held in a ref so the effect cleanup can cancel it on unmount —
  // a stray timeout must not call setRetryTrigger on an unmounted component.
  const retryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // State to force re-render for retry mechanism
  const [retryTrigger, setRetryTrigger] = React.useState(0);

  // Handle login trigger from Angular
  useEffect(() => {
    if (triggerLogin && ready) {
      if (!authenticated) {
        login();
      } else {
        // Already authenticated (e.g. 'Setting up your wallet…' — session
        // restored but the wallet hasn't materialised yet): login() would be
        // a no-op, so without this branch the trigger is never consumed and
        // WalletService stays in 'connecting' forever. Reuse the cancelled-
        // login path to reset it; the setup/retry deadlines own surfacing
        // the real failure (toast + logout).
        onLoginCancelled();
      }
      onLoginTriggered();
    }
  }, [triggerLogin, ready, authenticated]); // Removed login, onLoginTriggered from deps

  // Handle wallet connection
  useEffect(() => {
    // Returned from EVERY exit path of this effect: a pending re-check timer
    // must never call setRetryTrigger on an unmounted component. Running it
    // between re-runs is harmless — both branches re-arm their timer, and the
    // deadline refs (not the timers) budget the total wait.
    const clearPendingTimers = (): void => {
      if (setupTimerRef.current !== null) {
        clearTimeout(setupTimerRef.current);
        setupTimerRef.current = null;
      }
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

    if (ready) onReady(authenticated);

    // Social login with NO wallet at all: embedded-wallet creation failed or
    // stalled. The selection branch below only runs once `wallets` is
    // non-empty, so without this deadline the user would sit in
    // WalletService's 'connecting' state forever with no error. Wallet
    // sessions are excluded — their missing external wallet is handled by
    // the retry window inside the selection branch.
    if (
      authenticated && ready && wallets.length === 0 &&
      !hasConnectedRef.current && !selectionFailedRef.current &&
      getSessionLoginMethod(user?.linkedAccounts || [], false) === 'social'
    ) {
      // Control moved here from the selection branch (wallets emptied
      // mid-handshake) — its 5 s deadline must not survive the transfer.
      retryDeadlineRef.current = null;
      if (setupDeadlineRef.current === null) {
        setupDeadlineRef.current = Date.now() + WALLET_SETUP_WINDOW_MS;
      }
      if (Date.now() < setupDeadlineRef.current) {
        if (setupTimerRef.current === null) {
          setupTimerRef.current = setTimeout(() => {
            setupTimerRef.current = null;
            if (!hasConnectedRef.current && authenticated) {
              setRetryTrigger(prev => prev + 1);
            }
          }, WALLET_RETRY_INTERVAL_MS);
        }
      } else {
        selectionFailedRef.current = true;
        onWalletSelectionError('Couldn\'t set up your wallet — please log in again.');
      }
      return clearPendingTimers;
    }

    if (authenticated && wallets.length > 0 && !hasConnectedRef.current) {
      // A wallet appeared — the no-wallet deadline re-check must not fire,
      // and the 20 s setup deadline must not leak into the 5 s wallet wait
      // below (a session briefly misclassified as social would otherwise
      // start this branch with a nearly-expired — or far too long — window).
      setupDeadlineRef.current = null;
      if (setupTimerRef.current !== null) {
        clearTimeout(setupTimerRef.current);
        setupTimerRef.current = null;
      }

      // A failure was already surfaced and logout is in flight — don't
      // re-enter retries or re-fire the error callback on effect re-runs
      // until Privy's async logout flips `authenticated`.
      if (selectionFailedRef.current) {
        return clearPendingTimers;
      }

      // External ⇔ anything that is not Privy's embedded wallet. WalletConnect
      // wallets report their own name as walletClientType ('trust', 'rainbow',
      // …) with connectorType 'wallet_connect', so a whitelist of known types
      // can never be complete.
      const externalWallet = wallets.find(w =>
        w.connectorType !== 'embedded' && w.walletClientType !== 'privy'
      );

      // Find Privy embedded wallet (for Google/email users)
      const embeddedWallet = wallets.find(w => w.walletClientType === 'privy');

      // Classify the session by its actual login method, not by which account
      // types happen to exist in linkedAccounts (see getSessionLoginMethod)
      const isWalletSession =
        getSessionLoginMethod(user?.linkedAccounts || [], !!externalWallet) === 'wallet';

      // Wait for the wallet matching this session's login method:
      // - social login → embedded wallet may not be created yet;
      // - wallet login → external wallet not yet injected. `createOnLogin:
      //   'all-users'` means `embeddedWallet` is *always* present by this
      //   point — without this wait the MetaMask/Coinbase user would be
      //   matched against Privy's embedded wallet (different address, lost
      //   allowances).
      const awaitedWalletMissing = isWalletSession ? !externalWallet : !embeddedWallet;
      if (awaitedWalletMissing) {
        if (retryDeadlineRef.current === null) {
          retryDeadlineRef.current = Date.now() + WALLET_RETRY_WINDOW_MS;
        }
        if (Date.now() < retryDeadlineRef.current) {
          if (retryTimerRef.current === null) {
            retryTimerRef.current = setTimeout(() => {
              retryTimerRef.current = null;
              if (!hasConnectedRef.current && authenticated) {
                setRetryTrigger(prev => prev + 1);
              }
            }, WALLET_RETRY_INTERVAL_MS);
          }
          return clearPendingTimers;
        }
        // Deadline expired — fall through to the failure path below.
      }

      // Wallet selection based on HOW this session was initiated:
      // - Social login (Google/email) → embedded wallet
      // - Wallet login → external wallet, NEVER the embedded one
      const selectedWallet = isWalletSession ? externalWallet : embeddedWallet;

      if (!selectedWallet) {
        // Retry window expired and the wallet matching this session's login
        // method never appeared (locked extension, failed WalletConnect
        // handshake, …). Do not substitute the embedded wallet — the user
        // would silently land on a different address with zero balance.
        // Surface the failure instead; the Angular side shows a toast and
        // runs the regular logout path so the user can retry cleanly.
        selectionFailedRef.current = true;
        onWalletSelectionError('Reconnect or log in again.');
        return clearPendingTimers;
      }

      hasConnectedRef.current = true;
      hasDisconnectedRef.current = false;
      retryDeadlineRef.current = null;

      // Get ethereum provider from wallet
      selectedWallet.getEthereumProvider().then((provider) => {
        onConnect(
          selectedWallet.address,
          provider,
          selectedWallet.walletClientType === 'privy',
          selectedWallet.connectorType,
        );
      }).catch((error) => {
        console.error('Error getting provider:', error);
        // Don't leave WalletService stuck in 'connecting' — surface the
        // failure. Reset hasConnectedRef so a fresh login can retry.
        hasConnectedRef.current = false;
        selectionFailedRef.current = true;
        onWalletSelectionError('Reconnect or log in again.');
      });
    }

    return clearPendingTimers;
  }, [authenticated, ready, wallets, retryTrigger, user]);

  // Handle disconnect
  useEffect(() => {
    if (!authenticated && ready) {
      // Logout (or session expiry) landed — re-arm wallet selection and drop
      // the stored login method so the next login starts clean.
      if (setupTimerRef.current !== null) {
        clearTimeout(setupTimerRef.current);
        setupTimerRef.current = null;
      }
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      setupDeadlineRef.current = null;
      retryDeadlineRef.current = null;
      selectionFailedRef.current = false;
      sessionStorage.removeItem(SESSION_LOGIN_METHOD_KEY);
      if (!hasDisconnectedRef.current) {
        hasDisconnectedRef.current = true;
        hasConnectedRef.current = false;
        onDisconnect();
      }
    }
  }, [authenticated, ready]); // Removed onDisconnect from deps

  // Expose the Angular-facing bridges. Logout stays a window global (its
  // consumer, WalletService.disconnect, predates the module bridge and the
  // queueing shim in privy-bridge.ts serves early calls); the token getter
  // and wallet export deliberately do NOT — see privy-bridge.ts and
  // onExportWalletReady's doc.
  useEffect(() => {
    (window as any).__privyLogout = () => {
      // Reset connection state so user can reconnect. selectionFailedRef is
      // intentionally NOT cleared here — it must keep blocking the selection
      // effect until the async logout actually flips `authenticated` (the
      // disconnect effect clears it).
      hasConnectedRef.current = false;
      hasDisconnectedRef.current = true;
      setupDeadlineRef.current = null;
      retryDeadlineRef.current = null;
      if (setupTimerRef.current !== null) {
        clearTimeout(setupTimerRef.current);
        setupTimerRef.current = null;
      }
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      logout();
    };
    // Hand the private-key export up through the callback prop. Privy shows
    // its own export modal; errors propagate so the Angular caller can toast.
    onExportWalletReady(async () => {
      await exportWallet();
    });
    // Hand the fiat on-ramp up through its own callback prop. The promise
    // REJECTS when the user simply closes the modal ('User exited flow' /
    // 'Payment method selection was cancelled'), so the Angular caller must
    // treat those messages as a cancel, not a failure; on success it resolves
    // with the flow status, which the /buy page turns into its toast.
    onFundWalletReady(async (address: string) => {
      const { status } = await fund({
        // `source` is required by the hook and dereferenced unconditionally
        // (`opts.source.assets`), so it cannot be omitted — but leaving
        // `assets` unset is the point: Privy then offers EVERY supported fiat
        // currency (all 50+ of Meld's included) and preselects the one
        // matching the user's locale. Pinning a list here would silently
        // exclude regions.
        source: {},
        destination: { address, ...FUNDING_DESTINATION },
        environment: FIAT_ONRAMP_ENVIRONMENT,
      });
      return status;
    });
    // Register the JWT getter on the module-level bridge channel. null on
    // error is the contract AuthService relies on (null = "no token").
    registerAccessTokenGetter(async () => {
      try {
        return await getAccessToken();
      } catch (error) {
        console.error('Error getting Privy access token:', error);
        return null;
      }
    });
    // onExportWalletReady / onFundWalletReady are intentionally NOT deps —
    // Angular re-binds them on every render, but each is always the same
    // component method underneath.
  }, [logout, exportWallet, getAccessToken, fund]);

  return null; // This component only handles logic, no UI
}

/**
 * Props for main PrivyWrapper component
 */
interface PrivyWrapperProps {
  onConnect: (address: string, provider: any, isEmbedded: boolean, connectorType: string) => void;
  onDisconnect: () => void;
  onLoginCancelled: () => void;
  onWalletSelectionError: (message: string) => void;
  onExportWalletReady: (exportFn: () => Promise<void>) => void;
  onFundWalletReady: (fundFn: (address: string) => Promise<FiatOnrampStatus>) => void;
  triggerLogin: boolean;
  onLoginTriggered: () => void;
  onReady: (connected: boolean) => void;
}

/**
 * Main Privy wrapper component
 * Provides PrivyProvider context and handles wallet events
 */
export function PrivyWrapper({ onConnect, onDisconnect, onLoginCancelled, onWalletSelectionError, onExportWalletReady, onFundWalletReady, triggerLogin, onLoginTriggered, onReady }: PrivyWrapperProps) {
  return (
    <PrivyProvider
      appId={environment.privyAppId}
      config={{
        appearance: {
          theme: 'dark',
          accentColor: '#0066E0', // --orion-accent (redesign token)
          // Self-hosted Orion Gate brand mark (public/ is served at the site
          // root) — never load third-party assets into the login modal.
          logo: '/logo_header.png',
          walletList: WALLET_LIST,
          showWalletLoginFirst: false, // Show email/Google first, wallet button below
        },
        loginMethods: ['email', 'google', 'wallet'],
        // Publicnode-first RPC for Avalanche C-Chain — see the constant's
        // doc comment above. Privy falls back to api.avax.network (still
        // present in the chain's rpcUrls) if the override is unreachable.
        supportedChains: SUPPORTED_CHAINS_WITH_AVALANCHE_RPC_OVERRIDE,
        // Create embedded wallets for all users - we select the right one based on login method
        embeddedWallets: {
          ethereum: {
            createOnLogin: 'all-users',
          },
          // SECURITY (public-test audit #18) — DO NOT REMOVE OR FLIP.
          // Pinned in code because this client value OVERRIDES the Privy
          // Dashboard toggle (per the @privy-io/react-auth d.ts, unchanged
          // through 3.29: "If not set, the default behavior will match the
          // server configuration").
          // With it off — silently, via a Dashboard change nobody reviews —
          // embedded-wallet users would sign transactions with NO confirmation
          // UI at all: any dApp-side bug could drain the wallet without the
          // user ever seeing a prompt. True guarantees Privy's own per-
          // signature confirmation modal for embedded wallets.
          showWalletUIs: true,
        },
      }}
    >
      <PrivyContent
        onConnect={onConnect}
        onDisconnect={onDisconnect}
        onLoginCancelled={onLoginCancelled}
        onWalletSelectionError={onWalletSelectionError}
        onExportWalletReady={onExportWalletReady}
        onFundWalletReady={onFundWalletReady}
        triggerLogin={triggerLogin}
        onLoginTriggered={onLoginTriggered}
        onReady={onReady}
      />
    </PrivyProvider>
  );
}

export default PrivyWrapper;

