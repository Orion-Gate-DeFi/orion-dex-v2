/**
 * LI.FI Service (Facade)
 *
 * Main entry point for LI.FI integration.
 * Delegates to specialized services for different responsibilities:
 * - QuoteService: Quote fetching and caching
 * - SwapExecutionService: Swap execution and approvals
 * - TokenDataService: Token lists and balances
 * - GasService: Gas price estimation
 * - TransactionTrackerService: Transaction status tracking
 * - ChainService: Chain utilities
 *
 * @see https://docs.li.fi/
 */
import { Injectable, inject } from '@angular/core';
import { createConfig } from '@lifi/sdk';
import { Token } from '../models/token.model';
import {
  SwapQuote,
  GasInfo,
  GasPriceLevel,
  LifiStatusResponse,
} from '../models/swap.model';
import { environment } from '../../../environments/environment';
import { AuthService } from './auth.service';

// Import specialized services
import { QuoteService, SilentReQuoteResult } from './swap/quote.service';
import { SwapExecutionService, SimulationResult } from './swap/swap-execution.service';
import { TokenDataService } from './swap/token-data.service';
import { GasService, GasPrice } from './swap/gas.service';
import { TransactionTrackerService } from './swap/transaction-tracker.service';
import { ChainService } from './swap/chain.service';

@Injectable({
  providedIn: 'root',
})
export class LifiService {
  // Inject specialized services
  private quoteService = inject(QuoteService);
  private swapExecutionService = inject(SwapExecutionService);
  private tokenDataService = inject(TokenDataService);
  private gasService = inject(GasService);
  private trackerService = inject(TransactionTrackerService);
  private chainService = inject(ChainService);
  private authService = inject(AuthService);

  private initialized = false;
  private initPromise: Promise<boolean> | null = null;

  constructor() {
    // Patch fetch — adds auth header to proxy requests
    this.patchFetchForProxy();
    // Don't call createConfig() here — it triggers getChains() which needs auth.
    // SDK is initialized lazily via ensureInitialized() on first authenticated API call.
  }

  /**
   * Initialize LI.FI SDK lazily — only when authenticated.
   * Returns false if not authenticated (callers should return empty results).
   */
  private async ensureInitialized(): Promise<boolean> {
    if (this.initialized) return true;

    // Deduplicate concurrent init calls
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize();
    try {
      return await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async doInitialize(): Promise<boolean> {
    const token = await this.authService.getAccessTokenAsync();
    if (!token) return false;

    createConfig({
      integrator: environment.lifiIntegrator,
      apiUrl: environment.lifiProxyUrl,
      // The SDK fires an authenticated getChains() on init otherwise — the
      // app has its own ChainService and executes manually, so SDK chain
      // data is one wasted proxy request per session.
      preloadChains: false,
    });

    this.initialized = true;
    return true;
  }

  /**
   * Patch global fetch to add Authorization header for proxy requests.
   *
   * Match by parsed `URL.origin` + path-prefix rather than `String#startsWith`:
   * a naive `startsWith(proxyUrl)` would ship the Bearer token to
   * `https://api.oriongate.services.attacker.com/...` if the configured proxy
   * URL ever lacked a path component. Origin-comparison fails closed.
   */
  private patchFetchForProxy(): void {
    const originalFetch = window.fetch.bind(window);
    const authService = this.authService;
    let proxyOrigin = '';
    let proxyPathPrefix = '';
    try {
      const parsed = new URL(environment.lifiProxyUrl);
      proxyOrigin = parsed.origin;
      proxyPathPrefix = parsed.pathname.replace(/\/$/, '');
    } catch {
      // Misconfigured environment.lifiProxyUrl — bail out of patching rather
      // than risk leaking tokens to whatever hostname startsWith would match.
      console.error('[LifiService] Invalid lifiProxyUrl; auth patch disabled.');
      return;
    }

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      let isProxyRequest = false;
      try {
        const parsed = new URL(url);
        isProxyRequest =
          parsed.origin === proxyOrigin &&
          (proxyPathPrefix === '' || parsed.pathname === proxyPathPrefix || parsed.pathname.startsWith(proxyPathPrefix + '/'));
      } catch {
        isProxyRequest = false;
      }

      if (isProxyRequest) {
        // Rebuild via Headers: spreading a `Headers` instance yields {} (its
        // entries aren't own-enumerable), which silently dropped Content-Type
        // and made the x-lifi-* deletes no-ops. `new Headers(...)` accepts every
        // HeadersInit shape; when `input` is a Request carrying its own headers
        // and init has none, start from those.
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );

        // Remove LI.FI SDK headers that the proxy doesn't allow via CORS
        headers.delete('x-lifi-integrator');
        headers.delete('x-lifi-sdk');

        // Add auth header if available — strip lives in getAccessTokenAsync
        const token = await authService.getAccessTokenAsync();
        if (token) {
          headers.set('Authorization', `Bearer ${token}`);
        }

        init = { ...init, headers };
      }

      return originalFetch(input, init);
    };
  }

