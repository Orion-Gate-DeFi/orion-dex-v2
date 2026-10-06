/**
 * Transaction Tracker Service
 * Handles tracking transaction status via the LI.FI Status API and the
 * backend per-aggregator bridge-status dispatcher (GET /swap/status).
 */
import { Injectable, inject } from '@angular/core';
import {
  AggregatorName,
  LifiStatusResponse,
  LifiTransactionStatus,
  SwapBridgeStatus,
  SwapStatusResponse,
  TransactionStep,
  TransactionTrackingState,
} from '../../models/swap.model';
import { AggregatorService } from './aggregator.service';
import { ChainService } from './chain.service';
import { AuthService } from '../auth.service';
import { getExplorerTxUrl } from '../../constants';
import { environment } from '../../../../environments/environment';

/** Default polling interval (3 seconds) */
const DEFAULT_POLLING_INTERVAL = 3000;

/** Maximum polling attempts (~5 minutes baseline; effective wallclock is longer with backoff) */
const DEFAULT_MAX_ATTEMPTS = 100;

/** Cap exponential backoff so a long outage doesn't sleep us out forever. */
const MAX_BACKOFF_MS = 30_000;

/**
 * Aggregator bridge-status polling interval. Bridge legs take minutes, not
 * seconds — 15 s keeps the backend dispatcher (and its upstream quota) cool
 * while still surfacing needs_gas/refunding warnings promptly.
 */
const AGGREGATOR_POLL_INTERVAL_MS = 15_000;

/** Hard cap on aggregator status polling: ~45 min at the default interval. */
const AGGREGATOR_MAX_ATTEMPTS = 180;

/**
 * Consecutive transient /swap/status failures before giving up. Giving up is
 * NOT a swap failure — the bridge is most likely fine, only our status
 * endpoint isn't — so the caller falls back to the untracked-bridge UX.
 * Combined with the exponential backoff below, 8 strikes cover roughly a
 * 6-minute status-endpoint outage (e.g. a routine backend deploy) before
 * live tracking is abandoned.
 */
const AGGREGATOR_MAX_TRANSIENT_FAILURES = 8;

/**
 * Cap for the exponential backoff between transient /swap/status retries —
 * same pattern as MAX_BACKOFF_MS on the LI.FI loop, scaled to the slower
 * bridge cadence. At the 15 s base interval the retry delays run
 * 22.5s → 34s → 51s → 60s → 60s → 60s → 60s ≈ 5.8 min of covered outage.
 */
const AGGREGATOR_TRANSIENT_BACKOFF_CAP_MS = 60_000;

/**
 * Default bridge ETA (seconds) while the transfer is pending. Also restored
 * when a transfer recovers from a needs_gas/refunding warning — those states
 * clear the ETA (see updateAggregatorTrackingState).
 */
const AGGREGATOR_DEFAULT_ETA_SECONDS = 180;

/**
 * Progress for the bridging phase (source confirmed, destination pending).
 * Exported so it provably matches the 60 the swap component's execution
 * callback paints when the source receipt lands — this tracker starts
 * immediately after that, and a lower initial notify used to walk the
 * progress bar visibly backwards. (The component additionally drops
 * non-terminal regressions, but the numbers should agree at the source.)
 */
export const AGGREGATOR_BRIDGING_PROGRESS = 60;

/**
 * Statuses the backend contract defines as non-final (keep polling). Used to
 * detect the defensive case: `is_final: true` on a status this client does
 * not recognize (a newer dispatcher) must still terminate the loop.
 */
const KNOWN_NON_FINAL_STATUSES: ReadonlySet<SwapBridgeStatus> = new Set([
  'pending',
  'not_found',
  'needs_gas',
  'refunding',
]);

