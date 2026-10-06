/**
 * =============================================================================
 * RPC POOL SERVICE
 * =============================================================================
 *
 * Shared pool of read-only JsonRpcProviders plus a per-URL circuit breaker.
 * WalletService (balance reads) and GasService (fee reads) used to keep
 * divergent provider/cooldown maps — GasService even constructed a fresh
 * JsonRpcProvider per call, leaking connections and re-detecting the chain
 * on every request. Both now route through this singleton so a misbehaving
 * public endpoint is skipped consistently across features.
 *
 * Failure classification (markUnhealthy):
 * - Rate-limit / server-class → long cooldown (quotas reset on a schedule).
 *   ethers v6 retries 429s internally and resurfaces them as a typed
 *   SERVER_ERROR whose message reads "exceeded maximum retry limit", so the
 *   typed `code` / `shortMessage` are checked alongside the raw message.
 * - BAD_DATA / CALL_EXCEPTION → NO cooldown. Those are data-level failures
 *   (reverted balanceOf, undecodable result for one token) and say nothing
 *   about the endpoint's health — cooling a healthy RPC for them starves
 *   every other read on that chain.
 * - Everything else → short cooldown (network blips are often transient).
 *
 * @author Orion DEX Team
 * @version 1.0.0
 */

import { Injectable } from '@angular/core';
import { JsonRpcProvider } from 'ethers';

// =============================================================================
// CONFIGURATION
// =============================================================================

/** How long to avoid an RPC after a 429/5xx — quotas reset on a schedule. */
export const RPC_COOLDOWN_RATE_LIMIT_MS = 10 * 60_000;

/** Generic network errors are often transient — retry sooner. */
export const RPC_COOLDOWN_ERROR_MS = 60_000;

// =============================================================================
// FAILURE CLASSIFICATION
// =============================================================================

type RpcFailureClass = 'rate-limit' | 'transient' | 'data';

/** Minimal shape of an ethers v6 typed error — narrowed field by field. */
interface MaybeTypedError {
  code?: unknown;
  shortMessage?: unknown;
}

function classifyRpcFailure(err: unknown): RpcFailureClass {
  const typed: MaybeTypedError = typeof err === 'object' && err !== null ? err : {};
  const code = typeof typed.code === 'string' ? typed.code : '';

  // Token/data-level failures — the endpoint answered, the payload was the
  // problem. Never cool the RPC for these.
  if (code === 'BAD_DATA' || code === 'CALL_EXCEPTION') return 'data';

  const shortMessage = typeof typed.shortMessage === 'string' ? typed.shortMessage : '';
  const message = err instanceof Error ? err.message : String(err);
  const text = `${shortMessage} ${message}`;

  // "exceeded maximum retry limit" is ethers v6's surface for a 429 that
  // survived its internal retry loop (typed SERVER_ERROR, statusCode 429).
  const isRateLimitOrServer =
    code === 'SERVER_ERROR' ||
    /\b429\b|too many requests|rate.?limit|exceeded maximum retry limit|server response 5\d\d/i.test(text);

  return isRateLimitOrServer ? 'rate-limit' : 'transient';
}

// =============================================================================
// RPC POOL SERVICE
// =============================================================================

@Injectable({
  providedIn: 'root',
})
export class RpcPoolService {
  /**
   * Read-only JsonRpcProviders cached per `${chainId}:${url}`. A provider is
   * chain-bound, hence the composite key. `staticNetwork` pins the chain so
   * ethers skips its eth_chainId probe — without it every read costs 2+ RPC
   * roundtrips.
   */
  private providers = new Map<string, JsonRpcProvider>();

  /** Circuit breaker: URL → earliest timestamp we may retry. */
  private cooldown = new Map<string, number>();

  /** Get (or lazily construct) the cached read-only provider for an URL. */
  getProvider(url: string, chainId: number): JsonRpcProvider {
    const key = `${chainId}:${url}`;
    let provider = this.providers.get(key);
    if (!provider) {
      provider = this.createProvider(url, chainId);
      this.providers.set(key, provider);
    }
    return provider;
  }

  /** False while the URL is inside a cooldown window — callers skip it. */
  isHealthy(url: string): boolean {
    return (this.cooldown.get(url) ?? 0) <= Date.now();
  }

  /**
   * Record a failing RPC so subsequent reads skip it. Data-level failures
   * (BAD_DATA / CALL_EXCEPTION) are deliberately ignored — see file header.
   */
  markUnhealthy(url: string, err: unknown): void {
    const failureClass = classifyRpcFailure(err);
    if (failureClass === 'data') return;

    const ms = failureClass === 'rate-limit' ? RPC_COOLDOWN_RATE_LIMIT_MS : RPC_COOLDOWN_ERROR_MS;
    this.cooldown.set(url, Date.now() + ms);
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[RpcPool] RPC ${url} cooling down ${ms / 1000}s: ${message}`);
  }

  /** Seam for tests — provider construction is the only part worth faking. */
  protected createProvider(url: string, chainId: number): JsonRpcProvider {
    return new JsonRpcProvider(url, chainId, { staticNetwork: true });
  }
}
