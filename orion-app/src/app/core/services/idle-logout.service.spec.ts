import { NgZone } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  IdleLogoutService,
  IDLE_TIMEOUT_MS,
  IDLE_CHECK_INTERVAL_MS,
  ACTIVITY_THROTTLE_MS,
  ACTIVITY_STORAGE_WRITE_INTERVAL_MS,
  IDLE_ACTIVITY_STORAGE_KEY,
  RECENT_BROADCAST_WINDOW_MS,
} from './idle-logout.service';
import { WalletService } from './wallet.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { TransactionHistoryService } from './transaction-history.service';

/** Minimal pending-record shape the guard reads (status filter is upstream). */
interface PendingStub {
  timestamp: number;
}

describe('IdleLogoutService', () => {
  let service: IdleLogoutService;
  let connected: boolean;
  let pending: PendingStub[];
  let walletSpy: jasmine.SpyObj<Pick<WalletService, 'disconnect'>> & { isConnected: () => boolean };
  let authSpy: jasmine.SpyObj<Pick<AuthService, 'logout'>>;
  let toastSpy: jasmine.SpyObj<Pick<ToastService, 'info'>>;
  let runOutsideAngularSpy: jasmine.Spy;
  let zoneRunSpy: jasmine.Spy;

  /** One full timeout plus a check tick — the earliest moment expiry can fire. */
  const PAST_DEADLINE_MS = IDLE_TIMEOUT_MS + IDLE_CHECK_INTERVAL_MS;

  beforeEach(() => {
    // mockDate well past epoch so throttle math (lastMarkAt = 0) behaves.
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(1_000_000_000_000));

    connected = true;
    pending = [];

    walletSpy = Object.assign(
      jasmine.createSpyObj<Pick<WalletService, 'disconnect'>>('WalletService', ['disconnect']),
      { isConnected: () => connected },
    );
    authSpy = jasmine.createSpyObj<Pick<AuthService, 'logout'>>('AuthService', ['logout']);
    toastSpy = jasmine.createSpyObj<Pick<ToastService, 'info'>>('ToastService', ['info']);
    const txStub = { pendingTransactions: () => pending };

    TestBed.configureTestingModule({
      providers: [
        { provide: WalletService, useValue: walletSpy },
        { provide: AuthService, useValue: authSpy },
        { provide: ToastService, useValue: toastSpy },
        { provide: TransactionHistoryService, useValue: txStub },
      ],
    });

    // Spies must land BEFORE start() registers listeners through the zone.
    const zone = TestBed.inject(NgZone);
    runOutsideAngularSpy = spyOn(zone, 'runOutsideAngular').and.callThrough();
    zoneRunSpy = spyOn(zone, 'run').and.callThrough();

    // A leftover shared timestamp from a previous spec must not leak in.
    localStorage.removeItem(IDLE_ACTIVITY_STORAGE_KEY);

    service = TestBed.inject(IdleLogoutService);
    service.start();
  });

  afterEach(() => {
    service.stop();
    localStorage.removeItem(IDLE_ACTIVITY_STORAGE_KEY);
    jasmine.clock().uninstall();
  });

  function expectLoggedOut(): void {
    expect(authSpy.logout).toHaveBeenCalled();
    expect(walletSpy.disconnect).toHaveBeenCalled();
    expect(toastSpy.info).toHaveBeenCalledWith('Session ended', 'Logged out after inactivity.');
  }

  function expectStillLoggedIn(): void {
    expect(authSpy.logout).not.toHaveBeenCalled();
    expect(walletSpy.disconnect).not.toHaveBeenCalled();
    expect(toastSpy.info).not.toHaveBeenCalled();
  }

  it('logs out via the existing path after 60 idle minutes', () => {
    jasmine.clock().tick(PAST_DEADLINE_MS);
    expectLoggedOut();
  });

  it('does not log out before the idle deadline', () => {
    jasmine.clock().tick(IDLE_TIMEOUT_MS - IDLE_CHECK_INTERVAL_MS);
    expectStillLoggedIn();
  });

  it('activity resets the idle clock', () => {
    jasmine.clock().tick(30 * 60 * 1000);
    document.dispatchEvent(new Event('pointerdown'));

    // 59 min after the activity (89 min after start) — still logged in.
    jasmine.clock().tick(59 * 60 * 1000);
    expectStillLoggedIn();

    // …and 60+ min after the activity the logout fires.
    jasmine.clock().tick(2 * IDLE_CHECK_INTERVAL_MS);
    expectLoggedOut();
  });

  it('throttles activity marks — a burst within the throttle window counts once', () => {
    jasmine.clock().tick(10 * 60 * 1000); // t = 10 min, mark counts
    document.dispatchEvent(new Event('pointermove'));
    // Inside the throttle window: must NOT slide the idle clock forward.
    jasmine.clock().tick(ACTIVITY_THROTTLE_MS - 1);
    document.dispatchEvent(new Event('pointermove'));

    // Ends just past the t = 70 min check tick: idle measured from the FIRST
    // mark is exactly IDLE_TIMEOUT_MS there → fires. Had the throttled event
    // counted, that tick would still be ~1 s short and the next check tick
    // lies beyond this budget — the expectation below would fail.
    jasmine.clock().tick(IDLE_TIMEOUT_MS + 1);
    expectLoggedOut();
  });

  it('never fires while disconnected', () => {
    connected = false;
    jasmine.clock().tick(3 * PAST_DEADLINE_MS);
    expectStillLoggedIn();
  });

  it('a recent pending (in-flight) transaction vetoes the logout', () => {
    jasmine.clock().tick(IDLE_TIMEOUT_MS - 60_000);
    // Broadcast lands just before the deadline (no user activity recorded —
    // e.g. confirmation happened in the wallet extension's own window).
    pending = [{ timestamp: Date.now() }];

    jasmine.clock().tick(2 * IDLE_CHECK_INTERVAL_MS);
    expectStillLoggedIn();
  });

  it('fires once the pending transaction guard clears', () => {
    jasmine.clock().tick(IDLE_TIMEOUT_MS - 60_000);
    pending = [{ timestamp: Date.now() }];
    jasmine.clock().tick(2 * IDLE_CHECK_INTERVAL_MS);
    expectStillLoggedIn();

    // Transaction confirms → no longer pending; next tick logs out.
    pending = [];
    jasmine.clock().tick(IDLE_CHECK_INTERVAL_MS);
    expectLoggedOut();
  });

  it('a STALE pending record does not pin the session open', () => {
    // Stuck cross-chain record broadcast long ago — outside the recency
    // window, so it must not block the idle logout.
    pending = [{ timestamp: Date.now() - RECENT_BROADCAST_WINDOW_MS - 1 }];

    jasmine.clock().tick(PAST_DEADLINE_MS);
    expectLoggedOut();
  });

  it('registered guards veto until unregistered', () => {
    let busy = true;
    const unregister = service.registerIdleGuard(() => busy);

    jasmine.clock().tick(PAST_DEADLINE_MS);
    expectStillLoggedIn();

    busy = false;
    jasmine.clock().tick(IDLE_CHECK_INTERVAL_MS);
    expectLoggedOut();

    unregister();
  });

  it('does not double-fire after a logout', () => {
    jasmine.clock().tick(PAST_DEADLINE_MS);
    expectLoggedOut();
    // Wallet state hasn't flipped yet (spies don't mutate `connected`) — the
    // post-fire activity reset must still prevent an immediate second round.
    jasmine.clock().tick(IDLE_CHECK_INTERVAL_MS);
    expect(authSpy.logout).toHaveBeenCalledTimes(1);
  });

  it('stop() removes listeners and the check timer', () => {
    service.stop();
    jasmine.clock().tick(3 * PAST_DEADLINE_MS);
    expectStillLoggedIn();
  });

  describe('zone discipline (activity listeners must not churn change detection)', () => {
    it('registers the presence listeners and the check timer outside the Angular zone', () => {
      // `expect(runOutsideAngularSpy).toHaveBeenCalled()` alone said nothing
      // about WHICH listeners landed there — dropping half the activity
      // events (or moving one inside the zone) kept it green. Re-register
      // with the DOM seams spied so the exact set is pinned.
      service.stop();
      const docAdd = spyOn(document, 'addEventListener').and.callThrough();
      const winAdd = spyOn(window, 'addEventListener').and.callThrough();
      runOutsideAngularSpy.calls.reset();

      service.start();

      expect(runOutsideAngularSpy).toHaveBeenCalledTimes(1);

      const docArgs = docAdd.calls.allArgs() as unknown as Array<[string, unknown, unknown?]>;
      expect(docArgs.map(([type]) => type)).toEqual([
        'pointerdown',
        'pointermove',
        'keydown',
        'wheel',
        'touchstart',
        'visibilitychange',
      ]);
      // The five presence events are the high-frequency ones: passive so
      // they never block scrolling, capture so a stopPropagation() anywhere
      // in the tree can't starve the idle clock and log the user out.
      for (const [, , options] of docArgs.slice(0, 5)) {
        expect(options).toEqual({ passive: true, capture: true });
      }

      // Cross-tab activity arrives on window, not document.
      const winArgs = winAdd.calls.allArgs() as unknown as Array<[string, unknown, unknown?]>;
      expect(winArgs.map(([type]) => type)).toEqual(['storage']);
    });

    it('re-enters the Angular zone only for the logout itself', () => {
      // Activity events and check ticks alone must never call zone.run —
      // a zone re-entry per pointermove would mean app-wide change
      // detection on every mouse move. This zero-churn half is the real
      // performance invariant and is asserted EXACTLY.
      document.dispatchEvent(new Event('pointermove'));
      jasmine.clock().tick(IDLE_CHECK_INTERVAL_MS);
      expect(zoneRunSpy).not.toHaveBeenCalled();

      jasmine.clock().tick(PAST_DEADLINE_MS);
      expectLoggedOut();
      // The logout itself must enter the zone (≥1). An exact ==1 proved
      // flaky: zone-testing's ProxyZone occasionally routes its own test
      // bookkeeping through NgZone.run on the same instance. The
      // single-logout invariant is pinned via the spies instead.
      expect(zoneRunSpy.calls.count()).toBeGreaterThanOrEqual(1);
      expect(authSpy.logout).toHaveBeenCalledTimes(1);
      expect(walletSpy.disconnect).toHaveBeenCalledTimes(1);
      expect(toastSpy.info).toHaveBeenCalledTimes(1);
    });
  });

  describe('multi-tab activity sharing', () => {
    it('fresh activity stored by another tab prevents the logout', () => {
      jasmine.clock().tick(30 * 60 * 1000);
      // No local activity — but another tab reports activity NOW through
      // the shared localStorage timestamp. ('storage' fires only in the
      // tabs that did NOT write, which is exactly this scenario.)
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: IDLE_ACTIVITY_STORAGE_KEY,
          newValue: String(Date.now()),
        }),
      );

      // 59 min after the other tab's activity (89 min after start) — a
      // per-tab timer would have logged this background tab out at 60 min.
      jasmine.clock().tick(59 * 60 * 1000);
      expectStillLoggedIn();

      // …and 60+ min after the OTHER tab's last activity it fires.
      jasmine.clock().tick(2 * IDLE_CHECK_INTERVAL_MS);
      expectLoggedOut();
    });

    it('ignores storage events for other keys and unparseable values', () => {
      jasmine.clock().tick(30 * 60 * 1000);
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'orion_settings', newValue: String(Date.now()) }),
      );
      window.dispatchEvent(
        new StorageEvent('storage', { key: IDLE_ACTIVITY_STORAGE_KEY, newValue: 'garbage' }),
      );

      // Neither event counts as activity: 60 min after start it fires.
      jasmine.clock().tick(31 * 60 * 1000);
      expectLoggedOut();
    });

    it('clamps a future cross-tab timestamp — a corrupted value cannot pin the session open', () => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: IDLE_ACTIVITY_STORAGE_KEY,
          newValue: String(Date.now() + 100 * 60 * 60 * 1000),
        }),
      );

      jasmine.clock().tick(PAST_DEADLINE_MS);
      expectLoggedOut();
    });

    it('publishes local activity for other tabs via a throttled localStorage write', () => {
      const t0 = Date.now();
      document.dispatchEvent(new Event('pointerdown'));
      expect(localStorage.getItem(IDLE_ACTIVITY_STORAGE_KEY)).toBe(String(t0));

      // Within the write-throttle window the mark still counts in-memory,
      // but no further (synchronous) localStorage write goes out.
      jasmine.clock().tick(ACTIVITY_STORAGE_WRITE_INTERVAL_MS - 1000);
      document.dispatchEvent(new Event('pointerdown'));
      expect(localStorage.getItem(IDLE_ACTIVITY_STORAGE_KEY)).toBe(String(t0));

      // Past the throttle window the next mark writes through again.
      jasmine.clock().tick(2000);
      document.dispatchEvent(new Event('pointerdown'));
      expect(localStorage.getItem(IDLE_ACTIVITY_STORAGE_KEY)).toBe(String(Date.now()));
    });
  });
});
