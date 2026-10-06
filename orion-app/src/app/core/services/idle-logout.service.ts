/**
 * =============================================================================
 * IDLE LOGOUT SERVICE
 * =============================================================================
 *
 * Logs the user out after 60 minutes without interaction (owner decision,
 * public-test audit follow-up): an abandoned browser session must not keep a
 * live Privy session — and with it the embedded wallet — signable forever.
 *
 * Mechanics:
 * - Document-level activity listeners (pointer / key / wheel / touch) in the
 *   CAPTURE phase, so a component's stopPropagation can't hide activity.
 *   Marking is throttled to once per ACTIVITY_THROTTLE_MS — pointermove can
 *   fire hundreds of times per second.
 * - All listeners and the check interval are registered OUTSIDE the Angular
 *   zone: a zone-registered pointermove handler would trigger app-wide
 *   change detection on every mouse move. Only the actual logout re-enters
 *   the zone (one deliberate CD pass for the signal writes + toast).
 * - A coarse interval re-checks idleness every IDLE_CHECK_INTERVAL_MS instead
 *   of re-arming a 60-min timeout per event: cheaper, and immune to browsers
 *   deferring long timers in background tabs. On visibilitychange→visible an
 *   immediate check runs, because that same background throttling can delay
 *   interval ticks while the tab is hidden — returning to a long-abandoned
 *   tab must land on the logged-out state, not on a live session.
 * - Multi-tab: activity is shared via localStorage so a background tab does
 *   not log the user out while they work in another tab. markActivity
 *   persists a throttled timestamp (at most one write per
 *   ACTIVITY_STORAGE_WRITE_INTERVAL_MS); other tabs mirror it cheaply
 *   through the 'storage' event, and checkIdle compares against
 *   max(in-memory, cross-tab). Stored values are clamped to "now" so a
 *   corrupted future timestamp can't pin a session open forever. Nothing is
 *   written at logout time: the shared timestamp is then idle-stale in every
 *   tab, so all tabs converge on the logged-out state on their next tick.
 * - Expiry runs the EXISTING logout path (AuthService.logout +
 *   WalletService.disconnect — the same pair the header's Disconnect uses;
 *   disconnect() also fires the Privy logout bridge) and shows a toast.
 *
 * In-flight transaction guard — never log out mid-transaction:
 * SwapExecutionService reports signing/pending/confirming only through
 * per-call onStatusChange callbacks (no service-level signal), and modifying
 * the swap/send components for a registration hook is out of scope. The
 * chosen guard instead reads TransactionHistoryService.pendingTransactions():
 * a record is written at broadcast and flips off 'pending' on confirmation,
 * so the broadcast→confirmation window is covered. The recency cap
 * (RECENT_BROADCAST_WINDOW_MS) exists because stuck cross-chain records can
 * sit 'pending' for days — a stale record must not pin the session open
 * forever. The pre-broadcast 'signing' phase is inherently bracketed by user
 * clicks seconds earlier, so the 60-minute idle budget cannot expire inside
 * it. Flows with other notions of "busy" can veto via registerIdleGuard().
 *
 * @author Orion DEX Team
 * @version 1.1.0
 */

import { Injectable, NgZone, inject } from '@angular/core';
import { WalletService } from './wallet.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { TransactionHistoryService } from './transaction-history.service';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Inactivity budget before logout (owner decision: 60 min). */
export const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** How often idleness is re-evaluated. */
export const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

/** Activity marks are coalesced within this window (pointermove storms). */
export const ACTIVITY_THROTTLE_MS = 1000;

/**
 * Shared cross-tab activity timestamp (epoch ms as a decimal string).
 * Written throttled by every tab; mirrored by the others via 'storage'.
 */
export const IDLE_ACTIVITY_STORAGE_KEY = 'orion_idle_last_activity';

/**
 * Minimum gap between localStorage activity writes. Coarser than
 * ACTIVITY_THROTTLE_MS on purpose: cross-tab precision of ~10 s is plenty
 * against a 60-minute budget, and localStorage writes are synchronous.
 */
export const ACTIVITY_STORAGE_WRITE_INTERVAL_MS = 10_000;

/**
 * A 'pending' transaction broadcast within this window vetoes the logout;
 * older pendings (stuck cross-chain records) do not.
 */
export const RECENT_BROADCAST_WINDOW_MS = 30 * 60 * 1000;

/** Returns true to veto an imminent idle logout (re-checked every interval). */
export type IdleGuard = () => boolean;

// =============================================================================
// IDLE LOGOUT SERVICE
// =============================================================================

@Injectable({
  providedIn: 'root',
})
export class IdleLogoutService {
  private readonly walletService = inject(WalletService);
  private readonly authService = inject(AuthService);
  private readonly toastService = inject(ToastService);
  private readonly txHistoryService = inject(TransactionHistoryService);
  private readonly ngZone = inject(NgZone);

  /** Epoch ms of the last counted user interaction in THIS tab. */
  private lastActivityAt: number = Date.now();

  /** Epoch ms of the last time an activity event was actually processed. */
  private lastMarkAt = 0;

