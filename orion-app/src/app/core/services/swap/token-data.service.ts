/**
 * Token Data Service
 * Handles fetching tokens and balances from LI.FI API
 */
import { Injectable, inject, signal } from '@angular/core';
import { isAddress } from 'ethers';
import { letterTokenIcon } from '../../utils/token-icon';
import { getTokens } from '@lifi/sdk';
import type { Token as LifiToken } from '@lifi/sdk';
import { Token } from '../../models/token.model';
import { WalletService } from '../wallet.service';
import { AuthService } from '../auth.service';
import { environment } from '../../../../environments/environment';

/** One wallet holding as returned by `getPortfolioBalances`. */
export interface PortfolioBalance {
  symbol: string;
  name: string;
  address: string;
  logoURI: string;
  balance: number;
  balanceUSD: number;
  priceUSD: number;
  chainId: number;
  decimals: number;
}

/**
 * One token row in the shared `{balances:{chainId:[...]}}` envelope. The Orion
 * backend `/balances` endpoint and the legacy LI.FI proxy emit the same shape:
 * a raw-integer `amount` string and a string `priceUSD`.
 */
interface RawBalanceToken {
  amount?: string;
  decimals?: number;
  priceUSD?: string;
  symbol?: string;
  name?: string;
  address?: string;
  logoURI?: string;
}

@Injectable({
  providedIn: 'root',
})
export class TokenDataService {
  private walletService = inject(WalletService);
  private authService = inject(AuthService);

  /** Cache for tokens per chain */
  private tokensCache = signal<Map<number, Token[]>>(new Map());

  /**
   * Read-only view of the per-chain token cache. The dashboard reads it
   * synchronously as a "trusted token list" to separate listed tokens from
   * unsolicited airdrops; being a signal, consumers react when
   * `getTokensForChain` fills a chain in.
   */
  readonly cachedTokens = this.tokensCache.asReadonly();

  /** In-flight token-list fetches — concurrent callers share one request */
  private inflightTokenFetches = new Map<number, Promise<Token[]>>();

  /** Per-chain backoff: timestamp until which a failed chain fails open */
  private tokenFetchCooldownUntil = new Map<number, number>();

  /**
   * How long a failed chain backs off before re-hitting LI.FI. Must outlast
   * the dashboard's 30 s portfolio tick so a down endpoint isn't hammered.
   */
  private static readonly TOKEN_FETCH_COOLDOWN_MS = 60_000;

  /**
   * Portfolio-balances cache TTL. Short on purpose: long enough to absorb
   * near-simultaneous callers (dashboard load + token selector + visibility
   * refresh), short enough that a post-swap/post-send refresh — which lands
   * well after this window — still sees fresh balances.
   */
  private static readonly PORTFOLIO_CACHE_TTL_MS = 12_000;

  /** Successful portfolio fetches, keyed `${wallet}:${chains}`. */
  private portfolioCache = new Map<string, { value: PortfolioBalance[]; ts: number }>();

  /** In-flight portfolio fetches — concurrent callers share one request. */
  private inflightPortfolioFetches = new Map<string, Promise<PortfolioBalance[]>>();

  /**
   * LI.FI SDK call kept as an instance field so unit tests can stub it —
   * ES-module exports can't be spied on under Karma/esbuild.
   */
  private lifiGetTokens: typeof getTokens = getTokens;

  /**
   * Get tokens for a specific chain. Concurrent calls for the same chain are
   * deduped into one SDK request, and a failed chain is not retried until a
   * short cooldown elapses (it fails open with an empty list meanwhile).
   */
  async getTokensForChain(chainId: number): Promise<Token[]> {
    const cached = this.tokensCache().get(chainId);
    if (cached) return cached;

    const inflight = this.inflightTokenFetches.get(chainId);
    if (inflight) return inflight;

    if (Date.now() < (this.tokenFetchCooldownUntil.get(chainId) ?? 0)) {
      return [];
    }

    const request = this.fetchTokensForChain(chainId);
    this.inflightTokenFetches.set(chainId, request);
    try {
      return await request;
    } finally {
      this.inflightTokenFetches.delete(chainId);
    }
  }

