/**
 * =============================================================================
 * AGGREGATOR SERVICE
 * =============================================================================
 *
 * HTTP client for the backend multi-aggregator swap API.
 * Queries POST /api/v1/swap/best-quote and /api/v1/swap/refresh-quote
 * which fan out to 0x, ParaSwap, ODOS, LI.FI, and Squid in parallel,
 * plus GET /api/v1/swap/status (per-aggregator bridge-status dispatcher).
 *
 * This service is consumed by QuoteService and TransactionTrackerService,
 * NOT directly by components.
 *
 * @author Orion DEX Team
 * @version 2.1.0
 */

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';
import { environment } from '../../../../environments/environment';
import {
  BestQuoteRequest,
  BestQuoteResponse,
  RefreshQuoteRequest,
  RefreshQuoteResponse,
  AggregatorQuote,
  AggregatorName,
  SwapStatusRequest,
  SwapStatusResponse,
} from '../../models/swap.model';
import { Token } from '../../models/token.model';
import { parseUnits } from 'ethers';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Timeout for backend API calls (seconds) */
const API_TIMEOUT_MS = 15_000;

// =============================================================================
// SWAP STATUS RESULT
// =============================================================================

/**
 * Outcome of a GET /swap/status call as a discriminated union — callers
 * branch on `kind` instead of unwinding thrown control flow:
 *
 * - `ok`          — normalized bridge status payload.
 * - `unsupported` — HTTP 404 (`SWAP_STATUS_UNSUPPORTED`): the backend has no
 *                   tracking for this aggregator. Permanent — fall back to
 *                   the untracked-bridge UX, don't retry.
 * - `transient`   — anything else (timeout, 503 `SWAP_STATUS_FAILED`,
 *                   network): the upstream hiccuped, safe to retry later.
 */
export type SwapStatusResult =
  | { kind: 'ok'; response: SwapStatusResponse }
  | { kind: 'unsupported' }
  | { kind: 'transient'; message: string };

// =============================================================================
// AGGREGATOR SERVICE
// =============================================================================

@Injectable({
  providedIn: 'root',
})
export class AggregatorService {
  private readonly http = inject(HttpClient);

  // ---------------------------------------------------------------------------
  // Public Methods
  // ---------------------------------------------------------------------------

  /**
   * Request the best quote from the backend multi-aggregator router.
   *
   * @returns The best aggregator quote, or null if the backend is unavailable.
   */
  async getBestQuote(
    fromToken: Token,
    toToken: Token,
    amount: string,
    senderAddress: string,
    slippage: number = 0.5,
  ): Promise<BestQuoteResponse | null> {
    const fromAmountWei = this.parseAmount(amount, fromToken.decimals);

    const body: BestQuoteRequest = {
      from_token: fromToken.address,
      to_token: toToken.address,
      amount: fromAmountWei,
      from_chain_id: fromToken.chainId,
      to_chain_id: toToken.chainId,
      sender_address: senderAddress,
      slippage: slippage / 100, // backend expects decimal (0.01 = 1%)
    };

    try {
      const response = await firstValueFrom(
        this.http
          .post<BestQuoteResponse>(`${environment.apiUrl}/swap/best-quote`, body)
          .pipe(timeout(API_TIMEOUT_MS))
      );
      return response;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[AggregatorService] best-quote failed:', message);
      return null;
    }
  }

  /**
   * Refresh a quote from a specific aggregator (silent re-quote before swap).
   *
   * @param aggregator - The aggregator that won the previous best-quote
   * @param previous - Raw to-amount (wei) and approval address of the quote
   *   being refreshed; when provided, the backend computes the
   *   price_changed / approval_address_changed flags server-side.
   * @returns Refreshed quote with change flags, or null on failure.
   */
  async refreshQuote(
    aggregator: AggregatorName,
    fromToken: Token,
    toToken: Token,
    amount: string,
    senderAddress: string,
    slippage: number = 0.5,
    previous?: { toAmount?: string; approvalAddress?: string },
  ): Promise<RefreshQuoteResponse | null> {
    const fromAmountWei = this.parseAmount(amount, fromToken.decimals);

    const body: RefreshQuoteRequest = {
      aggregator,
      from_token: fromToken.address,
      to_token: toToken.address,
      amount: fromAmountWei,
      from_chain_id: fromToken.chainId,
      to_chain_id: toToken.chainId,
      sender_address: senderAddress,
      slippage: slippage / 100,
      ...(previous?.toAmount ? { previous_to_amount: previous.toAmount } : {}),
      ...(previous?.approvalAddress ? { previous_approval_address: previous.approvalAddress } : {}),
    };

    try {
      const response = await firstValueFrom(
        this.http
          .post<RefreshQuoteResponse>(`${environment.apiUrl}/swap/refresh-quote`, body)
          .pipe(timeout(API_TIMEOUT_MS))
      );
      return response;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[AggregatorService] refresh-quote failed:', message);
      return null;
    }
  }

  /**
   * Poll the backend bridge-status dispatcher for a cross-chain swap
   * executed by a non-LI.FI aggregator (Squid).
   *
   * Never throws — the three possible outcomes are encoded in the returned
   * `SwapStatusResult` so the polling loop in TransactionTrackerService can
   * branch without try/catch control flow.
   */
  async getSwapStatus(request: SwapStatusRequest): Promise<SwapStatusResult> {
    let params = new HttpParams()
      .set('aggregator', request.aggregator)
      .set('transaction_id', request.transactionId)
      .set('from_chain_id', request.fromChainId)
      .set('to_chain_id', request.toChainId);
    if (request.quoteId) {
      params = params.set('quote_id', request.quoteId);
    }
    if (request.requestId) {
      params = params.set('request_id', request.requestId);
    }

    try {
      const response = await firstValueFrom(
        this.http
          .get<SwapStatusResponse>(`${environment.apiUrl}/swap/status`, { params })
          .pipe(timeout(API_TIMEOUT_MS))
      );
      return { kind: 'ok', response };
    } catch (error: unknown) {
      // The dispatcher reserves 404 for SWAP_STATUS_UNSUPPORTED (aggregator
      // has no tracking). Any other 404 on this route would be equally
      // permanent, so the status code alone maps to "stop asking".
      if (error instanceof HttpErrorResponse && error.status === 404) {
        return { kind: 'unsupported' };
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[AggregatorService] swap/status failed:', message);
      return { kind: 'transient', message };
    }
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Parse a human-readable amount (e.g. "1.5") into wei string.
   */
  private parseAmount(amount: string | number, decimals: number): string {
    const amountStr = String(amount);
    if (!amountStr || amountStr === '0') return '0';

    try {
      return parseUnits(amountStr, decimals).toString();
    } catch {
      // Fallback for amounts that parseUnits can't handle
      const [whole = '0', fraction = ''] = amountStr.split('.');
      const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
      return ((whole || '0') + paddedFraction).replace(/^0+/, '') || '0';
    }
  }
}