  // ===========================================================================
  // QUOTE METHODS (delegated to QuoteService)
  // ===========================================================================

  /**
   * Get a swap quote from LI.FI
   */
  async getSwapQuote(
    fromToken: Token,
    toToken: Token,
    amount: string,
    slippage: number = 0.5,
    skipCache: boolean = false
  ): Promise<SwapQuote | null> {
    if (!await this.ensureInitialized()) return null;
    return this.quoteService.getQuote(fromToken, toToken, amount, slippage, skipCache);
  }

  /**
   * Clear quote cache
   */
  clearQuoteCache(): void {
    this.quoteService.clearCache();
  }

  /**
   * Silent re-quote before execution. Validates `approvalAddress` and
   * surfaces price drift. See QuoteService.refreshQuoteBeforeExecute for
   * the full rationale.
   */
  async refreshQuoteBeforeExecute(quote: SwapQuote): Promise<SilentReQuoteResult> {
    return this.quoteService.refreshQuoteBeforeExecute(quote);
  }

  // ===========================================================================
  // SWAP EXECUTION METHODS (delegated to SwapExecutionService)
  // ===========================================================================

  /**
   * Execute a swap transaction
   */
  async executeSwap(
    quote: SwapQuote,
    onStatusChange?: (status: 'signing' | 'pending' | 'confirming' | 'completed', hash?: string) => void,
    opts?: { skipSimulationGate?: boolean },
  ): Promise<{ hash: string; explorerUrl: string }> {
    return this.swapExecutionService.executeSwap(quote, onStatusChange, opts);
  }

  /**
   * Check if token needs approval
   */
  async checkApproval(quote: SwapQuote): Promise<{
    needsApproval: boolean;
    currentAllowance: string;
    requiredAmount: string;
    spenderAddress: string;
  }> {
    return this.swapExecutionService.checkApproval(quote);
  }

  /**
   * Approve token for swap
   */
  async approveToken(quote: SwapQuote): Promise<string> {
    return this.swapExecutionService.approveToken(quote);
  }

  /**
   * Pre-sign simulation. See `SwapExecutionService.simulateSwap`.
   */
  async simulateSwap(quote: SwapQuote): Promise<SimulationResult> {
    return this.swapExecutionService.simulateSwap(quote);
  }

  /**
   * Check if token is native (ETH, MATIC, etc.)
   */
  isNativeToken(token: Token): boolean {
    return this.swapExecutionService.isNativeToken(token);
  }

  // ===========================================================================
  // TOKEN DATA METHODS (delegated to TokenDataService)
  // ===========================================================================

  /**
   * Get tokens for a chain
   */
  async getTokensForChain(chainId: number): Promise<Token[]> {
    if (!await this.ensureInitialized()) return [];
    return this.tokenDataService.getTokensForChain(chainId);
  }

  /**
   * Get token by address
   */
  async getTokenByAddress(chainId: number, tokenAddress: string): Promise<Token | null> {
    if (!await this.ensureInitialized()) return null;
    return this.tokenDataService.getTokenByAddress(chainId, tokenAddress);
  }

