/**
 * =============================================================================
 * TRANSACTION REHYDRATION SERVICE
 * =============================================================================
 *
 * On app start (and on wallet switch), walk every history record stuck in
 * `pending` and try to resolve it against the chain. Without this, a user
 * who refreshes the tab mid-swap has a record that stays "pending" forever
 * even though the tx has long since landed (or failed) on-chain.
 *
 * Resolution strategy per record:
 *   - **Send / same-chain swap** — pull the receipt via the public-RPC
 *     fallback util. status === 1 → markSuccess, status === 0 → markFailed.
 *   - **Cross-chain swap** — ask the aggregator that produced the quote:
 *     • LI.FI (or no/legacy aggregator tag) → LI.FI Status API via the
 *       tracker. DONE → markSuccess, FAILED → markFailed.
 *     • any other recognized aggregator (Squid …) → backend /swap/status
 *       dispatcher. success → markSuccess; partial_success → markFailed
 *       (a fallback token was delivered, NOT the quoted one); refunding /
 *       needs_gas → stay pending but annotate so the 60-minute
 *       stale-pending normalization presents the record honestly.
 *     PENDING / not_found / unsupported / transient → leave as pending and
 *     try again next session.
 *
 * Routing on `tx.aggregator` matters: before this, every cross-chain record
 * was sent to LI.FI's Status API regardless of which aggregator actually
 * bridged it. A Squid tx hash is unknown to LI.FI, so it returned NOT_FOUND
 * forever — a refunded or partial-delivery Squid swap then silently aged
 * into a "delivered" verdict via stale-pending normalization.
 *
 * Best-effort: any individual lookup failure is swallowed so a single dead
 * RPC / upstream doesn't block re-hydration of the rest of the list.
 *
 * Besides the app-start / wallet-switch passes, the history UI can trigger a
 * throttled on-demand pass via `rehydratePendingNow()` — records that missed
 * their live tracking window would otherwise stay "pending" until a full
 * page reload.
 *
 * @author Orion DEX Team
 * @version 1.2.0 — throttled `rehydratePendingNow()` entry point + public
 *                  `isRechecking` signal for the history panel.
 */

import { Injectable, inject, signal } from '@angular/core';
import { TransactionHistoryService, TransactionRecord } from './transaction-history.service';
import { TransactionTrackerService, PARTIAL_SUCCESS_REASON } from './swap/transaction-tracker.service';
import { AggregatorService } from './swap/aggregator.service';
import type { AggregatorName } from '../models/swap.model';
import { fetchReceiptWithFallback } from '../utils/fetch-receipt';

/** All backend-recognized aggregator names, for the runtime tag guard. */
const AGGREGATOR_NAMES: readonly AggregatorName[] = [
  'zerox',
  'paraswap',
  'odos',
  'lifi',
  'squid',
];

/** Narrow a persisted, free-form `aggregator` tag to a known AggregatorName. */
function isAggregatorName(value: string | undefined): value is AggregatorName {
  return value !== undefined && (AGGREGATOR_NAMES as readonly string[]).includes(value);
}

/**
 * Minimum gap between on-demand re-check passes. Opening/closing the history
 * panel repeatedly must not hammer public RPCs and bridge-status APIs.
 */
const RECHECK_COOLDOWN_MS = 30_000;

@Injectable({
  providedIn: 'root',
})
export class TransactionRehydrationService {
  private history = inject(TransactionHistoryService);
  private tracker = inject(TransactionTrackerService);
  private aggregatorService = inject(AggregatorService);

  /** Per-tx-hash guard so we don't spam the chain for the same record twice. */
  private inflight = new Set<string>();

  // ---------------------------------------------------------------------------
  // On-demand re-check (history panel)
  // ---------------------------------------------------------------------------

  /** In-flight on-demand pass — concurrent callers collapse onto it. */
  private recheckInflight: Promise<void> | null = null;

  /** When the last on-demand pass finished, for the cooldown gate. */
  private lastRecheckFinishedAt = 0;

  private readonly _isRechecking = signal(false);

  /** True while an on-demand pass runs — drives the panel's "checking" hint. */
  readonly isRechecking = this._isRechecking.asReadonly();

  /**
   * UI entry point: re-run the resolve-pending pass on demand (history panel
   * becoming visible). Same resolution logic as the startup pass — this only
   * adds throttling: concurrent calls collapse onto the running pass, and
   * calls within RECHECK_COOLDOWN_MS of the last finished pass are no-ops.
   *
   * Best-effort by design: failures are swallowed (console.debug at most)
   * and the records simply stay pending until the next opportunity.
   */
  rehydratePendingNow(): Promise<void> {
    if (this.recheckInflight) return this.recheckInflight;
    if (Date.now() - this.lastRecheckFinishedAt < RECHECK_COOLDOWN_MS) {
      return Promise.resolve();
    }

    this._isRechecking.set(true);
    this.recheckInflight = this.rehydratePendingForCurrentWallet()
      .catch((err) => {
        // Quiet on purpose — a failed refresh must never toast; the records
        // stay pending and the next panel open / app start retries.
        console.debug('[Rehydrate] on-demand re-check failed', err);
      })
      .finally(() => {
        this.lastRecheckFinishedAt = Date.now();
        this.recheckInflight = null;
        this._isRechecking.set(false);
      });
    return this.recheckInflight;
  }

