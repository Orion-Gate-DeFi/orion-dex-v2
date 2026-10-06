/**
 * =============================================================================
 * SESSION LOGIN CLASSIFICATION
 * =============================================================================
 *
 * Pure helpers shared by the Privy React bridge. Kept free of any
 * @privy-io/react-auth imports so Karma specs can exercise the logic without
 * dragging the React/wallet dependency tree into the webpack test bundle
 * (esbuild builds the app, but Karma's webpack chokes on import attributes
 * used deep inside that tree).
 */

/** SessionStorage key recording how the current session was initiated */
export const SESSION_LOGIN_METHOD_KEY = 'orion_session_login_method';

/** Minimal shape of a Privy linked account used for session classification */
export interface LinkedAccountLike {
  type: string;
  latestVerifiedAt?: Date | string | null;
  walletClientType?: string;
  connectorType?: string;
}

export type SessionLoginMethod = 'wallet' | 'social';

/**
 * Determine how the CURRENT session was initiated.
 *
 * The actual login method is captured at login time (useLogin's onComplete)
 * and persisted in sessionStorage — when present, that value is authoritative.
 *
 * Otherwise (session whose login predates the stored key, e.g. a fresh tab)
 * fall back to a heuristic: `linkedAccounts` accumulates every method the
 * user has ever linked, so checking for the mere existence of a
 * google_oauth/email account would force a MetaMask user who once linked an
 * email onto the embedded wallet forever. Privy stamps `latestVerifiedAt` on
 * each verification, so the most recently verified account approximates this
 * session's login method (it can still misclassify, e.g. a Google user whose
 * newest verification is a later-linked external wallet — hence the stored
 * key is preferred). The auto-created embedded wallet is itself a linked
 * 'wallet' account and says nothing about how the user logged in — it is
 * ignored. If no timestamps are available, fall back to: external wallet
 * connected → wallet session.
 */
export function getSessionLoginMethod(
  linkedAccounts: LinkedAccountLike[],
  hasExternalWallet: boolean
): SessionLoginMethod {
  const stored = sessionStorage.getItem(SESSION_LOGIN_METHOD_KEY);
  if (stored === 'wallet' || stored === 'social') {
    return stored;
  }
  const candidates = linkedAccounts.filter(
    (account) =>
      account.latestVerifiedAt &&
      !(account.type === 'wallet' &&
        (account.walletClientType === 'privy' || account.connectorType === 'embedded'))
  );
  if (candidates.length === 0) {
    return hasExternalWallet ? 'wallet' : 'social';
  }
  const latest = candidates.reduce((a, b) =>
    new Date(b.latestVerifiedAt!).getTime() > new Date(a.latestVerifiedAt!).getTime() ? b : a
  );
  return latest.type === 'wallet' ? 'wallet' : 'social';
}
