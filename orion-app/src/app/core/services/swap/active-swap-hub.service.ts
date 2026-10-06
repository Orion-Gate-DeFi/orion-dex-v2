/**
 * =============================================================================
 * ACTIVE SWAP HUB SERVICE
 * =============================================================================
 *
 * Owns the post-broadcast tracking lifecycle for CROSS-CHAIN swaps, decoupled
 * from any component. Before this hub existed, `swap.component` ran the
 * tracking loops itself and aborted them on destroy — navigating away from
 * the status screen silently killed all visibility into an in-flight bridge
 * (history stayed pending until rehydration, no toast ever landed).
 *
 * The hub runs the SAME two loops the component ran (the LI.FI status loop
 * and the backend /swap/status aggregator loop) with a hub-owned
 * AbortController, so tracking survives navigation. All progress updates and
 * terminal verdicts land in hub signals; the swap screen mirrors them while
 * it is on screen, and the floating swap pill renders them everywhere else.
 *
 * Side-effects that MUST fire even with the swap screen gone live here:
 * history verdicts (markSuccess / markFailed / interrupted-tracking
 * annotations), the completion/failure toasts, and the analytics funnel
 * events. Screen-local concerns (step buttons, layout) stay in the component.
 *
 * Abort happens ONLY on: logout, or a NEW swap replacing the active one
 * (single active swap in MVP). A terminal outcome ends the loop naturally.
 * Component destruction does NOT abort — that is the whole point.
 *
 * MVP boundaries: web only, cross-chain only (same-chain swaps confirm in
 * seconds and stay component-local), no persistence across page reload
 * (rehydration keeps settling history as before).
 *
 * @author Orion DEX Team
 * @version 1.0.0
 */

import { Injectable, NgZone, effect, inject, signal, untracked } from '@angular/core';
import {
  AggregatorName,
  SwapBridgeStatus,
  SwapQuote,
  TransactionTrackingState,
} from '../../models/swap.model';
import { TransactionTrackerService, sanitizeHttpsUrl } from './transaction-tracker.service';
import { TransactionHistoryService } from '../transaction-history.service';
import { ToastService } from '../toast.service';
import { AnalyticsService, AnalyticsProps } from '../analytics.service';
import { AuthService } from '../auth.service';
import { getNetworkName } from '../../constants';
import { presentError } from '../../utils/error-presenter';

// =============================================================================
// INTERFACES
// =============================================================================

/**
 * Lifecycle phase of the tracked swap.
 *   confirming — reserved for pre-receipt registration (post-MVP; the hub is
 *                currently only handed a swap AFTER the source receipt).
 *   bridging   — a tracking loop is live and the transfer is in flight.
 *   untracked  — no loop is watching (dispatcher unsupported / gave up, or
 *                the route carries no tracking data): verify on the explorer.
 *   timeout    — the loop ran out of attempts while still pending; the
 *                transfer may yet land (indeterminate, NOT a failure).
 *   success / partial / failed — terminal verdicts.
 */
export type ActiveSwapPhase =
  | 'confirming'
  | 'bridging'
  | 'untracked'
  | 'success'
  | 'partial'
  | 'failed'
  | 'timeout';

/** True when no live tracking loop runs for the phase (pill may be dismissed). */
export function isSwapSettled(phase: ActiveSwapPhase): boolean {
  return phase !== 'confirming' && phase !== 'bridging';
}

/** Display summary of the swap the hub is (or was) tracking. */
export interface ActiveSwapSummary {
  /** Source-chain transaction hash. */
  txHash: string;
  fromChainId: number;
  toChainId: number;
  fromSymbol: string;
  toSymbol: string;
  /** Human-unit amount strings straight from the quote — never re-derived. */
  fromAmount: string;
  toAmount: string;
  aggregator?: AggregatorName;
  /** Epoch ms of registration (≈ source receipt time). */
  startedAt: number;
  phase: ActiveSwapPhase;
  /**
   * Outbound end-to-end tracker link (dispatcher `tracking_url`, or the
   * hardcoded Axelarscan fallback for untracked Squid routes). `null` means
   * "explicitly none" (non-Squid untracked route); absent means unknown yet.
   */
  trackingUrl?: string | null;
  /** Presented (calm) failure copy for the failed/partial terminal phases. */
  errorMessage?: string;
}