/**
 * User-facing explanation for a `partial_success` verdict. Exported so the
 * spec can assert the exact copy the component renders.
 *
 * Squid semantics: the destination swap reverted, so the bridge delivered a
 * fallback token of EQUIVALENT VALUE (typically axlUSDC/USDC) to the user's
 * wallet on the destination chain. Nothing is lost and there is nothing for
 * support to recover — the user just holds a different token than quoted.
 *
 * Deliberate divergence from the LI.FI path: LI.FI's DONE + PARTIAL is
 * presented as success (pre-existing — see getStatusMessage), while this
 * verdict is presented as 'failed'. The user did NOT receive the quoted
 * token, and the success screen's "you received Y — it's already in your
 * wallet" would be a worse lie than a failed verdict with a calm, accurate
 * explanation.
 */
export const PARTIAL_SUCCESS_REASON =
  'The destination swap couldn\'t complete, so a fallback token of equivalent value (usually axlUSDC) was delivered to your wallet on the destination chain instead. Check your wallet on the destination network — you can swap it manually.';

/**
 * Hosts an upstream-supplied tracker link may point at — the base domains;
 * subdomains (e.g. testnet.axelarscan.io, scan.li.fi) are accepted too.
 * Squid tracks on Axelarscan; `li.fi` covers the LI.FI Status API's
 * `lifiExplorerLink`, which the hub renders as a toast action and is just as
 * upstream-controlled as a dispatcher `tracking_url`.
 */
const TRACKING_URL_ALLOWED_HOSTS: ReadonlySet<string> = new Set(['axelarscan.io', 'li.fi']);

/**
 * Accept an upstream-supplied tracking URL only when it parses as plain
 * https AND its host is an allowlisted tracker domain (or a subdomain of
 * one). Anything else — javascript:, data:, protocol-relative, garbage, or
 * an https link to an arbitrary host a compromised upstream could use for
 * phishing — returns null and the UI simply renders no link. Suffix tricks
 * (notaxelarscan.io, axelarscan.io.evil.com) don't match: the host must be
 * exactly the allowlisted domain or end with `.<domain>`. Exported for the
 * spec.
 */
export function sanitizeHttpsUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.toLowerCase();
    for (const allowed of TRACKING_URL_ALLOWED_HOSTS) {
      if (host === allowed || host.endsWith(`.${allowed}`)) return url;
    }
    return null;
  } catch {
    return null;
  }
}

/** Identifies the swap being tracked through the backend status dispatcher. */
export interface AggregatorBridgeTrackingParams {
  aggregator: AggregatorName;
  /** Source-chain transaction hash. */
  txHash: string;
  fromChain: number;
  toChain: number;
  /** Squid: `AggregatorQuote.tracking_quote_id`. */
  quoteId?: string;
  /** Squid: `AggregatorQuote.tracking_request_id`. */
  requestId?: string;
}

/**
 * Terminal outcome of `trackAggregatorBridge` — resolved exactly once:
 *
 * - `success`     — destination leg confirmed; the only true completion.
 * - `partial`     — final failure-with-explanation: the destination swap
 *                   reverted and a fallback token of equivalent value was
 *                   delivered instead of the quoted token.
 * - `unsupported` — the backend has no tracking for this aggregator; the
 *                   caller must fall back to the untracked-bridge UX.
 * - `gave_up`     — the status endpoint kept failing (or reported a final
 *                   status this client doesn't recognize); fall back to the
 *                   untracked UX but do NOT mark the swap failed.
 * - `timeout`     — hard cap reached while still pending; the caller keeps
 *                   the honest 'confirming' state.
 * - `aborted`     — the caller's abort signal fired (component destroyed /
 *                   navigation away from a healthy in-flight bridge). NOT a
 *                   verdict on the swap: the caller must stay silent — no
 *                   toasts, no state writes; history stays pending and
 *                   rehydration owns the final outcome.
 *
 * `gave_up` / `timeout` carry the last status the dispatcher reported (null
 * if none ever arrived) so the caller can annotate the history record when
 * tracking stopped mid-`refunding` / mid-`needs_gas` — without it a refunded
 * swap would later be presented as delivered by the stale-pending
 * normalization in TransactionHistoryService.
 */