  /**
   * In-memory mirror of the cross-tab activity timestamp, refreshed by the
   * 'storage' event — checkIdle never reads localStorage itself. No seed on
   * start is needed: start() sets lastActivityAt to now, which always wins
   * the max() over any (clamped-to-now) previously stored value.
   */
  private crossTabActivityAt = 0;

  /** Epoch ms of the last localStorage activity write (write throttle). */
  private lastStorageWriteAt = 0;

  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  private readonly guards = new Set<IdleGuard>();

  /** Events that count as user presence. Passive + capture (see header doc). */
  private readonly activityEvents: readonly string[] = [
    'pointerdown',
    'pointermove',
    'keydown',
    'wheel',
    'touchstart',
  ];

  // Bound once so removeEventListener gets the same references.
  private readonly onActivity = (): void => this.markActivity();
  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      this.checkIdle();
    }
  };
  private readonly onStorage = (event: StorageEvent): void => {
    if (event.key !== IDLE_ACTIVITY_STORAGE_KEY || !event.newValue) return;
    const stamp = Number(event.newValue);
    if (!Number.isFinite(stamp)) return;
    // Clamp to now: a corrupted/hostile future timestamp must not pin the
    // session open forever.
    this.crossTabActivityAt = Math.min(stamp, Date.now());
  };

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Idempotent. Called once by PrivyProviderComponent (the session owner). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.lastActivityAt = Date.now();
    // Everything here runs OUTSIDE the Angular zone: pointermove/wheel fire
    // continuously, and zone-registered handlers would trigger app-wide
    // change detection on each one. Only the logout re-enters the zone
    // (see checkIdle).
    this.ngZone.runOutsideAngular(() => {
      for (const eventName of this.activityEvents) {
        document.addEventListener(eventName, this.onActivity, { passive: true, capture: true });
      }
      document.addEventListener('visibilitychange', this.onVisibilityChange);
      window.addEventListener('storage', this.onStorage);
      this.checkTimer = setInterval(() => this.checkIdle(), IDLE_CHECK_INTERVAL_MS);
    });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const eventName of this.activityEvents) {
      document.removeEventListener(eventName, this.onActivity, { capture: true });
    }
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('storage', this.onStorage);
    if (this.checkTimer !== null) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------------

  /**
   * Register a veto callback consulted before an idle logout fires; returns
   * the unregister function. A veto does NOT reset the idle clock — the
   * logout fires on the first interval tick after every guard clears, unless
   * real activity arrived meanwhile.
   */
  registerIdleGuard(guard: IdleGuard): () => void {
    this.guards.add(guard);
    return () => this.guards.delete(guard);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private markActivity(): void {
    const now = Date.now();
    if (now - this.lastMarkAt < ACTIVITY_THROTTLE_MS) return;
    this.lastMarkAt = now;
    this.lastActivityAt = now;
    this.persistActivity(now);
  }

  /** Throttled write-through of activity for the other tabs (see header). */
  private persistActivity(now: number): void {
    if (now - this.lastStorageWriteAt < ACTIVITY_STORAGE_WRITE_INTERVAL_MS) return;
    this.lastStorageWriteAt = now;
    try {
      localStorage.setItem(IDLE_ACTIVITY_STORAGE_KEY, String(now));
    } catch {
      // Quota / private mode: cross-tab sharing degrades gracefully —
      // this tab's own in-memory clock still works.
    }
  }

  private checkIdle(): void {
    // Nothing to protect while disconnected — and never double-fire.
    if (this.walletService.isConnected() !== true) return;
    // Activity in ANY tab keeps the session alive — a background tab must
    // not log the user out while they work in another one.
    const lastActivityAt = Math.max(this.lastActivityAt, this.crossTabActivityAt);
    if (Date.now() - lastActivityAt < IDLE_TIMEOUT_MS) return;
    if (this.hasRecentBroadcast()) return;
    for (const guard of this.guards) {
      if (guard()) return;
    }

    // Reset BEFORE the logout calls: disconnect() flips isConnected
    // asynchronously enough that a racing visibilitychange check could
    // otherwise fire the whole path twice. In-memory only — the shared
    // localStorage timestamp stays stale so the OTHER tabs also log out.
    this.lastActivityAt = Date.now();

    // The check loop runs outside the Angular zone (see start()); the
    // logout mutates signals and shows a toast, so re-enter for exactly
    // one change-detection pass. The existing logout path — same pair the
    // header's Disconnect action runs; WalletService.disconnect() also
    // triggers the Privy logout bridge.
    this.ngZone.run(() => {
      this.authService.logout();
      this.walletService.disconnect();
      this.toastService.info('Session ended', 'Logged out after inactivity.');
    });
  }

  /** True when a transaction was broadcast recently and is still pending. */
  private hasRecentBroadcast(): boolean {
    const cutoff = Date.now() - RECENT_BROADCAST_WINDOW_MS;
    return this.txHistoryService
      .pendingTransactions()
      .some((tx) => tx.timestamp >= cutoff);
  }
}