/** Registration params — everything the old component-local trackers took. */
export interface StartCrossChainTrackingParams {
  quote: SwapQuote;
  /** Source-chain tx hash of the CONFIRMED source receipt. */
  txHash: string;
  /** Source-chain explorer link for the tx (may be '' when unknown). */
  explorerUrl: string;
  historyRecordId?: string;
  analyticsProps?: AnalyticsProps;
}

/** Toast copy pieces reused by both loops' timeout warnings. */
interface SwapSummaryStrings {
  fromAmount: string;
  fromSymbol: string;
  toAmount: string;
  toSymbol: string;
}

// =============================================================================
// ACTIVE SWAP HUB SERVICE
// =============================================================================

@Injectable({
  providedIn: 'root',
})
export class ActiveSwapHubService {
  private transactionTracker = inject(TransactionTrackerService);
  private txHistoryService = inject(TransactionHistoryService);
  private toastService = inject(ToastService);
  private analytics = inject(AnalyticsService);
  private authService = inject(AuthService);
  private ngZone = inject(NgZone);

  // ---------------------------------------------------------------------------
  // Reactive State
  // ---------------------------------------------------------------------------

  private readonly _activeSwap = signal<ActiveSwapSummary | null>(null);
  /** The swap being tracked (null when none / dismissed). */
  readonly activeSwap = this._activeSwap.asReadonly();

  private readonly _trackingState = signal<TransactionTrackingState | null>(null);
  /** Same shape the swap status screen renders (steps/progress/trackingUrl/error). */
  readonly trackingState = this._trackingState.asReadonly();

  private readonly _activeQuote = signal<SwapQuote | null>(null);
  /**
   * The full quote of the active swap — kept so the swap screen can restore
   * its status view (summary card, receipt) when the user returns to /swap.
   */
  readonly activeQuote = this._activeQuote.asReadonly();

  /** Hub-owned abort for the live loop — NOT tied to any component lifetime. */
  private abortController: AbortController | null = null;

  /**
   * Monotonic token identifying the registration whose callbacks may write
   * hub state. A replacing swap bumps it so the aborted loop's late
   * callbacks can't repaint the new swap's state.
   */
  private trackingSession = 0;

