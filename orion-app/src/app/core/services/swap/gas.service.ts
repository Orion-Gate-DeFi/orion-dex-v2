/**
 * Gas Service
 * Handles gas price fetching and estimation. Public-RPC reads go through the
 * shared RpcPoolService (provider cache + circuit breaker, shared with
 * WalletService) — this service used to build a fresh JsonRpcProvider per
 * call, leaking connections and re-detecting the chain on every request.
 */
import { Injectable, inject } from '@angular/core';
import { WalletService } from '../wallet.service';
import { AuthService } from '../auth.service';
import { RpcPoolService } from '../rpc-pool.service';
import { environment } from '../../../../environments/environment';
import { PUBLIC_RPCS } from '../../constants/public-rpcs.constant';

/** Cache TTL for gas price per chain (matches component's 30s refresh). */
const GAS_CACHE_TTL = 30_000;

/**
 * Cache TTL for the native token's USD price. Native prices (ETH/MATIC) move
 * slowly relative to gas: the gwei reading stays fresh on every 30 s tick,
 * but re-fetching the price from the LI.FI proxy each tick was pure churn —
 * a 5-minute price is plenty for a "≈ $X.XX" fee estimate.
 */
const NATIVE_PRICE_CACHE_TTL = 300_000;

/**
 * Sanity bounds for accepted gas prices, in wei. Calibrated for L2s — Base,
 * Arbitrum and Optimism legitimately drop into single-digit megawei (i.e.
 * thousandths of a gwei) during low traffic. The 0.0001-gwei floor is loose
 * enough to accept those while still rejecting an obvious 0/garbage value;
 * the 1000-gwei ceiling catches any RPC reporting wildly inflated prices
 * (which used to trigger "Very High" warnings during normal mainnet use).
 */
const MIN_ACCEPTABLE_GAS_WEI = 100_000n;             // 0.0001 gwei (L2-friendly)
const MAX_ACCEPTABLE_GAS_WEI = 1_000_000_000_000n;   // 1000 gwei

export type GasLevel = 'cheap' | 'normal' | 'high' | 'very_high';

export interface GasPrice {
  gwei: number;
  level: GasLevel;
  usd: string;
}

export interface GasInfo {
  level: GasLevel;
  estimatedUSD: string;
  estimatedGwei: string;
}

/** Fallback ETH prices by chain */
const FALLBACK_NATIVE_PRICES: Record<number, number> = {
  1: 3500,     // ETH
  42161: 3500, // ETH on Arbitrum
  8453: 3500,  // ETH on Base
  10: 3500,    // ETH on Optimism
  137: 0.5,    // MATIC on Polygon
  56: 800,     // BNB on BNB Chain
  43114: 30,   // AVAX on Avalanche
};

@Injectable({
  providedIn: 'root',
})
export class GasService {
  private walletService = inject(WalletService);
  private authService = inject(AuthService);

  /** Shared read-only provider cache + RPC circuit breaker (also WalletService's). */
  private rpcPool = inject(RpcPoolService);

  /** Per-chain gas price cache to avoid hammering public RPCs. */
  private cache = new Map<number, { value: GasPrice; ts: number }>();

  /** Per-chain native-token USD price cache (only successful fetches are
   *  cached — a fallback price retries the proxy on the next tick). */
  private nativePriceCache = new Map<number, { price: number; ts: number }>();

  /**
   * Get current gas price for a chain
   */
  async getGasPrice(chainId: number): Promise<GasPrice | null> {
    const cached = this.cache.get(chainId);
    if (cached && Date.now() - cached.ts < GAS_CACHE_TTL) {
      return cached.value;
    }

    const gasPrice = await this.tryFetchGasPriceWei(chainId);
    if (!gasPrice) return null;

    try {
      const gweiValue = Number(gasPrice) / 1e9;

      // Estimate cost for a swap (~150k gas)
      const estimatedGasUnits = 150000n;
      const estimatedCostWei = gasPrice * estimatedGasUnits;
      const estimatedCostEth = Number(estimatedCostWei) / 1e18;

      const nativePrice = await this.getNativeTokenPrice(chainId);
      const estimatedCostUSD = estimatedCostEth * nativePrice;

      const level = this.categorizeGasLevel(chainId, gweiValue);

      const result: GasPrice = {
        gwei: Math.round(gweiValue * 100) / 100,
        level,
        usd: estimatedCostUSD.toFixed(2),
      };
      this.cache.set(chainId, { value: result, ts: Date.now() });
      return result;
    } catch {
      // Native price / categorization is best-effort — the strip will keep
      // the last known value, no console noise on a transient hiccup.
      return null;
    }
  }

