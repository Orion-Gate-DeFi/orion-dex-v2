/**
 * =============================================================================
 * PRIVY BRIDGE
 * =============================================================================
 *
 * The React/Privy tree is mounted LAZILY (after first paint) to keep react,
 * react-dom and @privy-io out of the initial bundle, so consumers can run
 * before the real Privy implementations exist. This module is the queueing
 * layer between the two worlds.
 *
 * Two channels live here:
 *
 * 1. MODULE-LEVEL ACCESS-TOKEN CHANNEL (the only token channel — the old
 *    window.__privyGetAccessToken global was removed deliberately; window
 *    globals are writable by any script and the JWT getter is too sensitive
 *    to leave on a public slot). PrivyWrapper registers its getter via
 *    registerAccessTokenGetter() once mounted; getAccessToken() queues until
 *    that happens — up to BRIDGE_READY_TIMEOUT_MS — and resolves null on
 *    timeout/abort/getter-error (the contract AuthService relies on: null
 *    means "no token", never a throw).
 *
 * 2. WINDOW SHIM for __privyLogout ONLY. WalletService.disconnect() still
 *    calls the window global fire-and-forget (WalletService predates this
 *    module); __privyTriggerLogin is window-based for the same reason and is
 *    installed by PrivyProviderComponent directly. A call received before the
 *    mount waits (polling the slot) until PrivyWrapper overwrites it with the
 *    real implementation, then delegates. On abort/timeout it REJECTS so
 *    callers never believe a logout silently succeeded.
 *
 * React-free module (same pattern as session-login.ts) so Karma specs can
 * exercise the queueing logic without pulling React/Privy into the bundle.
 *
 * @author Orion DEX Team
 * @version 2.0.0 — access-token channel moved off window onto module level;
 *                  __privyExportWallet removed (export now flows through a
 *                  React callback prop into AuthService).
 */

export type PrivyBridgeName = '__privyLogout';

/** Shared mutable flag — the owning component aborts queued calls with it. */
export interface PrivyBridgeShimState {
  /** Flips true when the lazy mount failed or the component was destroyed. */
  aborted: boolean;
}

/** Outer bound for the lazy mount (idle delay + chunk load + React render). */
export const BRIDGE_READY_TIMEOUT_MS = 15_000;

/** How often a queued call re-checks whether the real bridge has landed. */
export const BRIDGE_POLL_INTERVAL_MS = 50;

type BridgeFn = (...args: unknown[]) => unknown;

/** Shape PrivyWrapper registers: wraps Privy's getAccessToken, returns null on error. */
export type AccessTokenGetter = () => Promise<string | null>;

const BRIDGE_NAMES: readonly PrivyBridgeName[] = ['__privyLogout'];

// =============================================================================
// MODULE STATE
// =============================================================================

/**
 * The getter PrivyWrapper registers post-mount. Module-level (not window) so
 * only code that imports this module can read or replace it.
 */
let accessTokenGetter: AccessTokenGetter | null = null;

/**
 * Abort state shared with the owning PrivyProviderComponent. Defaults to a
 * never-aborted state so a getAccessToken() call placed before the component
 * even initializes still queues against the full deadline.
 */
let bridgeState: PrivyBridgeShimState = { aborted: false };

// =============================================================================
// ACCESS-TOKEN CHANNEL
// =============================================================================

/** PrivyWrapper calls this from its effect once the React tree is mounted. */
export function registerAccessTokenGetter(getter: AccessTokenGetter): void {
  accessTokenGetter = getter;
}

/** PrivyProviderComponent calls this on destroy — nothing serves tokens now. */
export function unregisterAccessTokenGetter(): void {
  accessTokenGetter = null;
}

/**
 * Resolve the raw Privy JWT (or null). Queued-await semantics: a call placed
 * before PrivyWrapper registers its getter waits — polling every
 * BRIDGE_POLL_INTERVAL_MS, up to BRIDGE_READY_TIMEOUT_MS — and resolves null
 * on timeout, abort or getter error. Callers therefore need NO polling of
 * their own; a single await here can legitimately take the full deadline.
 *
 * NOTE: returns the token EXACTLY as Privy handed it over (possibly wrapped
 * in quotes). AuthService.getAccessTokenAsync is the single strip point —
 * never strip here, never strip downstream.
 */
export function getAccessToken(): Promise<string | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + BRIDGE_READY_TIMEOUT_MS;
    const check = (): void => {
      const getter = accessTokenGetter;
      if (getter) {
        // Belt-and-braces: the registered getter already catches internally,
        // but the null-on-error contract must hold even if a future getter
        // forgets to.
        getter().then(
          (token) => resolve(typeof token === 'string' ? token : null),
          () => resolve(null),
        );
        return;
      }
      if (bridgeState.aborted || Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(check, BRIDGE_POLL_INTERVAL_MS);
    };
    check();
  });
}

// =============================================================================
// WINDOW SHIMS (logout only)
// =============================================================================

/**
 * Install the queueing shim for the remaining window bridge slot and record
 * the abort state for the module-level channels. Must run BEFORE the lazy
 * React mount is scheduled so no consumer ever observes a missing slot.
 */
export function installPrivyBridgeShims(state: PrivyBridgeShimState): void {
  bridgeState = state;
  for (const name of BRIDGE_NAMES) {
    installShim(name, state);
  }
}

function installShim(name: PrivyBridgeName, state: PrivyBridgeShimState): void {
  const w = window as unknown as Record<string, unknown>;
  const shim = async (...args: unknown[]): Promise<unknown> => {
    const real = await waitForRealBridge(name, shim, state);
    if (!real) {
      throw new Error(`${name} is unavailable — Privy mount did not complete`);
    }
    return real(...args);
  };
  w[name] = shim;
}

/**
 * Resolve with the real bridge function once PrivyWrapper's effect replaces
 * the shim in its window slot; resolve null on abort or timeout.
 */
function waitForRealBridge(
  name: PrivyBridgeName,
  shim: BridgeFn,
  state: PrivyBridgeShimState,
): Promise<BridgeFn | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + BRIDGE_READY_TIMEOUT_MS;
    const check = (): void => {
      const current = (window as unknown as Record<string, unknown>)[name];
      if (typeof current === 'function' && current !== shim) {
        resolve(current as BridgeFn);
        return;
      }
      if (state.aborted || Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(check, BRIDGE_POLL_INTERVAL_MS);
    };
    check();
  });
}