  /** Actual SDK fetch + cache write; never throws (fails open with []). */
  private async fetchTokensForChain(chainId: number): Promise<Token[]> {
    try {
      const result = await this.lifiGetTokens({ chains: [chainId] });
      const lifiTokens = result.tokens[chainId] || [];

      const tokens: Token[] = lifiTokens.map((t: LifiToken) => ({
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        chainId: t.chainId,
        logoURI: t.logoURI,
        priceUSD: t.priceUSD,
      }));

      this.tokensCache.update((cache) => {
        const newCache = new Map(cache);
        newCache.set(chainId, tokens);
        return newCache;
      });
      this.tokenFetchCooldownUntil.delete(chainId);

      return tokens;
    } catch (error) {
      console.error('[TokenData] Error fetching tokens:', error);
      this.tokenFetchCooldownUntil.set(
        chainId,
        Date.now() + TokenDataService.TOKEN_FETCH_COOLDOWN_MS,
      );
      return [];
    }
  }

  /**
   * Get token by address
   */
  async getTokenByAddress(chainId: number, tokenAddress: string): Promise<Token | null> {
    try {
      // Check cache first
      const tokens = await this.getTokensForChain(chainId);
      const cached = tokens.find(
        (t) => t.address.toLowerCase() === tokenAddress.toLowerCase()
      );

      if (cached) return cached;

      // The address goes into the proxy URL — refuse anything that isn't a
      // real hex address so a crafted string can't smuggle extra query
      // parameters or path segments into the request.
      if (!isAddress(tokenAddress)) {
        console.warn('[TokenData] Malformed token address:', tokenAddress);
        return null;
      }

      // Fetch from API via proxy. getAccessTokenAsync is the single quote-
      // strip point — never re-strip downstream.
      const token = await this.authService.getAccessTokenAsync();

      const query = new URLSearchParams({
        chain: String(chainId),
        token: tokenAddress,
      });
      const response = await fetch(
        `${environment.lifiProxyUrl}/token?${query.toString()}`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }
      );

      if (!response.ok) {
        console.warn(`[TokenData] Token not found: ${tokenAddress}`);
        return null;
      }

      const data = await response.json();

      if (data?.address) {
        return {
          address: data.address,
          symbol: data.symbol,
          name: data.name,
          decimals: data.decimals,
          chainId: chainId,
          logoURI: data.logoURI || letterTokenIcon(data.symbol),
          priceUSD: data.priceUSD,
        };
      }

      return null;
    } catch (error) {
      console.error('[TokenData] Error getting token by address:', error);
      return null;
    }
  }

  /**
   * Get portfolio balances for wallet.
   *
   * Throws on failure (network/auth/proxy errors) instead of returning [] —
   * callers must be able to distinguish "wallet is empty" from "balances
   * could not be loaded". Callers that prefer the old swallow-to-[] behavior
   * go through `LifiService.getPortfolioBalances()`.
   *
   * Concurrent calls for the same wallet+chains share one in-flight request,
   * and successful results are served from a short TTL cache
   * (PORTFOLIO_CACHE_TTL_MS) — the dashboard, token selector and visibility
   * refresh all used to fire their own 5-chain proxy request on page load.
   * Failures are never cached.
   *
   * `opts.force` skips the TTL READ (a post-send/post-swap refresh must not
   * be served pre-transaction balances from a still-warm cache) but keeps
   * the in-flight dedup and still writes the cache, re-warming it for the
   * auto-tick path.
   */
  async getPortfolioBalances(
    walletAddress: string,
    chainIds: number[] = [1, 42161, 8453, 137, 10, 56, 43114],
    opts?: { force?: boolean },
  ): Promise<PortfolioBalance[]> {
    const key = `${walletAddress.toLowerCase()}:${[...chainIds].sort((a, b) => a - b).join(',')}`;

    if (!opts?.force) {
      const cached = this.portfolioCache.get(key);
      if (cached && Date.now() - cached.ts < TokenDataService.PORTFOLIO_CACHE_TTL_MS) {
        return cached.value;
      }
    }

    const inflight = this.inflightPortfolioFetches.get(key);
    if (inflight) return inflight;

    const request = this.fetchPortfolioBalances(walletAddress, chainIds, key);
    this.inflightPortfolioFetches.set(key, request);
    try {
      return await request;
    } finally {
      this.inflightPortfolioFetches.delete(key);
    }
  }

  /**
   * Wallet portfolio fetch + cache write; throws on failure (see caller doc).
   *
   * Primary source is the Orion backend `/balances` endpoint (Alchemy Portfolio
   * API, key server-side): one multichain call returning native + ERC-20 +
   * prices, and — unlike LI.FI's hosted indexer — it does NOT drop native
   * balances (the Arbitrum-ETH bug) or flicker per-chain. If that endpoint is
   * unavailable (not yet provisioned → 503, or any transport error) it falls
   * back to the legacy LI.FI proxy. Both emit the same `{balances:{chainId:
   * [...]}}` envelope, so the parse is shared. A SUCCESSFUL response for an
   * empty wallet returns `[]` (no throw → no fallback); only a thrown error
   * (transport / non-2xx / bad JSON) falls back.
   */
  private async fetchPortfolioBalances(
    walletAddress: string,
    chainIds: number[],
    cacheKey: string,
  ): Promise<PortfolioBalance[]> {
    // The wallet address goes into a request URL — a malformed value could
    // otherwise rewrite the request. Validate once, before either source.
    if (!isAddress(walletAddress)) {
      throw new Error('Invalid wallet address');
    }

    let result: PortfolioBalance[];
    try {
      result = await this.fetchBalancesViaBackend(walletAddress, chainIds);
    } catch {
      try {
        result = await this.fetchBalancesViaLifi(walletAddress, chainIds);
      } catch (error) {
        // Both sources failed — surface it so callers render the error state.
        // Failures stay uncached: the next call retries immediately.
        console.error('[TokenData] Error fetching portfolio:', error);
        throw error;
      }
    }

    // Fill logos the balances source left blank (Alchemy omits most) from the
    // LI.FI token list before caching, so every consumer sees real icons.
    await this.enrichLogos(result);

    this.portfolioCache.set(cacheKey, { value: result, ts: Date.now() });
    return result;
  }

  /**
   * Primary: the Orion backend `/balances` endpoint (Alchemy-backed; key stays
   * server-side). The raw fetch sets the Privy bearer itself — `apiUrl` is not
   * covered by the LI.FI fetch patch, and a raw fetch bypasses the HttpClient
   * auth interceptor. No `_t` cache-buster: the backend owns the freshness
   * window (a short server-side TTL), and a buster would only defeat that cache.
   */
  private async fetchBalancesViaBackend(
    walletAddress: string,
    chainIds: number[],
  ): Promise<PortfolioBalance[]> {
    const query = new URLSearchParams({
      address: walletAddress,
      chains: chainIds.join(','),
    });
    const token = await this.authService.getAccessTokenAsync();
    const response = await fetch(`${environment.apiUrl}/balances?${query.toString()}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      // 503 = endpoint not provisioned (Alchemy key missing) → fall back to LI.FI.
      throw new Error(`Backend balances failed: ${response.status}`);
    }
    return this.parseBalancesEnvelope(await response.json(), chainIds);
  }

  /**
   * Fallback: the legacy LI.FI balance proxy. Kept so balances still load while
   * the backend endpoint is unprovisioned — but it omits some native balances
   * (see fetchPortfolioBalances), so it is the fallback, never the primary.
   * The `_t` buster defeats any CDN in front of the LI.FI proxy.
   */
  private async fetchBalancesViaLifi(
    walletAddress: string,
    chainIds: number[],
  ): Promise<PortfolioBalance[]> {
    const query = new URLSearchParams({
      extended: 'true',
      chains: chainIds.join(','),
      _t: String(Date.now()),
    });
    const url = `${environment.lifiProxyUrl}/wallets/${encodeURIComponent(walletAddress)}/balances?${query.toString()}`;
    const token = await this.authService.getAccessTokenAsync();
    const response = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch balances: ${response.status}`);
    }
    return this.parseBalancesEnvelope(await response.json(), chainIds);
  }

  /**
   * Parse the shared `{balances:{chainId:[{amount,decimals,priceUSD,…}]}}`
   * envelope into PortfolioBalance[]: `amount` is a raw-integer string, scaled
   * by `decimals`; `priceUSD` is a string. Identical from the backend and LI.FI.
   */
  private parseBalancesEnvelope(
    data: { balances?: Record<string, RawBalanceToken[]> },
    chainIds: number[],
  ): PortfolioBalance[] {
    const balances = data?.balances;
    if (!balances || Object.keys(balances).length === 0) {
      return [];
    }

    const result: PortfolioBalance[] = [];
    for (const chainIdStr of Object.keys(balances)) {
      const chainId = parseInt(chainIdStr, 10);

      // Skip chains we didn't request
      if (!chainIds.includes(chainId)) continue;

      const tokens = balances[chainIdStr];
      if (!Array.isArray(tokens)) continue;

      for (const token of tokens) {
        // A token with no address is unusable (can't be selected, sent or
        // swapped) and would collide with others under the empty-string key the
        // token selector builds (`address.toLowerCase()`) — drop it.
        if (!token.address) continue;

        const amount = parseFloat(token.amount || '0');
        if (amount <= 0) continue;

        // Guard on type: `|| 18` would mis-scale a legitimate 0-decimal token.
        const decimals = typeof token.decimals === 'number' ? token.decimals : 18;
        const balance = amount / Math.pow(10, decimals);
        const priceUSD = parseFloat(token.priceUSD || '0');
        const balanceUSD = balance * priceUSD;

        // Skip dust
        if (balanceUSD < 0.01 && balance < 0.0001) continue;

        const symbol = token.symbol || 'UNKNOWN';
        result.push({
          symbol,
          name: token.name || token.symbol || 'Unknown Token',
          address: token.address,
          // Leave blank when the source (Alchemy) carries no logo — enrichLogos
          // resolves it from the token list before the letter-icon fallback.
          logoURI: token.logoURI || '',
          balance,
          balanceUSD,
          priceUSD,
          chainId,
          decimals,
        });
      }
    }

    // Sort by USD value
    result.sort((a, b) => b.balanceUSD - a.balanceUSD);
    return result;
  }

  /**
   * Fill in token logos the balances source left blank. The Alchemy-backed
   * `/balances` endpoint omits a logo for most tokens, so the dashboard fell
   * back to letter tiles even though the LI.FI token list — the same source the
   * token selector renders, which DOES show icons — has the real logo. Resolve
   * it by chain + address, and only then fall back to a generated letter icon.
   * Best-effort: a chain whose token list can't load keeps letter tiles.
   */
  private async enrichLogos(balances: PortfolioBalance[]): Promise<void> {
    const missing = balances.filter((b) => !b.logoURI);
    if (missing.length === 0) return;

    const chainIds = [...new Set(missing.map((b) => b.chainId))];
    const lists = await Promise.all(
      chainIds.map((id) => this.getTokensForChain(id).catch(() => [] as Token[])),
    );

    const logoByChainAddress = new Map<number, Map<string, string>>();
    chainIds.forEach((id, i) => {
      const byAddress = new Map<string, string>();
      for (const t of lists[i]) {
        if (t.logoURI) byAddress.set(t.address.toLowerCase(), t.logoURI);
      }
      logoByChainAddress.set(id, byAddress);
    });

    for (const b of balances) {
      if (b.logoURI) continue;
      b.logoURI = logoByChainAddress.get(b.chainId)?.get(b.address.toLowerCase()) || letterTokenIcon(b.symbol);
    }
  }

  /**
   * Clear token and portfolio caches. Failure cooldowns are reset too, so a
   * deliberate cache clear is allowed to retry chains that recently errored.
   */
  clearCache(): void {
    this.tokensCache.set(new Map());
    this.tokenFetchCooldownUntil.clear();
    this.portfolioCache.clear();
  }
}