  /**
   * Walk through wallet + public RPCs, returning the first successful gas
   * price in wei. Marks any RPC that throws on `getFeeData()` as unhealthy
   * so we don't reselect it next tick. (The old per-call `getNetwork`
   * liveness probe is gone: pooled providers pin the chain via
   * `staticNetwork`, which makes `getNetwork()` resolve locally — the
   * `getFeeData` try/catch is the real health check.)
   */
  private async tryFetchGasPriceWei(chainId: number): Promise<bigint | null> {
    const walletChainId = this.walletService.chainId();
    if (walletChainId === chainId) {
      const wallet = this.walletService.getProvider();
      if (wallet) {
        try {
          const feeData = await wallet.getFeeData();
          const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
          if (gasPrice && this.isPlausibleGasPrice(gasPrice)) return gasPrice;
        } catch {
          // Wallet provider failed — fall through to public RPCs.
        }
      }
    }

    const urls = PUBLIC_RPCS[chainId];
    if (!urls || urls.length === 0) return null;

    for (const url of urls) {
      if (!this.rpcPool.isHealthy(url)) continue;

      try {
        const provider = this.rpcPool.getProvider(url, chainId);
        const feeData = await provider.getFeeData();
        // EIP-1559 L2s (Base, Optimism, Arbitrum) often return `gasPrice:
        // null` and expose the effective price as `maxFeePerGas`.
        const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
        if (gasPrice && this.isPlausibleGasPrice(gasPrice)) return gasPrice;
        if (gasPrice) {
          // Implausible value — log + cool down briefly so we don't keep
          // hitting the same misbehaving RPC every tick.
          console.warn(`[Gas] RPC ${url} returned implausible gas price ${gasPrice} wei`);
          this.rpcPool.markUnhealthy(url, new Error('implausible gas price'));
          continue;
        }
      } catch (err) {
        this.rpcPool.markUnhealthy(url, err);
        continue;
      }
    }
    return null;
  }

  private isPlausibleGasPrice(wei: bigint): boolean {
    return wei >= MIN_ACCEPTABLE_GAS_WEI && wei <= MAX_ACCEPTABLE_GAS_WEI;
  }

  /**
   * Categorize gas cost into levels
   */
  categorizeGasCost(gasCostUSD: string): GasInfo {
    const cost = parseFloat(gasCostUSD);
    let level: GasLevel;

    if (cost < 5) {
      level = 'cheap';
    } else if (cost < 15) {
      level = 'normal';
    } else {
      level = 'high';
    }

    return {
      level,
      estimatedUSD: cost.toFixed(2),
      estimatedGwei: '0',
    };
  }

  /**
   * Get display info for gas level
   */
  getGasLevelInfo(level: GasLevel): { label: string; color: string } {
    switch (level) {
      case 'cheap':
        return { label: 'Cheap', color: 'text-emerald-400' };
      case 'normal':
        return { label: 'Normal', color: 'text-yellow-400' };
      case 'high':
        return { label: 'High', color: 'text-orange-400' };
      case 'very_high':
        return { label: 'Very High', color: 'text-red-400' };
    }
  }

  /**
   * Get suggestion based on gas level
   */
  getGasSuggestion(level: GasLevel): string {
    switch (level) {
      case 'cheap':
        return 'Great time to swap!';
      case 'normal':
        return 'Normal gas prices';
      case 'high':
        return 'Consider waiting for lower gas';
      case 'very_high':
        return 'Gas is very expensive right now';
    }
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  private categorizeGasLevel(chainId: number, gweiValue: number): GasLevel {
    if (chainId === 1) {
      // Ethereum mainnet thresholds
      if (gweiValue < 20) return 'cheap';
      if (gweiValue < 50) return 'normal';
      if (gweiValue < 100) return 'high';
      return 'very_high';
    } else if (chainId === 43114) {
      // Avalanche C-Chain: gas is gwei-scale (nAVAX) with a ~25 nAVAX base-fee
      // floor, so the L2 thresholds below would peg it at 'very_high' always.
      if (gweiValue < 30) return 'cheap';
      if (gweiValue < 50) return 'normal';
      if (gweiValue < 100) return 'high';
      return 'very_high';
    } else {
      // L2 chains - much lower thresholds
      if (gweiValue < 0.1) return 'cheap';
      if (gweiValue < 0.5) return 'normal';
      if (gweiValue < 2) return 'high';
      return 'very_high';
    }
  }

  /**
   * Native-token USD price for the given chain. Serves a per-chain cache
   * (NATIVE_PRICE_CACHE_TTL) so the 30 s gas tick doesn't re-hit the LI.FI
   * proxy every time; on a cache miss tries the proxy, falling back to a
   * hardcoded recent value (FALLBACK_NATIVE_PRICES) so the caller always
   * gets a positive number. Fallbacks are NOT cached — the proxy is retried
   * on the next tick.
   *
   * Public so other services (SendService) can compute fee estimates in USD
   * without duplicating the LI.FI fetch + fallback logic.
   */
  async getNativeTokenPrice(chainId: number): Promise<number> {
    const cached = this.nativePriceCache.get(chainId);
    if (cached && Date.now() - cached.ts < NATIVE_PRICE_CACHE_TTL) {
      return cached.price;
    }

    try {
      const nativeAddress = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      const token = await this.authService.getAccessTokenAsync();

      const response = await fetch(
        `${environment.lifiProxyUrl}/token?chain=${chainId}&token=${nativeAddress}`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }
      );

      if (response.ok) {
        const data = await response.json();
        if (data.priceUSD) {
          const price = parseFloat(data.priceUSD);
          if (Number.isFinite(price) && price > 0) {
            this.nativePriceCache.set(chainId, { price, ts: Date.now() });
            return price;
          }
        }
      }
    } catch {
      // Use fallback
    }

    return FALLBACK_NATIVE_PRICES[chainId] || 3500;
  }
}