export type AggregatorBridgeOutcome =
  | { kind: 'success'; response: SwapStatusResponse }
  | { kind: 'partial'; response: SwapStatusResponse; reason: string }
  | { kind: 'unsupported' }
  | { kind: 'gave_up'; lastObservedStatus: SwapBridgeStatus | null }
  | { kind: 'timeout'; lastObservedStatus: SwapBridgeStatus | null }
  | { kind: 'aborted' };

@Injectable({
  providedIn: 'root',
})
export class TransactionTrackerService {
  private chainService = inject(ChainService);
  private authService = inject(AuthService);
  private aggregatorService = inject(AggregatorService);

  /**
   * Get transaction status from LI.FI
   */
  async getTransactionStatus(
    txHash: string,
    fromChain?: number,
    toChain?: number,
    bridge?: string,
  ): Promise<LifiStatusResponse | null> {
    try {
      const params = new URLSearchParams({ txHash });

      // LI.FI docs: fromChain speeds up the lookup; toChain should be set
      // (same as fromChain for same-chain swaps); bridge is recommended —
      // the SDK JSDoc calls it required — for cross-chain transfers.
      if (fromChain) {
        params.append('fromChain', fromChain.toString());
      }
      if (toChain) {
        params.append('toChain', toChain.toString());
      }
      if (bridge) {
        params.append('bridge', bridge);
      }

      const url = `${environment.lifiProxyUrl}/status?${params.toString()}`;

      const token = await this.authService.getAccessTokenAsync();

      const response = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        console.error('[Tracker] Failed:', response.status, errorText);
        return null;
      }

      const data = await response.json();

      return data as LifiStatusResponse;
    } catch (error) {
      console.error('[Tracker] Error:', error);
      return null;
    }
  }

  /**
   * Track transaction with polling until completion.
   *
   * Hardened path:
   * - **Exponential backoff** on failed status calls — a flaky LI.FI Status
   *   API used to burn 100 quota-eating requests at the baseline interval.
   * - **Visibility pause** — `document.hidden` halts polling so a backgrounded
   *   tab doesn't keep hitting the API for an hour while the user is away.
   * - **Safe callback** — a throwing `onStatusUpdate` no longer aborts the
   *   loop and leaves `isTracking` stuck `true`.
   * - **Source-confirmed timeout state** — when we run out of attempts,
   *   surface the source tx link in `error` so the user can verify on the
   *   explorer instead of re-broadcasting and double-spending.
   * - **Abortable** — an optional `abortSignal` stops the loop (resolving
   *   `null`, with no further notifies) so a destroyed component doesn't
   *   stay pinned by up-to-100 polls. The signal is honored mid-sleep and
   *   mid-hidden-wait too, releasing the caller promptly. History
   *   finalization is NOT this loop's job — the rehydration service settles
   *   pending records on the next wallet bind.
   */
  async trackTransaction(
    txHash: string,
    fromChain: number,
    toChain: number,
    onStatusUpdate: (state: TransactionTrackingState) => void,
    pollingInterval: number = DEFAULT_POLLING_INTERVAL,
    maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
    bridgeTool?: string,
    abortSignal?: AbortSignal,
  ): Promise<LifiStatusResponse | null> {
    if (abortSignal?.aborted) return null;

    let attempts = 0;
    let consecutiveFailures = 0;
    let lastStatus: LifiTransactionStatus | null = null;

    const isCrossChain = fromChain !== toChain;
    const steps = this.buildSteps(isCrossChain, fromChain, toChain);

    const trackingState: TransactionTrackingState = {
      progress: 0,
      currentStep: 0,
      steps,
      isTracking: true,
      estimatedTimeRemaining: isCrossChain ? 180 : 30,
    };

    const safeNotify = (state: TransactionTrackingState): void => {
      try {
        onStatusUpdate({ ...state });
      } catch (err) {
        console.error('[Tracker] onStatusUpdate threw:', err);
      }
    };

    safeNotify(trackingState);

    while (attempts < maxAttempts) {
      // Caller is gone (component destroyed / navigation away): stop quietly.
      // No final notify — there is nobody left to repaint.
      if (abortSignal?.aborted) {
        trackingState.isTracking = false;
        return null;
      }

      attempts++;

      // Don't poll while the tab is hidden — we'll catch up on resume.
      // Avoids quietly draining the LI.FI status quota on backgrounded tabs.
      await this.waitWhileHidden(abortSignal);

      const status = await this.getTransactionStatus(txHash, fromChain, toChain, bridgeTool);

      // Re-check after the await: an abort that landed while the fetch was
      // in flight must not leak one more notify into a destroyed caller.
      if (abortSignal?.aborted) {
        trackingState.isTracking = false;
        return null;
      }

      if (!status) {
        consecutiveFailures++;
        const backoff = Math.min(MAX_BACKOFF_MS, pollingInterval * Math.pow(1.5, consecutiveFailures));
        await this.delay(backoff, abortSignal);
        continue;
      }

      consecutiveFailures = 0;

      this.updateTrackingState(trackingState, status, fromChain, toChain);
      trackingState.lifiStatus = status;

      safeNotify(trackingState);

      if (status.status === 'DONE' || status.status === 'FAILED') {
        trackingState.isTracking = false;
        safeNotify(trackingState);
        return status;
      }

      if (status.status !== lastStatus) {
        lastStatus = status.status;
      }

      await this.delay(pollingInterval, abortSignal);
    }

    console.warn('[Tracker] Max attempts reached');
    trackingState.isTracking = false;

    // The source step gets its txLink populated once LI.FI sees the source
    // confirmation; surface it on timeout so the user can verify on-chain
    // and decide whether to wait or reach support — instead of re-firing.
    const sourceLink = trackingState.steps[0]?.explorerLink;
    trackingState.error = sourceLink
      ? 'Tracking timed out: source tx is confirmed, destination still pending. Check the source explorer for the latest state before re-trying.'
      : 'Tracking timed out. Please check the explorer manually before re-broadcasting.';
    safeNotify(trackingState);

    return null;
  }

  /**
   * Track a cross-chain swap routed by a non-LI.FI backend aggregator
   * (Squid) by polling GET /swap/status until a terminal verdict.
   *
   * Mirrors `trackTransaction`'s contract: progress is pushed through
   * `onStatusUpdate` using the same `TransactionTrackingState` shape the
   * LI.FI path emits, and the returned promise resolves exactly once with
   * the terminal `AggregatorBridgeOutcome`.
   *
   * Status mapping (backend contract):
   * - `success`         → final success.
   * - `partial_success` → final failure-with-explanation (destination swap
   *                       reverted; a fallback token of equivalent value was
   *                       delivered instead — see PARTIAL_SUCCESS_REASON).
   * - `needs_gas`       → keep polling; the bridging step warns the transfer
   *                       is stuck waiting for extra destination gas.
   * - `refunding`       → keep polling; the bridging step shows refund copy.
   * - `pending` / `not_found` → keep polling (`not_found` is normal right
   *                       after submission while indexers catch up).
   * - unrecognized status with `is_final: true` → give up (defensive: a
   *                       newer dispatcher reached a terminal state this
   *                       client predates; polling can't change a verdict).
   * - HTTP 404 (unsupported) → stop immediately; caller falls back to the
   *                       untracked-bridge UX.
   * - 8 consecutive transient failures (with exponential backoff, ~6 min
   *                       of covered outage) → give up; caller falls back.
   *                       The swap is NOT marked failed.
   *
   * Abortable like `trackTransaction`: an optional `abortSignal` stops the
   * loop (resolving `{ kind: 'aborted' }`, with no further notifies) so a
   * destroyed component doesn't stay pinned by up-to-180 polls. The signal
   * is honored mid-sleep and mid-hidden-wait too. History finalization is
   * NOT this loop's job — the rehydration service settles pending records.
   *
   * The tracker only starts after the source receipt landed, so the
   * source-confirm step begins `completed` and bridging `in_progress`.
   */
  async trackAggregatorBridge(
    params: AggregatorBridgeTrackingParams,
    onStatusUpdate: (state: TransactionTrackingState) => void,
    pollingInterval: number = AGGREGATOR_POLL_INTERVAL_MS,
    maxAttempts: number = AGGREGATOR_MAX_ATTEMPTS,
    abortSignal?: AbortSignal,
  ): Promise<AggregatorBridgeOutcome> {
    if (abortSignal?.aborted) return { kind: 'aborted' };

    let attempts = 0;
    let consecutiveTransientFailures = 0;
    let lastObservedStatus: SwapBridgeStatus | null = null;

    const steps = this.buildSteps(true, params.fromChain, params.toChain);
    steps[0].status = 'completed';
    steps[1].status = 'in_progress';
    // Kept so a transfer that recovers from needs_gas/refunding back to
    // pending sheds the stale warning copy.
    const defaultBridgingDescription = steps[1].description;

    const trackingState: TransactionTrackingState = {
      progress: AGGREGATOR_BRIDGING_PROGRESS,
      currentStep: 1,
      steps,
      isTracking: true,
      estimatedTimeRemaining: AGGREGATOR_DEFAULT_ETA_SECONDS,
    };

    const safeNotify = (state: TransactionTrackingState): void => {
      try {
        onStatusUpdate({ ...state, steps: state.steps.map((s) => ({ ...s })) });
      } catch (err) {
        console.error('[Tracker] onStatusUpdate threw:', err);
      }
    };

    safeNotify(trackingState);

    while (attempts < maxAttempts) {
      // Caller is gone (component destroyed / navigation away): stop quietly.
      // No final notify — there is nobody left to repaint.
      if (abortSignal?.aborted) {
        trackingState.isTracking = false;
        return { kind: 'aborted' };
      }

      attempts++;

      // Same hidden-tab etiquette as the LI.FI loop: a backgrounded tab
      // must not drain the dispatcher; we catch up on resume.
      await this.waitWhileHidden(abortSignal);

      const result = await this.aggregatorService.getSwapStatus({
        aggregator: params.aggregator,
        transactionId: params.txHash,
        fromChainId: params.fromChain,
        toChainId: params.toChain,
        quoteId: params.quoteId,
        requestId: params.requestId,
      });

      // Re-check after the await: an abort that landed while the fetch was
      // in flight must not leak one more notify into a destroyed caller.
      if (abortSignal?.aborted) {
        trackingState.isTracking = false;
        return { kind: 'aborted' };
      }

      if (result.kind === 'unsupported') {
        // No tracking for this aggregator — permanent. Don't notify: the
        // caller repaints the whole state via its untracked-bridge fallback.
        trackingState.isTracking = false;
        return { kind: 'unsupported' };
      }

      if (result.kind === 'transient') {
        consecutiveTransientFailures++;
        if (consecutiveTransientFailures >= AGGREGATOR_MAX_TRANSIENT_FAILURES) {
          trackingState.isTracking = false;
          return { kind: 'gave_up', lastObservedStatus };
        }
        // Exponential backoff (same pattern as the LI.FI loop): a routine
        // backend deploy must not kill live tracking permanently — stretch
        // the retries up to the cap instead of burning every strike at the
        // flat interval.
        const backoff = Math.min(
          AGGREGATOR_TRANSIENT_BACKOFF_CAP_MS,
          pollingInterval * Math.pow(1.5, consecutiveTransientFailures),
        );
        await this.delay(backoff, abortSignal);
        continue;
      }

      consecutiveTransientFailures = 0;
      const response = result.response;
      lastObservedStatus = response.status;

      this.updateAggregatorTrackingState(trackingState, response, defaultBridgingDescription);
      safeNotify(trackingState);

      if (response.status === 'success') {
        trackingState.isTracking = false;
        safeNotify(trackingState);
        return { kind: 'success', response };
      }

      if (response.status === 'partial_success') {
        trackingState.isTracking = false;
        safeNotify(trackingState);
        return { kind: 'partial', response, reason: PARTIAL_SUCCESS_REASON };
      }

      // Defensive: the dispatcher says this state is terminal, but it isn't
      // one of the finals handled above and isn't a known keep-polling
      // status either — a newer backend than this client. Polling can't
      // change a final verdict; stop and let the caller fall back to the
      // honest untracked-bridge UX instead of spinning to the attempt cap.
      if (response.is_final && !KNOWN_NON_FINAL_STATUSES.has(response.status)) {
        trackingState.isTracking = false;
        return { kind: 'gave_up', lastObservedStatus };
      }

      await this.delay(pollingInterval, abortSignal);
    }

    // Hard cap reached while still pending. Same indeterminate treatment as
    // the LI.FI timeout: the transfer may yet land, so surface an honest
    // banner and let the caller keep 'confirming' / history keep 'pending'.
    trackingState.isTracking = false;
    trackingState.error = trackingState.trackingUrl
      ? 'Tracking timed out — the transfer is still in progress. Follow the tracker link for the latest state.'
      : 'Tracking timed out — the transfer is still in progress. Check the destination explorer before re-trying.';
    safeNotify(trackingState);
    return { kind: 'timeout', lastObservedStatus };
  }

  /**
   * If the tab is currently hidden, await `visibilitychange` instead of
   * burning quota. Resolves immediately when the user comes back — or when
   * the abort signal fires (a destroyed caller must not stay pinned behind
   * a hidden tab; the loop re-checks `aborted` right after).
   */
  private waitWhileHidden(abortSignal?: AbortSignal): Promise<void> {
    if (typeof document === 'undefined' || !document.hidden || abortSignal?.aborted) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const cleanup = (): void => {
        document.removeEventListener('visibilitychange', onVis);
        abortSignal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onVis = (): void => {
        if (!document.hidden) cleanup();
      };
      const onAbort = (): void => cleanup();
      document.addEventListener('visibilitychange', onVis);
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Get user-friendly status message
   */
  getStatusMessage(status: LifiStatusResponse): string {
    const { status: txStatus, substatus, substatusMessage } = status;

    if (substatusMessage) return substatusMessage;

    switch (txStatus) {
      case 'NOT_FOUND':
        return 'Waiting for transaction to be indexed…';
      case 'PENDING':
        switch (substatus) {
          case 'WAIT_SOURCE_CONFIRMATIONS':
            return 'Waiting for source chain confirmations…';
          case 'WAIT_DESTINATION_TRANSACTION':
            return 'Waiting for destination chain transaction…';
          case 'BRIDGE_NOT_AVAILABLE':
            return 'Bridge temporarily unavailable, please wait…';
          case 'REFUND_IN_PROGRESS':
            return 'Refund in progress…';
          default:
            return 'Transaction in progress…';
        }
      case 'DONE':
        if (substatus === 'PARTIAL') {
          return 'Transfer partially completed with alternative tokens';
        }
        if (substatus === 'REFUNDED') {
          return 'Transfer refunded';
        }
        return 'Transaction completed successfully!';
      case 'FAILED':
        switch (substatus) {
          case 'OUT_OF_GAS':
            return 'Transaction failed: out of gas';
          case 'SLIPPAGE_EXCEEDED':
            return 'Transaction failed: slippage exceeded';
          case 'NOT_PROCESSABLE_REFUND_NEEDED':
            return 'Transaction cannot be completed, refund needed';
          default:
            return 'Transaction failed';
        }
      default:
        return 'Unknown status';
    }
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  private buildSteps(
    isCrossChain: boolean,
    fromChain: number,
    toChain: number
  ): TransactionStep[] {
    const fromChainName = this.chainService.getChainName(fromChain);
    const toChainName = this.chainService.getChainName(toChain);

    if (isCrossChain) {
      return [
        {
          id: 'source-confirm',
          title: 'Confirming on ' + fromChainName,
          description: 'Waiting for source chain confirmations',
          status: 'pending',
        },
        {
          id: 'bridging',
          title: 'Bridging tokens',
          description: `Transferring from ${fromChainName} to ${toChainName}`,
          status: 'pending',
        },
        {
          id: 'dest-confirm',
          title: 'Receiving on ' + toChainName,
          description: 'Waiting for destination transaction',
          status: 'pending',
        },
        {
          id: 'complete',
          title: 'Complete',
          description: 'Tokens received',
          status: 'pending',
        },
      ];
    } else {
      return [
        {
          id: 'confirming',
          title: 'Confirming swap',
          description: 'Transaction being confirmed on ' + fromChainName,
          status: 'pending',
        },
        {
          id: 'complete',
          title: 'Complete',
          description: 'Swap successful',
          status: 'pending',
        },
      ];
    }
  }

  private updateTrackingState(
    state: TransactionTrackingState,
    status: LifiStatusResponse,
    fromChain: number,
    toChain: number
  ): void {
    const { status: txStatus, substatus } = status;
    const isCrossChain = fromChain !== toChain;

    if (txStatus === 'NOT_FOUND') {
      state.steps[0].status = 'in_progress';
      state.currentStep = 0;
      state.progress = 5;
      return;
    }

    if (txStatus === 'PENDING') {
      if (isCrossChain) {
        switch (substatus) {
          case 'WAIT_SOURCE_CONFIRMATIONS':
            state.steps[0].status = 'in_progress';
            state.currentStep = 0;
            state.progress = 20;
            state.estimatedTimeRemaining = 150;
            break;

          case 'WAIT_DESTINATION_TRANSACTION':
            state.steps[0].status = 'completed';
            state.steps[1].status = 'completed';
            state.steps[2].status = 'in_progress';
            state.currentStep = 2;
            state.progress = 70;
            state.estimatedTimeRemaining = 60;
            break;

          default:
            state.steps[0].status = 'completed';
            state.steps[1].status = 'in_progress';
            state.currentStep = 1;
            state.progress = 45;
            state.estimatedTimeRemaining = 90;
        }
      } else {
        state.steps[0].status = 'in_progress';
        state.currentStep = 0;
        state.progress = 50;
        state.estimatedTimeRemaining = 15;
      }
      return;
    }

    if (txStatus === 'DONE') {
      state.steps.forEach((step) => (step.status = 'completed'));
      state.currentStep = state.steps.length - 1;
      state.progress = 100;
      state.estimatedTimeRemaining = 0;

      // Explorer links are built LOCALLY from the tx hash + the chain ids
      // this swap was started with — never from the upstream `txLink`. The
      // status API is an external service; rendering its URLs verbatim as
      // clickable links would let a compromised (or spoofed) response point
      // the user at a phishing "explorer".
      if (status.sending?.txHash) {
        state.steps[0].explorerLink = getExplorerTxUrl(fromChain, status.sending.txHash);
        state.steps[0].txHash = status.sending.txHash;
      }
      if (status.receiving?.txHash && isCrossChain) {
        const lastStep = state.steps[state.steps.length - 2];
        if (lastStep) {
          lastStep.explorerLink = getExplorerTxUrl(toChain, status.receiving.txHash);
          lastStep.txHash = status.receiving.txHash;
        }
      }
      return;
    }

    if (txStatus === 'FAILED') {
      const currentStep = state.steps.find((s) => s.status === 'in_progress');
      if (currentStep) {
        currentStep.status = 'failed';
      } else {
        state.steps[0].status = 'failed';
      }
      state.error = status.substatusMessage || 'Transaction failed';
      state.estimatedTimeRemaining = 0;
    }
  }

  /**
   * Map a /swap/status response onto the shared cross-chain step layout
   * ([source-confirm, bridging, dest-confirm, complete]). Non-final warning
   * states (needs_gas / refunding) keep the bridging step `in_progress` and
   * carry their copy in its description — the swap screen renders step
   * descriptions verbatim, so no extra UI channel is needed.
   */
  private updateAggregatorTrackingState(
    state: TransactionTrackingState,
    response: SwapStatusResponse,
    defaultBridgingDescription?: string,
  ): void {
    const bridging = state.steps[1];

    // The dispatcher's tracker link (Squid: Axelarscan) follows the transfer
    // end-to-end — surface it as soon as the backend knows it. The URL can't
    // be rebuilt locally (per-aggregator tracker hosts), so it's scheme- AND
    // host-checked instead: only https links to allowlisted tracker domains
    // render, never javascript:/data: or a phishing host smuggled through a
    // compromised upstream.
    const trackingUrl = sanitizeHttpsUrl(response.tracking_url);
    if (trackingUrl) {
      state.trackingUrl = trackingUrl;
      if (bridging) {
        bridging.explorerLink = trackingUrl;
      }
    }

    switch (response.status) {
      case 'not_found':
      case 'pending':
        // not_found right after submission is the indexer lagging the
        // source tx — visually identical to pending. Restore the default
        // copy in case a needs_gas/refunding warning preceded this poll.
        if (bridging) {
          bridging.description = defaultBridgingDescription;
        }
        // Those warning states also cleared the ETA — bring back the
        // default so the "~Xm remaining" chip returns with the recovery.
        if (state.estimatedTimeRemaining === undefined) {
          state.estimatedTimeRemaining = AGGREGATOR_DEFAULT_ETA_SECONDS;
        }
        state.currentStep = 1;
        state.progress = Math.max(state.progress, AGGREGATOR_BRIDGING_PROGRESS);
        break;

      case 'needs_gas':
        // Non-final warning: transfer is stuck on the destination chain
        // until someone tops up gas. Keep polling — bridges usually
        // self-recover or the refund path kicks in.
        if (bridging) {
          bridging.description =
            'Transfer is stuck — it needs extra gas on the destination chain. This usually resolves on its own; contact support if it stays stuck.';
        }
        state.currentStep = 1;
        state.estimatedTimeRemaining = undefined;
        break;

      case 'refunding':
        if (bridging) {
          bridging.description =
            'Refund in progress — your tokens are being returned on the source chain.';
        }
        state.currentStep = 1;
        state.estimatedTimeRemaining = undefined;
        break;

      case 'success':
        state.steps.forEach((step) => (step.status = 'completed'));
        state.currentStep = state.steps.length - 1;
        state.progress = 100;
        state.estimatedTimeRemaining = 0;
        break;

      case 'partial_success': {
        // Presented as a failure-with-explanation: the quoted token was NOT
        // delivered (a fallback token of equivalent value was). See
        // PARTIAL_SUCCESS_REASON for the deliberate divergence from the
        // LI.FI PARTIAL path, which presents success.
        const inProgress = state.steps.find((s) => s.status === 'in_progress');
        if (inProgress) {
          inProgress.status = 'failed';
        } else if (bridging) {
          bridging.status = 'failed';
        }
        state.error = PARTIAL_SUCCESS_REASON;
        state.estimatedTimeRemaining = 0;
        break;
      }
    }
  }

  /**
   * Abortable sleep — resolves (never rejects) early when the signal fires,
   * so an up-to-30 s backoff can't keep a destroyed caller alive; the
   * polling loop re-checks `aborted` at the top of the next iteration.
   */
  private delay(ms: number, abortSignal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (abortSignal?.aborted) {
        resolve();
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        abortSignal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
