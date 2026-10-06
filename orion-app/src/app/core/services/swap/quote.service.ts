/**
 * =============================================================================
 * QUOTE SERVICE
 * =============================================================================
 *
 * Orchestrates quote retrieval. Primary path: backend multi-aggregator API
 * (via AggregatorService). Fallback: LI.FI SDK direct call.
 *
 * @author Orion DEX Team
 * @version 3.1.0
 */
import { Injectable, inject, signal } from '@angular/core';
import { getQuote } from '@lifi/sdk';
import type { QuoteRequest } from '@lifi/sdk';
import { parseUnits, formatUnits } from 'ethers';
import { Token } from '../../models/token.model';
import { SwapQuote, LifiRouteData, AggregatorQuote } from '../../models/swap.model';
import { WalletService } from '../wallet.service';
import { AggregatorService } from './aggregator.service';
import { GasService } from './gas.service';
import { environment } from '../../../../environments/environment';

/**
 * Outcome of `refreshQuoteBeforeExecute()`.
 * - `quote`: the fresh quote (or the original if no refresh was possible).
 * - `approvalAddressChanged`: the aggregator picked a different spender — user
 *   must re-approve before the swap is safe.
 * - `priceChanged`: the destination amount moved between quotes; caller may
 *   want to confirm with the user.
 * - `refreshed`: whether a silent re-quote actually ran. False means either
 *   no backend data was available (legacy LI.FI SDK path) or the network
 *   call failed — see `networkError` to distinguish.
 * - `networkError`: the backend was unreachable / errored / returned an empty
 *   response on a quote that *does* carry aggregator data. Caller MUST treat
 *   this as a blocker: the original calldata may be stale and a different
 *   `approvalAddress` could mean the swap reverts on-chain.
 */
export interface SilentReQuoteResult {
  quote: SwapQuote;
  approvalAddressChanged: boolean;
  priceChanged: boolean;
  refreshed: boolean;
  networkError: boolean;
}

/**
 * Provenance-tagged minimum-received value.
 * - `enforced`: the aggregator reported the post-slippage floor its calldata
 *   actually enforces on-chain (`to_amount_min`) — an honest guarantee.
 * - `estimated`: client-side toAmount×(1−slippage) — a guide, not a floor
 *   the contract checks. UI copy must not claim the swap "cancels itself"
 *   for estimated values.
 */
export interface MinimumReceivedSelection {
  value: string;
  source: 'enforced' | 'estimated';
}

/**
 * Pick the honest minimum-received for a backend aggregator quote. Prefers
 * the aggregator-enforced floor (`to_amount_min`, raw token units) and falls
 * back to the client-side estimate when it's absent (ODOS deliberately sends
 * none — its API gives the output amounts no post-slippage semantics),
 * unparseable, non-positive, or nonsensically above the quoted output.
 *
 * Pure and exported so specs run without TestBed (pulling the wallet DI
 * graph into Karma breaks the run — see project memory on PrivyWrapper).
 */