  // ---------------------------------------------------------------------------
  // Resolution passes (startup / wallet switch — also reused by the re-check)
  // ---------------------------------------------------------------------------

  /**
   * Resolve every pending record currently loaded for the active wallet.
   * Idempotent — safe to call on every wallet change.
   */
  async rehydratePendingForCurrentWallet(): Promise<void> {
    const candidates = this.history
      .pendingTransactions()
      .filter((tx) => !!tx.txHash);

    await Promise.all(candidates.map((tx) => this.resolveOne(tx)));
  }

  private async resolveOne(tx: TransactionRecord): Promise<void> {
    if (!tx.txHash) return;
    if (this.inflight.has(tx.txHash)) return;
    this.inflight.add(tx.txHash);

    try {
      if (this.isCrossChainSwap(tx)) {
        await this.resolveCrossChain(tx);
      } else {
        await this.resolveOnChain(tx);
      }
    } catch (err) {
      console.warn('[Rehydrate] failed for', tx.txHash, err);
    } finally {
      this.inflight.delete(tx.txHash);
    }
  }

  private isCrossChainSwap(tx: TransactionRecord): boolean {
    return (
      tx.type === 'swap' &&
      !!tx.fromToken &&
      !!tx.toToken &&
      tx.fromToken.chainId !== tx.toToken.chainId
    );
  }

  /**
   * Same-chain swap or send: a single receipt on the source chain is the
   * full story. Use the wallet-less helper so re-hydration works even when
   * the user is logged out / on a different chain than the record.
   */
  private async resolveOnChain(tx: TransactionRecord): Promise<void> {
    const receipt = await fetchReceiptWithFallback(null, tx.txHash!, tx.chainId, 15_000);
    if (!receipt) return;
    if (receipt.status === 1) {
      this.history.markSuccess(tx.id, tx.txHash);
    } else if (receipt.status === 0) {
      this.history.markFailed(tx.id, "Couldn't complete on the network");
    }
  }

  /**
   * Cross-chain swap: a source-chain receipt only proves the user's tokens
   * left the source chain. We need the bridge's verdict on destination
   * delivery — and which API holds it depends on who bridged the swap.
   *
   * A Squid (or any non-LI.FI) tx hash is meaningless to LI.FI's Status API,
   * so those records MUST go to the backend /swap/status dispatcher instead.
   * LI.FI and legacy/untagged records keep the original LI.FI path.
   */
  private async resolveCrossChain(tx: TransactionRecord): Promise<void> {
    if (isAggregatorName(tx.aggregator) && tx.aggregator !== 'lifi') {
      await this.resolveCrossChainViaBackend(tx, tx.aggregator);
      return;
    }
    await this.resolveCrossChainViaLifi(tx);
  }

  /** LI.FI Status API verdict (legacy and lifi-tagged cross-chain records). */
  private async resolveCrossChainViaLifi(tx: TransactionRecord): Promise<void> {
    const status = await this.tracker.getTransactionStatus(tx.txHash!, tx.chainId);
    if (!status) return;

    if (status.status === 'DONE') {
      this.history.markSuccess(tx.id, tx.txHash);
    } else if (status.status === 'FAILED') {
      this.history.markFailed(tx.id, status.substatusMessage || 'Bridge failed');
    }
    // PENDING / NOT_FOUND → leave as-is; will retry next visit.
  }

  /**
   * Backend /swap/status dispatcher verdict for non-LI.FI aggregators (Squid).
   * Mirrors the live tracker's mapping so a rehydrated record reads exactly
   * like one that was tracked in-session:
   *   - success         → delivered.
   *   - partial_success → FAILED: a fallback token (not the quoted one) was
   *                       delivered; never present that as a clean success.
   *   - refunding       → stay pending, annotate so stale-pending
   *                       normalization later presents it as failed.
   *   - needs_gas       → stay pending, annotate (terminal state unknowable).
   *   - pending / not_found / unsupported / transient → leave; retry later.
   */
  private async resolveCrossChainViaBackend(
    tx: TransactionRecord,
    aggregator: AggregatorName,
  ): Promise<void> {
    // `isCrossChainSwap` already guaranteed both token legs exist.
    const result = await this.aggregatorService.getSwapStatus({
      aggregator,
      transactionId: tx.txHash!,
      fromChainId: tx.fromToken!.chainId,
      toChainId: tx.toToken!.chainId,
      quoteId: tx.trackingQuoteId,
      requestId: tx.trackingRequestId,
    });

    if (result.kind !== 'ok') return; // unsupported / transient → retry later.

    switch (result.response.status) {
      case 'success':
        this.history.markSuccess(tx.id, tx.txHash);
        break;
      case 'partial_success':
        this.history.markFailed(tx.id, PARTIAL_SUCCESS_REASON);
        break;
      case 'refunding':
        this.history.updateTransaction(tx.id, {
          bridgeAnnotation: 'refunding',
          errorMessage:
            'A refund was in progress for this swap — check your source-chain wallet.',
        });
        break;
      case 'needs_gas':
        this.history.updateTransaction(tx.id, {
          bridgeAnnotation: 'needs_gas',
          errorMessage:
            'The transfer is waiting for extra destination gas — check the transfer tracker or destination explorer.',
        });
        break;
      // 'pending' / 'not_found' → leave as-is; will retry next visit.
    }
  }
}
