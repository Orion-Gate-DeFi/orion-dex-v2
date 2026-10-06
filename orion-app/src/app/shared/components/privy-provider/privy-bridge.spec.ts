import {
  installPrivyBridgeShims,
  registerAccessTokenGetter,
  unregisterAccessTokenGetter,
  getAccessToken,
  PrivyBridgeShimState,
} from './privy-bridge';

describe('privy-bridge', () => {
  const w = window as unknown as Record<string, unknown>;
  let state: PrivyBridgeShimState;

  beforeEach(() => {
    state = { aborted: false };
    installPrivyBridgeShims(state);
  });

  afterEach(() => {
    // Mirror the component's ngOnDestroy cleanup so bridge state never leaks
    // between specs (a stray queued poll settles once `aborted` flips).
    state.aborted = true;
    unregisterAccessTokenGetter();
    delete w['__privyLogout'];
  });

  // ---------------------------------------------------------------------------
  // Window shim (__privyLogout only — token/export slots were removed)
  // ---------------------------------------------------------------------------

  describe('window shims', () => {
    it('installs only the __privyLogout slot — token/export globals must NOT exist', () => {
      expect(typeof w['__privyLogout']).toBe('function');
      // Regression guard for the window-global removal: reintroducing either
      // slot would reopen the writable-global attack surface.
      expect(w['__privyGetAccessToken']).toBeUndefined();
      expect(w['__privyExportWallet']).toBeUndefined();
    });

    it('queues a __privyLogout call until the real bridge lands, then delegates', async () => {
      const shim = w['__privyLogout'] as (...args: unknown[]) => Promise<unknown>;
      const pending = shim();

      // Simulate PrivyWrapper's effect overwriting the slot post-mount.
      const real = jasmine.createSpy('realLogout').and.returnValue('logged-out');
      w['__privyLogout'] = real;

      await expectAsync(pending).toBeResolvedTo('logged-out');
      expect(real).toHaveBeenCalled();
    });

    it('rejects __privyLogout when the mount is aborted', async () => {
      const shim = w['__privyLogout'] as () => Promise<unknown>;
      const pending = shim();

      state.aborted = true;

      await expectAsync(pending).toBeRejectedWithError(/__privyLogout is unavailable/);
    });
  });

  // ---------------------------------------------------------------------------
  // Module-level access-token channel
  // ---------------------------------------------------------------------------

  describe('access-token channel', () => {
    it('queues getAccessToken until a getter is registered, then delegates', async () => {
      const pending = getAccessToken();

      // Simulate PrivyWrapper registering post-mount.
      registerAccessTokenGetter(() => Promise.resolve('jwt-token'));

      await expectAsync(pending).toBeResolvedTo('jwt-token');
    });

    it('delegates immediately when a getter is already registered', async () => {
      const getter = jasmine.createSpy('getter').and.resolveTo('jwt-now');
      registerAccessTokenGetter(getter);

      await expectAsync(getAccessToken()).toBeResolvedTo('jwt-now');
      expect(getter).toHaveBeenCalled();
    });

    it('resolves null when the mount is aborted', async () => {
      const pending = getAccessToken();

      state.aborted = true;

      // Contract AuthService relies on: null, never a throw — null means
      // "no token", not a crash.
      await expectAsync(pending).toBeResolvedTo(null);
    });

    it('resolves null when the registered getter rejects', async () => {
      registerAccessTokenGetter(() => Promise.reject(new Error('privy down')));

      await expectAsync(getAccessToken()).toBeResolvedTo(null);
    });

    it('resolves null when the getter returns a non-string', async () => {
      registerAccessTokenGetter(() => Promise.resolve(null));

      await expectAsync(getAccessToken()).toBeResolvedTo(null);
    });

    it('returns the token VERBATIM — stripping is AuthService\'s job alone', async () => {
      // Privy occasionally wraps the JWT in quotes; the single strip point
      // lives in AuthService.getAccessTokenAsync. The bridge must not strip.
      registerAccessTokenGetter(() => Promise.resolve('"quoted-jwt"'));

      await expectAsync(getAccessToken()).toBeResolvedTo('"quoted-jwt"');
    });

    it('queues again after unregisterAccessTokenGetter, settling null on abort', async () => {
      registerAccessTokenGetter(() => Promise.resolve('jwt-token'));
      unregisterAccessTokenGetter();

      const pending = getAccessToken();
      state.aborted = true;

      await expectAsync(pending).toBeResolvedTo(null);
    });
  });
});