  /**
   * Get portfolio balances. Failures collapse into [] — callers using this
   * cannot distinguish an empty wallet from a fetch error; use
   * `getPortfolioBalancesOrThrow` where that distinction matters.
   */
  async getPortfolioBalances(
    walletAddress: string,
    chainIds?: number[],
    opts?: { force?: boolean }
  ): Promise<Array<{
    symbol: string;
    name: string;
    address: string;
    logoURI: string;
    balance: number;
    balanceUSD: number;
    priceUSD: number;
    chainId: number;
    decimals: number;
  }>> {
    try {
      return await this.getPortfolioBalancesOrThrow(walletAddress, chainIds, opts);
    } catch (error) {
      console.error('[LifiService] Error fetching portfolio balances:', error);
      return [];
    }
  }

  /**
   * Get portfolio balances, propagating failures (SDK init failure,
   * network/auth/proxy errors) instead of returning []. Lets the dashboard
   * tell "wallet is empty" apart from "balances could not be loaded".
   *
   * `opts.force` bypasses the TokenDataService TTL cache READ (post-send /
   * manual refresh must not see pre-transaction balances) while keeping the
   * in-flight dedup and re-warming the cache.
   */
  async getPortfolioBalancesOrThrow(
    walletAddress: string,
    chainIds?: number[],
    opts?: { force?: boolean }
  ): Promise<Array<{
    symbol: string;
    name: string;
    address: string;
    logoURI: string;
    balance: number;
    balanceUSD: number;
    priceUSD: number;
    chainId: number;
    decimals: number;
  }>> {
    if (!await this.ensureInitialized()) {
      throw new Error('Balance service unavailable: LI.FI SDK failed to initialize');
    }
    return this.tokenDataService.getPortfolioBalances(walletAddress, chainIds, opts);
  }

  // ===========================================================================
  // GAS METHODS (delegated to GasService)
  // ===========================================================================

  /**
   * Get current gas price.
   *
   * No `ensureInitialized()` gate — `gasService.getGasPrice()` reads via
   * the wallet provider (when on the right chain) or public RPCs, neither
   * of which needs the LI.FI SDK booted. Gating on init was wasting ~2s
   * per 30s tick for logged-out users (see auth.service.ts polling).
   */
  async getGasPrice(chainId: number): Promise<GasPrice | null> {
    return this.gasService.getGasPrice(chainId);
  }

  /**
   * Get gas level display info
   */
  getGasLevelInfo(level: GasPriceLevel): { label: string; color: string } {
    return this.gasService.getGasLevelInfo(level as any);
  }

  // ===========================================================================
  // TRANSACTION TRACKING (delegated to TransactionTrackerService)
  // ===========================================================================

  /**
   * Get transaction status
   */
  async getTransactionStatus(
    txHash: string,
    fromChain?: number
  ): Promise<LifiStatusResponse | null> {
    if (!await this.ensureInitialized()) return null;
    return this.trackerService.getTransactionStatus(txHash, fromChain);
  }

  // No trackTransaction facade here anymore: the polling loop is called by
  // ActiveSwapHubService straight on TransactionTrackerService (plain fetch,
  // no SDK init required) — re-adding a facade would re-couple tracking to
  // ensureInitialized() and drag @lifi/sdk back into the eager bundle.

  /**
   * Get status message
   */
  getStatusMessage(status: LifiStatusResponse): string {
    return this.trackerService.getStatusMessage(status);
  }

  // ===========================================================================
  // CHAIN UTILITIES (delegated to ChainService)
  // ===========================================================================

  /**
   * Get chain name
   */
  getChainName(chainId: number): string {
    return this.chainService.getChainName(chainId);
  }

  /**
   * Get explorer URL for transaction
   */
  getExplorerUrl(chainId: number, txHash: string): string {
    return this.chainService.getExplorerUrl(chainId, txHash);
  }
}