  constructor() {
    // Logout invalidates the session the tracking loops authenticate with
    // (LI.FI proxy + backend dispatcher are both Privy-JWT'd) — the only
    // abort trigger besides a new swap replacing the active one.
    effect(() => {
      const authed = this.authService.isAuthenticated();
      if (!authed) {
        untracked(() => this.abortAndClear());
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Public Methods
  // ---------------------------------------------------------------------------

  /**
   * Register a cross-chain swap right after its CONFIRMED source receipt and
   * start whichever tracker can actually see the transfer: the LI.FI Status
   * API for LI.FI routes, the backend /swap/status dispatcher for other
   * aggregators (Squid), or the honest untracked presentation when neither
   * applies. Replaces any previously active swap (its loop is aborted;
   * history stays pending and rehydration owns its final verdict).
   */
  startCrossChainTracking(params: StartCrossChainTrackingParams): void {
    const q = params.quote;
    const fromChain = q.fromToken.chainId;
    const toChain = q.toToken.chainId;

    // Single active swap (MVP): abort the previous loop FIRST so its late
    // callbacks can't write over the new swap's state.
    this.abortController?.abort();
    this.abortController = new AbortController();
    const abortSignal = this.abortController.signal;
    const session = ++this.trackingSession;

    this._activeQuote.set(q);
    this._trackingState.set(null);
    this._activeSwap.set({
      txHash: params.txHash,
      fromChainId: fromChain,
      toChainId: toChain,
      fromSymbol: q.fromToken.symbol,
      toSymbol: q.toToken.symbol,
      fromAmount: q.fromAmount,
      toAmount: q.toAmount,
      aggregator: q.aggregator,
      startedAt: Date.now(),
      phase: 'bridging',
    });

    // The LI.FI Status API only tracks transfers LI.FI executed. A
    // cross-chain quote won by another backend aggregator (Squid) would
    // poll NOT_FOUND forever and end on a scary timeout banner even though
    // the bridge delivered fine.
    const lifiTrackable = q.aggregator === 'lifi' || !!q._lifiRoute;
    const swapSummary: SwapSummaryStrings = {
      fromAmount: q.fromAmount,
      fromSymbol: q.fromToken.symbol,
      toAmount: q.toAmount,
      toSymbol: q.toToken.symbol,
    };

    if (lifiTrackable) {
      this.runLifiTracking(session, abortSignal, q, params, swapSummary);
    } else if (q._aggregatorData && q.aggregator) {
      this.runAggregatorTracking(session, abortSignal, q, q.aggregator, params, swapSummary);
    } else {
      this.presentUntrackedBridge(session, fromChain, toChain, params.txHash, q.aggregator, params.explorerUrl);
    }
  }

  /**
   * Pill close. Clears a settled swap (terminal verdict, untracked, or
   * timed-out watch); a LIVE loop is never killed from here — abort happens
   * only on logout or replacement by a new swap.
   */
  dismiss(): void {
    const active = this._activeSwap();
    if (!active || !isSwapSettled(active.phase)) return;
    this.clear();
  }

  // ---------------------------------------------------------------------------
  // LI.FI tracking loop (moved from swap.component.startTransactionTracking)
  // ---------------------------------------------------------------------------

  /**
   * Final-state truthfulness (unchanged from the component era):
   *   - DONE   → mark history success, phase 'success', toast + haptic.
   *   - FAILED → mark history failed, phase 'failed' with calm copy.
   *   - null   → aborted (logout / replaced): fully silent; otherwise a
   *              genuine timeout — phase 'timeout', warn once, history stays
   *              pending (rehydration resolves it).
   */
  private runLifiTracking(
    session: number,
    abortSignal: AbortSignal,
    q: SwapQuote,
    params: StartCrossChainTrackingParams,
    swapSummary: SwapSummaryStrings,
  ): void {
    const { txHash, historyRecordId, analyticsProps } = params;
    const fromChain = q.fromToken.chainId;
    const toChain = q.toToken.chainId;

    // Seed forward of what the swap screen's execution callback already
    // painted (source-confirm completed, bridging in progress @60) — the
    // tracker only starts after the source receipt, so resetting to
    // "source confirming @5" made the timeline visibly jump backwards.
    this._trackingState.set({
      progress: 60,
      currentStep: 1,
      steps: [
        { id: 'source-confirm', title: `Confirmed on ${getNetworkName(fromChain)}`, status: 'completed' },
        { id: 'bridging', title: 'Bridging tokens', status: 'in_progress' },
        { id: 'dest-confirm', title: `Receiving on ${getNetworkName(toChain)}`, status: 'pending' },
        { id: 'complete', title: 'Complete', status: 'pending' },
      ],
      isTracking: true,
      // No numeric ETA for cross-chain: the UI shows the honest
      // 'usually 5–30 min' range instead of a countdown that expires.
      estimatedTimeRemaining: undefined,
    });

    this.transactionTracker.trackTransaction(
      txHash,
      fromChain,
      toChain,
      (state: TransactionTrackingState) => {
        this.ngZone.run(() => this.applyTrackerState(session, state));
      },
      undefined,
      undefined,
      q._lifiRoute?.tool,
      abortSignal,
    ).then((finalStatus) => {
      this.ngZone.run(() => {
        // A verdict racing a genuine abort (logout wiping the session, or a
        // new swap replacing this one) must be fully silent: no history
        // write, no toast, no analytics — the session that authorized them
        // is gone. "Start new swap" does NOT abort the hub loop, so
        // walked-away swaps still get their verdicts through here.
        if (abortSignal.aborted) return;
        const hubLive = session === this.trackingSession;
        // Same trust boundary as the dispatcher's tracking_url: the LI.FI
        // Status API's explorer link is upstream-supplied and ends up as a
        // clickable toast action, so it goes through the host allowlist too.
        const lifiExplorerLink = sanitizeHttpsUrl(finalStatus?.lifiExplorerLink);
        if (finalStatus?.status === 'DONE') {
          // Bridge confirmed delivery on destination — only now may the
          // history record flip to success.
          if (hubLive) {
            this.patchActiveSwap(session, { phase: 'success' });
          }
          if (historyRecordId) {
            this.txHistoryService.markSuccess(historyRecordId, txHash);
          }
          if (analyticsProps) {
            this.analytics.track('swap_completed', analyticsProps);
          }
          this.toastService.success(
            'Bridge complete!',
            `Tokens received on ${getNetworkName(toChain)}`,
            lifiExplorerLink
              ? { text: 'View on LI.FI', url: lifiExplorerLink }
              : undefined,
          );
          this.triggerSuccessHaptic();
        } else if (finalStatus?.status === 'FAILED') {
          const reason = finalStatus.substatusMessage || 'Bridge failed';
          // Boundary sanitization: LI.FI's substatusMessage is a raw
          // upstream string — the UI and toast get calm copy; history keeps
          // the raw reason for support.
          const presented = presentError(reason, 'swap');
          if (hubLive) {
            this.patchActiveSwap(session, { phase: 'failed', errorMessage: presented.short });
          }
          if (historyRecordId) {
            this.txHistoryService.markFailed(historyRecordId, reason);
          }
          if (analyticsProps) {
            // A bridge FAILED verdict is never a wallet rejection — the
            // source tx was already signed and confirmed.
            this.analytics.track('swap_failed', { ...analyticsProps, reason: 'failed' });
          }
          this.toastService.error('Bridge failed', presented.short);
        } else {
          // finalStatus is null and the signal is NOT aborted (checked at
          // the top), so this is a genuine timeout — an aborted loop
          // already returned silently; history stays pending and
          // rehydration owns the final verdict.
          // The tracking state already carries the timeout banner from the
          // loop's last notify. Staying indeterminate is the truthful
          // option — the bridge may yet land.
          if (hubLive) {
            this.patchActiveSwap(session, { phase: 'timeout' });
          }
          this.toastService.warning(
            'Bridge tracking timed out',
            `Your swap of ${swapSummary.fromAmount} ${swapSummary.fromSymbol} → ${swapSummary.toAmount} ${swapSummary.toSymbol} is still being processed. Check the explorer for the latest status.`,
          );
        }
      });
    }).catch((error) => {
      console.error('[ActiveSwapHub] Tracking error:', error);
    });
  }

  // ---------------------------------------------------------------------------
  // Aggregator tracking loop (moved from swap.component.startAggregatorBridgeTracking)
  // ---------------------------------------------------------------------------

  /**
   * Real tracking for a cross-chain swap routed by a non-LI.FI backend
   * aggregator (Squid), via the backend /swap/status dispatcher. Verdict
   * mapping unchanged from the component era:
   *   - success → phase 'success' + markSuccess + swap_completed + toast;
   *   - partial → phase 'partial' + markFailed + swap_failed + explanation;
   *   - unsupported / gave_up → honest untracked presentation — NOT a swap
   *     failure, history stays pending (gave_up additionally annotates the
   *     record when the last observed status was a warning state);
   *   - timeout → phase 'timeout'; history stays pending;
   *   - aborted → logout / replaced: fully silent.
   */
  private runAggregatorTracking(
    session: number,
    abortSignal: AbortSignal,
    quote: SwapQuote,
    aggregator: AggregatorName,
    params: StartCrossChainTrackingParams,
    swapSummary: SwapSummaryStrings,
  ): void {
    const { txHash, explorerUrl, historyRecordId, analyticsProps } = params;
    const fromChain = quote.fromToken.chainId;
    const toChain = quote.toToken.chainId;

    // No seed here: the tracker pushes its initial state (source confirmed,
    // bridging in progress) synchronously before its first poll.
    this.transactionTracker.trackAggregatorBridge(
      {
        aggregator,
        txHash,
        fromChain,
        toChain,
        quoteId: quote._aggregatorData?.tracking_quote_id,
        requestId: quote._aggregatorData?.tracking_request_id,
      },
      (state: TransactionTrackingState) => {
        this.ngZone.run(() => this.applyTrackerState(session, state));
      },
      undefined,
      undefined,
      abortSignal,
    ).then((outcome) => {
      // Aborted (logout / replaced): silent by contract — no failure paint,
      // no toasts, no history writes; rehydration owns the final verdict.
      if (outcome.kind === 'aborted') return;
      this.ngZone.run(() => {
        // Same race guard as the LI.FI handler: a real verdict that
        // resolved concurrently with a logout/replacement abort must not
        // write history, toast or track analytics for a dead session.
        if (abortSignal.aborted) return;
        const hubLive = session === this.trackingSession;

        if (outcome.kind === 'success') {
          // The dispatcher's tracking_url is upstream-supplied: a compromised
          // (or MITM'd) response could hand us a lookalike host or a
          // javascript: payload and we would render it as a trusted in-app
          // link. Same allowlist the tracker applies to its own copy of this
          // field — null means "no link", never an unsanitized href.
          const trackingUrl = sanitizeHttpsUrl(outcome.response.tracking_url);
          if (hubLive) {
            const patch: Partial<ActiveSwapSummary> = { phase: 'success' };
            if (trackingUrl) {
              patch.trackingUrl = trackingUrl;
            }
            this.patchActiveSwap(session, patch);
          }
          if (historyRecordId) {
            this.txHistoryService.markSuccess(historyRecordId, txHash);
          }
          if (analyticsProps) {
            this.analytics.track('swap_completed', analyticsProps);
          }
          this.toastService.success(
            'Bridge complete!',
            `Tokens received on ${getNetworkName(toChain)}`,
            trackingUrl
              ? { text: 'View transfer', url: trackingUrl }
              : undefined,
          );
          this.triggerSuccessHaptic();
        } else if (outcome.kind === 'partial') {
          if (hubLive) {
            this.patchActiveSwap(session, { phase: 'partial', errorMessage: outcome.reason });
          }
          if (historyRecordId) {
            this.txHistoryService.markFailed(historyRecordId, outcome.reason);
          }
          if (analyticsProps) {
            // Like the LI.FI FAILED verdict: never a wallet rejection — the
            // source tx was already signed and confirmed.
            this.analytics.track('swap_failed', { ...analyticsProps, reason: 'failed' });
          }
          this.toastService.error('Fallback token delivered', outcome.reason);
        } else if (outcome.kind === 'unsupported' || outcome.kind === 'gave_up') {
          // Tracking isn't available (or its endpoint kept failing). The
          // bridge itself is most likely fine — fall back to the honest
          // untracked presentation; history stays pending and the 60-min
          // normalization resolves it.
          if (outcome.kind === 'gave_up') {
            this.annotateInterruptedBridgeTracking(historyRecordId, outcome.lastObservedStatus);
          }
          this.presentUntrackedBridge(session, fromChain, toChain, txHash, aggregator, explorerUrl);
        } else {
          // timeout — indeterminate, same treatment as the LI.FI tracker:
          // leave history pending, warn once.
          this.annotateInterruptedBridgeTracking(historyRecordId, outcome.lastObservedStatus);
          if (hubLive) {
            this.patchActiveSwap(session, { phase: 'timeout' });
          }
          this.toastService.warning(
            'Bridge tracking timed out',
            `Your swap of ${swapSummary.fromAmount} ${swapSummary.fromSymbol} → ${swapSummary.toAmount} ${swapSummary.toSymbol} is still being processed. Check the explorer for the latest status.`,
          );
        }
      });
    }).catch((error) => {
      // Defensive: trackAggregatorBridge encodes all expected outcomes in
      // its return value, so a rejection is a programming error. Present
      // the untracked fallback rather than a dead "bridging" state.
      console.error('[ActiveSwapHub] Aggregator tracking error:', error);
      this.ngZone.run(() => {
        this.presentUntrackedBridge(session, fromChain, toChain, txHash, aggregator, explorerUrl);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  /**
   * Fallback presentation for a cross-chain swap we cannot track: source
   * confirmed, destination delivery NOT watched — verify on the explorer
   * (Axelarscan for Squid). Moved verbatim from the component's
   * setUntrackableBridgeState; the history record intentionally stays
   * `pending` in-session.
   */
  private presentUntrackedBridge(
    session: number,
    fromChain: number,
    toChain: number,
    srcTxHash: string,
    aggregator?: AggregatorName,
    sourceExplorerUrl?: string,
  ): void {
    if (session !== this.trackingSession) return;
    // Squid routes settle through Axelar, so Axelarscan can follow the
    // transfer by source tx hash even though our tracker can't. Other
    // untrackable aggregators fall back to the source-chain explorer only.
    const trackingUrl =
      aggregator === 'squid' && srcTxHash ? `https://axelarscan.io/gmp/${srcTxHash}` : null;
    this.patchActiveSwap(session, { phase: 'untracked', trackingUrl });
    this._trackingState.set({
      progress: 50,
      currentStep: 1,
      steps: [
        {
          id: 'source-confirm',
          title: `Confirmed on ${getNetworkName(fromChain)}`,
          description: 'Your transaction is on its way across the bridge',
          status: 'completed',
          explorerLink: sourceExplorerUrl,
        },
        {
          id: 'bridging',
          title: `Delivering to ${getNetworkName(toChain)}`,
          description: 'Cross-chain delivery isn\'t tracked for this route yet. Funds typically arrive in 5–30 minutes — check the destination explorer.',
          // 'pending', NOT 'in_progress': nothing is being watched here, so
          // an in-progress step would pulse and count elapsed time FOREVER —
          // beta testers read that as a hang even after funds arrived. The
          // neutral state keeps the honest "isn't tracked" copy without
          // claiming live progress.
          status: 'pending',
          explorerLink: sourceExplorerUrl,
        },
      ],
      isTracking: false,
      // No estimatedTimeRemaining: a "~10m remaining" chip would contradict
      // the honest "isn't tracked" copy — the step text owns the 5-30 min
      // expectation instead.
    });
    this.toastService.info(
      'Bridge in progress',
      `Source transaction confirmed. Tokens usually arrive on ${getNetworkName(toChain)} within 5–30 minutes.`,
      sourceExplorerUrl ? { text: 'View source tx', url: sourceExplorerUrl } : undefined,
    );
  }

  /**
   * History annotation for a bridge tracker that stopped (timed out / gave
   * up) while the dispatcher's last word was a warning state. Status
   * deliberately stays `pending` — the outcome is genuinely unresolved when
   * tracking stops; the annotation only pins what was last known so the
   * stale-pending normalization can present it honestly (refunding → failed,
   * needs_gas → still pending).
   */
  private annotateInterruptedBridgeTracking(
    historyRecordId: string | undefined,
    lastObservedStatus: SwapBridgeStatus | null,
  ): void {
    if (!historyRecordId) return;
    if (lastObservedStatus === 'refunding') {
      this.txHistoryService.updateTransaction(historyRecordId, {
        bridgeAnnotation: 'refunding',
        errorMessage: 'A refund was in progress when tracking stopped — check your source-chain wallet.',
      });
    } else if (lastObservedStatus === 'needs_gas') {
      this.txHistoryService.updateTransaction(historyRecordId, {
        bridgeAnnotation: 'needs_gas',
        errorMessage: 'The transfer was waiting for extra destination gas when tracking stopped — check the transfer tracker or destination explorer.',
      });
    }
  }

  /** Progress-callback funnel shared by both loops. */
  private applyTrackerState(session: number, state: TransactionTrackingState): void {
    if (session !== this.trackingSession) return;
    // The end-to-end tracker link (Axelarscan et al.) is news even when the
    // repaint below is dropped as a regression — surface it immediately.
    if (state.trackingUrl) {
      this.patchActiveSwap(session, { trackingUrl: state.trackingUrl });
    }
    if (this.shouldIgnoreTrackerRegression(state)) return;
    this._trackingState.set(state);
  }

  /**
   * Monotonic-progress guard for tracker repaints, inherited from the swap
   * screen: both loops push an initial state before their first poll (LI.FI
   * at progress 0/5) while the hub already holds the post-receipt seed @60 —
   * repainting those would walk the timeline visibly backwards. The hub only
   * ever tracks the live bridge wait (registration → terminal), which is
   * exactly the window the old `transactionStatus === 'confirming'` check
   * approximated. Failure/terminal states are exempt: a FAILED verdict must
   * always repaint, whatever its progress number says.
   */
  private shouldIgnoreTrackerRegression(state: TransactionTrackingState): boolean {
    if (state.error || state.steps.some((s) => s.status === 'failed')) return false;
    const current = this._trackingState();
    return current !== null && state.progress < current.progress;
  }

  /** Session-guarded partial update of the active-swap summary. */
  private patchActiveSwap(session: number, patch: Partial<ActiveSwapSummary>): void {
    if (session !== this.trackingSession) return;
    const current = this._activeSwap();
    if (!current) return;
    this._activeSwap.set({ ...current, ...patch });
  }

  /**
   * Vibrate-on-success helper (same as the swap screen's). Browsers that
   * don't expose the Vibration API silently no-op.
   */
  private triggerSuccessHaptic(): void {
    try {
      if ('vibrate' in navigator) {
        navigator.vibrate([30, 50, 30]);
      }
    } catch {
      // Some browsers throw on vibrate without prior gesture; ignore.
    }
  }

  /** Logout: end the loop AND drop the state — the pill must not survive a session. */
  private abortAndClear(): void {
    this.abortController?.abort();
    this.abortController = null;
    // Detach any late callbacks from the (now cleared) hub state.
    this.trackingSession++;
    this.clear();
  }

  private clear(): void {
    this._activeSwap.set(null);
    this._trackingState.set(null);
    this._activeQuote.set(null);
  }
}
