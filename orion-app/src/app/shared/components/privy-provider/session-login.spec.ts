/**
 * =============================================================================
 * PRIVY WRAPPER — SESSION CLASSIFICATION TESTS
 * =============================================================================
 *
 * Covers getSessionLoginMethod: the sessionStorage value captured at login
 * time (useLogin onComplete) must win over the latestVerifiedAt heuristic,
 * which is only a fallback for sessions whose login predates the stored key.
 */

// Type-only import — fully erased at compile time, so the Privy/React tree
// still never enters the Karma webpack bundle (the reason session-login.ts
// exists as a React-free module in the first place).
import type { LinkedAccountWithMetadata } from '@privy-io/react-auth';
import { getSessionLoginMethod } from './session-login';
import type { LinkedAccountLike } from './session-login';

const SESSION_LOGIN_METHOD_KEY = 'orion_session_login_method';

interface TestLinkedAccount {
  type: string;
  latestVerifiedAt?: Date | string | null;
  walletClientType?: string;
  connectorType?: string;
}

describe('getSessionLoginMethod', () => {
  beforeEach(() => {
    sessionStorage.removeItem(SESSION_LOGIN_METHOD_KEY);
  });

  afterEach(() => {
    sessionStorage.removeItem(SESSION_LOGIN_METHOD_KEY);
  });

  // Google login, external wallet linked LATER → wallet account is the
  // newest verification on refresh. The heuristic alone would misclassify.
  const googleThenWalletAccounts: TestLinkedAccount[] = [
    { type: 'google_oauth', latestVerifiedAt: '2026-06-10T10:00:00Z' },
    { type: 'wallet', latestVerifiedAt: '2026-06-11T09:00:00Z', walletClientType: 'metamask', connectorType: 'injected' },
    { type: 'wallet', latestVerifiedAt: '2026-06-10T10:00:05Z', walletClientType: 'privy', connectorType: 'embedded' },
  ];

  it('prefers the stored login method over the latestVerifiedAt heuristic', () => {
    sessionStorage.setItem(SESSION_LOGIN_METHOD_KEY, 'social');
    expect(getSessionLoginMethod(googleThenWalletAccounts, true)).toBe('social');

    sessionStorage.setItem(SESSION_LOGIN_METHOD_KEY, 'wallet');
    expect(getSessionLoginMethod([{ type: 'google_oauth', latestVerifiedAt: '2026-06-11T09:00:00Z' }], true)).toBe('wallet');
  });

  it('ignores an unrecognized stored value and falls back to the heuristic', () => {
    sessionStorage.setItem(SESSION_LOGIN_METHOD_KEY, 'garbage');
    expect(getSessionLoginMethod(googleThenWalletAccounts, true)).toBe('wallet');
  });

  it('falls back to the most recently verified account when no value is stored', () => {
    expect(getSessionLoginMethod(googleThenWalletAccounts, true)).toBe('wallet');
    expect(
      getSessionLoginMethod(
        [
          { type: 'wallet', latestVerifiedAt: '2026-06-10T10:00:00Z', walletClientType: 'metamask', connectorType: 'injected' },
          { type: 'google_oauth', latestVerifiedAt: '2026-06-11T09:00:00Z' },
        ],
        true
      )
    ).toBe('social');
  });

  it('ignores the auto-created embedded wallet in the fallback heuristic', () => {
    const accounts: TestLinkedAccount[] = [
      { type: 'google_oauth', latestVerifiedAt: '2026-06-10T10:00:00Z' },
      { type: 'wallet', latestVerifiedAt: '2026-06-11T09:00:00Z', walletClientType: 'privy', connectorType: 'embedded' },
    ];
    expect(getSessionLoginMethod(accounts, false)).toBe('social');
  });

  it('uses external wallet presence when no timestamps are available', () => {
    const accounts: TestLinkedAccount[] = [{ type: 'wallet', walletClientType: 'metamask' }];
    expect(getSessionLoginMethod(accounts, true)).toBe('wallet');
    expect(getSessionLoginMethod(accounts, false)).toBe('social');
  });

  // session-login.ts keeps a deliberate structural COPY of the SDK's
  // linked-account shape; PrivyWrapper feeds the real SDK type straight into
  // getSessionLoginMethod. This compile-time check turns an SDK shape change
  // (e.g. a future @privy-io/react-auth bump renaming latestVerifiedAt) into
  // a build error instead of a silent session misclassification. The tuple
  // wrapper keeps the conditional non-distributive so EVERY union member
  // must remain assignable, not just one.
  it('stays structurally compatible with the SDK linked-account type', () => {
    const sdkShapeCompatible: [LinkedAccountWithMetadata] extends [LinkedAccountLike]
      ? true
      : never = true;
    expect(sdkShapeCompatible).toBeTrue();
  });
});