export function selectMinimumReceived(
  toAmountMinRaw: string | undefined,
  toAmountFormatted: string,
  slippage: number,
  toTokenDecimals: number,
): MinimumReceivedSelection {
  const toAmountNum = parseFloat(toAmountFormatted);
  if (toAmountMinRaw) {
    try {
      const formatted = formatUnits(toAmountMinRaw, toTokenDecimals);
      const min = parseFloat(formatted);
      if (
        Number.isFinite(min) &&
        min > 0 &&
        (!Number.isFinite(toAmountNum) || min <= toAmountNum)
      ) {
        return { value: formatted, source: 'enforced' };
      }
    } catch {
      // Garbage raw value — fall through to the client-side estimate.
    }
  }
  const safeToAmount = Number.isFinite(toAmountNum) ? toAmountNum : 0;
  return {
    value: (safeToAmount * (1 - slippage / 100)).toFixed(toTokenDecimals > 6 ? 6 : toTokenDecimals),
    source: 'estimated',
  };
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Quote cache TTL in milliseconds (30 seconds) */
const QUOTE_CACHE_TTL = 30000;

/** Minimum delay between quote requests (500ms) */
const MIN_QUOTE_DELAY = 500;

/** Maximum retry attempts */
const MAX_QUOTE_RETRIES = 3;

/** Base delay for exponential backoff */
const RETRY_BASE_DELAY = 1000;

// =============================================================================
// INTERFACES
// =============================================================================

interface CachedQuote {
  quote: SwapQuote;
  timestamp: number;
  lifiQuote: unknown;
}

// =============================================================================
// QUOTE SERVICE
// =============================================================================

@Injectable({
  providedIn: 'root',
})
export class QuoteService {
  private walletService = inject(WalletService);
  private aggregatorService = inject(AggregatorService);
  private gasService = inject(GasService);

  /** Whether the last quote came from the backend aggregator API */
  readonly usingBackendAggregator = signal(false);

  /** Quote cache: key = "chainId-fromToken-toToken-amount-slippage" */
  private quoteCache = new Map<string, CachedQuote>();

  /** Rate limiting: track last quote request timestamp */
  private lastQuoteRequestTime = 0;

  /** Pending quote request for deduplication */
  private pendingQuoteRequest: Promise<SwapQuote | null> | null = null;
  private pendingQuoteKey: string | null = null;

  // ---------------------------------------------------------------------------
  // Public Methods
  // ---------------------------------------------------------------------------

  /**
   * Get a swap quote with caching, rate limiting, and retry logic.
   *
   * Strategy:
   * 1. Try backend multi-aggregator API first (best price from 5 aggregators)
   * 2. If backend fails → fallback to direct LI.FI SDK call
   */
  async getQuote(
    fromToken: Token,
    toToken: Token,
    amount: string,
    slippage: number = 0.5,
    skipCache: boolean = false
  ): Promise<SwapQuote | null> {
    const address = this.walletService.address();
    if (!address) {
      console.error('[Quote] Wallet not connected');
      return null;
    }

    const cacheKey = this.getCacheKey(fromToken, toToken, amount, slippage);

    // Check cache first
    if (!skipCache) {
      const cached = this.getCachedQuote(cacheKey);
      if (cached) return cached;
    } else {
      this.quoteCache.delete(cacheKey);
    }

    // Request deduplication
    if (this.pendingQuoteKey === cacheKey && this.pendingQuoteRequest) {
      return this.pendingQuoteRequest;
    }

    this.pendingQuoteKey = cacheKey;
    this.pendingQuoteRequest = this.fetchWithRetry(fromToken, toToken, amount, slippage, cacheKey, address);

    try {
      return await this.pendingQuoteRequest;
    } finally {
      this.pendingQuoteKey = null;
      this.pendingQuoteRequest = null;
    }
  }

  /**
   * Clear all cached quotes
   */
  clearCache(): void {
    this.quoteCache.clear();
  }

  /**
   * Silent re-quote right before `executeSwap()`.
   *
   * Why: between `getQuote()` and the user clicking "Swap", the backend may
   * reshuffle aggregators — the new winner could expose a different
   * `approvalAddress`, in which case the existing ERC-20 allowance points at
   * the wrong spender and the swap reverts. Price can also move.
   *
   * This method only does an actual network call for backend-aggregator
   * quotes. Legacy LI.FI SDK quotes have no refresh endpoint, so we signal
   * `refreshed: false` and the caller proceeds with the original quote.
   */
  async refreshQuoteBeforeExecute(quote: SwapQuote): Promise<SilentReQuoteResult> {
    // Legacy LI.FI SDK path has no /refresh-quote endpoint — proceed with
    // the cached quote. Not a network error, just nothing to refresh.
    if (!quote._aggregatorData || !quote.aggregator) {
      return { quote, approvalAddressChanged: false, priceChanged: false, refreshed: false, networkError: false };
    }

    const address = this.walletService.address();
    if (!address) {
      return { quote, approvalAddressChanged: false, priceChanged: false, refreshed: false, networkError: false };
    }

    let response: Awaited<ReturnType<typeof this.aggregatorService.refreshQuote>> | null = null;
    try {
      response = await this.aggregatorService.refreshQuote(
        quote.aggregator,
        quote.fromToken,
        quote.toToken,
        quote.fromAmount,
        address,
        quote.slippage,
        {
          toAmount: quote._aggregatorData.to_amount,
          approvalAddress: quote._aggregatorData.approval_address,
        },
      );
    } catch (err) {
      console.warn('[Quote] refreshQuoteBeforeExecute network error:', (err as Error)?.message);
      return { quote, approvalAddressChanged: false, priceChanged: false, refreshed: false, networkError: true };
    }

    if (!response?.quote) {
      // Backend reachable but returned no quote — could be transient
      // route-not-found, could be a misbehaving response. Treat as network
      // error so the caller blocks instead of silently using stale calldata.
      return { quote, approvalAddressChanged: false, priceChanged: false, refreshed: false, networkError: true };
    }

    // Local comparison kept as defense-in-depth, OR-ed with the backend's
    // verdict. The backend computes the change flags only when
    // `previous_to_amount` / `previous_approval_address` are supplied and
    // omits them otherwise — an absent/false backend flag must never
    // suppress local detection, while a backend `true` is always honored.
    const oldApprovalAddress = quote._aggregatorData.approval_address?.toLowerCase();
    const newApprovalAddress = response.quote.approval_address?.toLowerCase();
    const localApprovalAddressChanged = Boolean(
      oldApprovalAddress && newApprovalAddress && oldApprovalAddress !== newApprovalAddress
    );
    const approvalAddressChanged =
      Boolean(response.approval_address_changed) || localApprovalAddressChanged;

    const gasCostUSD = await this.estimateGasCostUSD(
      quote.fromToken.chainId,
      response.quote.estimated_gas,
    );

    const refreshedQuote = this.mapAggregatorQuoteToSwapQuote(
      response.quote,
      quote.fromToken,
      quote.toToken,
      quote.fromAmount,
      quote.slippage,
      gasCostUSD,
    );

    // Numeric comparison — formatted decimal strings can differ in trailing
    // zeros ("1.50" vs "1.5") without an actual price move. Fall back to the
    // strict string comparison only if either side isn't parseable.
    const oldToAmountNum = parseFloat(quote.toAmount);
    const newToAmountNum = parseFloat(refreshedQuote.toAmount);
    const localPriceChanged =
      Number.isFinite(oldToAmountNum) && Number.isFinite(newToAmountNum)
        ? oldToAmountNum !== newToAmountNum
        : refreshedQuote.toAmount !== quote.toAmount;
    const priceChanged = Boolean(response.price_changed) || localPriceChanged;

    return {
      quote: refreshedQuote,
      approvalAddressChanged,
      priceChanged,
      refreshed: true,
      networkError: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: Orchestration
  // ---------------------------------------------------------------------------

  private async fetchWithRetry(
    fromToken: Token,
    toToken: Token,
    amount: string,
    slippage: number,
    cacheKey: string,
    address: string,
  ): Promise<SwapQuote | null> {
    // ── Step 1: Try backend aggregator API ──────────────────────────────────
    try {
      await this.enforceRateLimit();

      const backendResponse = await this.aggregatorService.getBestQuote(
        fromToken,
        toToken,
        amount,
        address,
        slippage,
      );

      if (backendResponse?.best_quote) {
        this.usingBackendAggregator.set(true);

        // Gas price lives on the source chain — fetch once per quote so the
        // Network-fee cell has real USD instead of '0'. Non-blocking failure
        // keeps the backend path working even if RPC hiccups.
        const gasCostUSD = await this.estimateGasCostUSD(
          fromToken.chainId,
          backendResponse.best_quote.estimated_gas,
        );

        const swapQuote = this.mapAggregatorQuoteToSwapQuote(
          backendResponse.best_quote,
          fromToken,
          toToken,
          amount,
          slippage,
          gasCostUSD,
        );

        this.cacheQuote(cacheKey, swapQuote, null);
        return swapQuote;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[Quote] Backend aggregator failed, falling back to LI.FI SDK:', message);
    }

    // ── Step 2: Fallback to LI.FI SDK ───────────────────────────────────────
    this.usingBackendAggregator.set(false);
    return this.fetchLifiQuoteWithRetry(fromToken, toToken, amount, slippage, cacheKey, address);
  }

  // ---------------------------------------------------------------------------
  // Private: Backend Aggregator → SwapQuote Mapping
  // ---------------------------------------------------------------------------

  private mapAggregatorQuoteToSwapQuote(
    aggQuote: AggregatorQuote,
    fromToken: Token,
    toToken: Token,
    fromAmount: string,
    slippage: number,
    gasCostUSD: string,
  ): SwapQuote {
    const toAmountFormatted = this.formatAmount(aggQuote.to_amount, toToken.decimals);
    // Honest floor: prefer the aggregator-enforced post-slippage minimum
    // (to_amount_min) over the client-side estimate — see
    // selectMinimumReceived for the fallback rules (ODOS sends none).
    const minimumReceived = selectMinimumReceived(
      aggQuote.to_amount_min,
      toAmountFormatted,
      slippage,
      toToken.decimals,
    ).value;

    // Cross-chain paths (Squid / LI.FI bridge) take minutes, not seconds.
    const isCrossChain = fromToken.chainId !== toToken.chainId;

    // USD values: backend ≥0.0.14 sends adapter-priced from/to_amount_usd.
    // Fall back to token-list priceUSD so the review screen and the $1k
    // high-value gate never silently run on '0'.
    const fromAmountUSD =
      this.normalizeUsd(aggQuote.from_amount_usd) ??
      this.usdFromTokenPrice(fromAmount, fromToken) ??
      '0';
    const toAmountUSD =
      this.normalizeUsd(aggQuote.to_amount_usd) ??
      this.usdFromTokenPrice(toAmountFormatted, toToken) ??
      '0';

    return {
      id: `agg-${aggQuote.aggregator}-${aggQuote.quoted_at}`,
      fromToken,
      toToken,
      fromAmount,
      toAmount: toAmountFormatted,
      fromAmountUSD,
      toAmountUSD,
      exchangeRate: this.calculateExchangeRate(
        fromAmount,
        toAmountFormatted,
        fromToken.symbol,
        toToken.symbol,
      ),
      priceImpact: this.computePriceImpact(fromAmountUSD, toAmountUSD),
      gasCost: aggQuote.estimated_gas || '0',
      gasCostUSD,
      estimatedTime: isCrossChain ? 600 : 30,
      route: [{
        protocol: this.getAggregatorDisplayName(aggQuote.aggregator),
        fromToken,
        toToken,
        percentage: 100,
      }],
      slippage,
      minimumReceived,
      createdAt: Date.now(),
      _aggregatorData: aggQuote,
      aggregator: aggQuote.aggregator,
    };
  }

  /**
   * Estimate gas cost in USD from the aggregator's `estimated_gas` hint.
   * `gasService.getGasPrice()` returns the USD cost for a 150 000-unit swap;
   * we scale by the ratio of the aggregator's estimate to that baseline.
   * Returns '' (the unknown sentinel) when the RPC is unreachable — '0'
   * rendered as "$0.00", presenting an estimation failure as a free swap.
   * Consumers (info strip, review, receipt, native-gas preflight) treat an
   * unparseable gasCostUSD as "unknown" and fail open.
   */
  private async estimateGasCostUSD(
    chainId: number,
    estimatedGasUnits: string | undefined,
  ): Promise<string> {
    try {
      const gas = await this.gasService.getGasPrice(chainId);
      if (!gas) return '';
      const units = parseInt(estimatedGasUnits || '150000', 10);
      if (!Number.isFinite(units) || units <= 0) return gas.usd;
      const ratio = units / 150000;
      return (parseFloat(gas.usd) * ratio).toFixed(2);
    } catch {
      return '';
    }
  }

  /** Returns a clean positive USD string or null (absent / zero / garbage). */
  private normalizeUsd(value: string | undefined): string | null {
    if (!value) return null;
    const n = parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
  }

  /** Best-effort USD from the token list's priceUSD (may lag live price). */
  private usdFromTokenPrice(amount: string, token: Token): string | null {
    const price = token.priceUSD ? parseFloat(token.priceUSD) : 0;
    const amt = parseFloat(amount);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(amt) || amt <= 0) return null;
    return (price * amt).toFixed(2);
  }

  /**
   * Price impact from the USD legs — what the LI.FI widget does. Returns '0'
   * when either side is unpriced (the UI hides the cell rather than claiming
   * a fake 0% on an unknown pair).
   */
  private computePriceImpact(fromUSD: string, toUSD: string): string {
    const from = parseFloat(fromUSD);
    const to = parseFloat(toUSD);
    if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0) return '0';
    const impact = ((from - to) / from) * 100;
    return impact.toFixed(2);
  }

  private getAggregatorDisplayName(agg: string): string {
    const names: Record<string, string> = {
      zerox: '0x',
      paraswap: 'ParaSwap',
      odos: 'ODOS',
      lifi: 'LI.FI',
      squid: 'Squid',
    };
    return names[agg] || agg;
  }

  // ---------------------------------------------------------------------------
  // Private: LI.FI SDK Fallback
  // ---------------------------------------------------------------------------

  private async fetchLifiQuoteWithRetry(
    fromToken: Token,
    toToken: Token,
    amount: string,
    slippage: number,
    cacheKey: string,
    address: string,
  ): Promise<SwapQuote | null> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_QUOTE_RETRIES; attempt++) {
      try {
        return await this.fetchLifiQuote(fromToken, toToken, amount, slippage, cacheKey, address);
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const errorMessage = lastError.message;

        // Don't retry business logic errors
        if (errorMessage === 'NO_LIQUIDITY' || errorMessage === 'AMOUNT_TOO_SMALL') {
          throw lastError;
        }

        console.warn(`[Quote] LI.FI attempt ${attempt}/${MAX_QUOTE_RETRIES} failed:`, errorMessage);

        if (attempt < MAX_QUOTE_RETRIES) {
          await this.delay(RETRY_BASE_DELAY * attempt);
        }
      }
    }

    throw lastError || new Error('Failed to get quote after multiple attempts');
  }

  private async fetchLifiQuote(
    fromToken: Token,
    toToken: Token,
    amount: string,
    slippage: number,
    cacheKey: string,
    address: string,
  ): Promise<SwapQuote | null> {
    await this.enforceRateLimit();

    const fromAmountWei = this.parseAmount(amount, fromToken.decimals);

    const quoteRequest: QuoteRequest = {
      fromChain: fromToken.chainId,
      toChain: toToken.chainId,
      fromToken: fromToken.address,
      toToken: toToken.address,
      fromAmount: fromAmountWei,
      fromAddress: address,
      slippage: slippage / 100,
      fee: environment.lifiFee,
    };

    const quote = await getQuote(quoteRequest);

    // Minimum received must be the server-computed floor the calldata
    // actually enforces (estimate.toAmountMin) — a hand-computed
    // toAmount*(1-slippage) can disagree with the on-chain guarantee,
    // which is exactly what the frozen-quote pattern exists to prevent.
    const minimumReceived = quote.estimate.toAmountMin
      ? this.formatAmount(quote.estimate.toAmountMin, toToken.decimals)
      : (parseFloat(this.formatAmount(quote.estimate.toAmount, toToken.decimals)) * (1 - slippage / 100)).toFixed(
          toToken.decimals > 6 ? 6 : toToken.decimals
        );

    // Calculate gas costs. Only entries with a parseable amountUSD count —
    // entries whose amountUSD is missing/unparseable used to reduce to 0
    // and render a fake "$0.00" instead of the unknown sentinel.
    const gasCosts = quote.estimate.gasCosts || [];
    const gasCostsUSD = gasCosts
      .map((gc) => parseFloat(gc.amountUSD ?? ''))
      .filter((n) => Number.isFinite(n));
    const totalGasCostUSD = gasCostsUSD.reduce((sum, n) => sum + n, 0);

    const swapQuote: SwapQuote = {
      id: quote.id || `quote-${Date.now()}`,
      fromToken,
      toToken,
      fromAmount: amount,
      toAmount: this.formatAmount(quote.estimate.toAmount, toToken.decimals),
      fromAmountUSD: quote.estimate.fromAmountUSD || '0',
      toAmountUSD: quote.estimate.toAmountUSD || '0',
      exchangeRate: this.calculateExchangeRate(
        amount,
        this.formatAmount(quote.estimate.toAmount, toToken.decimals),
        fromToken.symbol,
        toToken.symbol
      ),
      // `estimate.priceImpact` does not exist in @lifi/types — the old read
      // always yielded '0', masking bad trades on the fallback path.
      priceImpact: this.computePriceImpact(
        quote.estimate.fromAmountUSD || '0',
        quote.estimate.toAmountUSD || '0',
      ),
      gasCost: gasCosts[0]?.amount || '0',
      // No entry carried a finite amountUSD (empty gasCosts included) —
      // LI.FI sent no USD estimate; keep the unknown sentinel ('') rather
      // than a fake "$0.00". A genuine all-zero fee is indistinguishable
      // from "no estimate" here and is acceptable as unknown.
      gasCostUSD: gasCostsUSD.length > 0 ? totalGasCostUSD.toFixed(2) : '',
      estimatedTime: quote.estimate.executionDuration || 60,
      route: quote.includedSteps?.map((step) => ({
        protocol: step.toolDetails?.name || step.tool,
        protocolLogo: step.toolDetails?.logoURI,
        fromToken,
        toToken,
        percentage: 100,
      })) || [],
      slippage,
      minimumReceived,
      createdAt: Date.now(),
    };

    // Store original LI.FI quote for execution
    swapQuote._lifiRoute = quote as unknown as LifiRouteData;

    this.cacheQuote(cacheKey, swapQuote, quote);
    return swapQuote;
  }

  // ---------------------------------------------------------------------------
  // Private: Caching & Helpers
  // ---------------------------------------------------------------------------

  private getCacheKey(fromToken: Token, toToken: Token, amount: string, slippage: number): string {
    return `${fromToken.chainId}-${fromToken.address}-${toToken.chainId}-${toToken.address}-${amount}-${slippage}`;
  }

  private getCachedQuote(cacheKey: string): SwapQuote | null {
    const cached = this.quoteCache.get(cacheKey);
    if (!cached) return null;

    const age = Date.now() - cached.timestamp;
    if (age > QUOTE_CACHE_TTL) {
      this.quoteCache.delete(cacheKey);
      return null;
    }

    return cached.quote;
  }

  private cacheQuote(cacheKey: string, quote: SwapQuote, lifiQuote: unknown): void {
    this.quoteCache.set(cacheKey, {
      quote,
      timestamp: Date.now(),
      lifiQuote,
    });

    // Clean old cache entries
    if (this.quoteCache.size > 50) {
      this.cleanCache();
    }
  }

  private cleanCache(): void {
    const now = Date.now();
    for (const [key, value] of this.quoteCache.entries()) {
      if (now - value.timestamp > QUOTE_CACHE_TTL) {
        this.quoteCache.delete(key);
      }
    }
  }

  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastQuoteRequestTime;

    if (timeSinceLastRequest < MIN_QUOTE_DELAY) {
      const waitTime = MIN_QUOTE_DELAY - timeSinceLastRequest;
      await this.delay(waitTime);
    }

    this.lastQuoteRequestTime = Date.now();
  }

  private parseAmount(amount: string | number, decimals: number): string {
    const amountStr = String(amount);
    if (!amountStr || amountStr === '0') return '0';

    try {
      return parseUnits(amountStr, decimals).toString();
    } catch {
      const [whole = '0', fraction = ''] = amountStr.split('.');
      const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
      return ((whole || '0') + paddedFraction).replace(/^0+/, '') || '0';
    }
  }

  private formatAmount(amount: string, decimals: number): string {
    if (!amount || amount === '0') return '0';
    try {
      return formatUnits(amount, decimals);
    } catch {
      return '0';
    }
  }

  private calculateExchangeRate(
    fromAmount: string,
    toAmount: string,
    fromSymbol: string,
    toSymbol: string
  ): string {
    const from = parseFloat(fromAmount);
    const to = parseFloat(toAmount);
    if (from === 0) return `1 ${fromSymbol} = 0 ${toSymbol}`;
    return `1 ${fromSymbol} = ${(to / from).toFixed(4)} ${toSymbol}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
