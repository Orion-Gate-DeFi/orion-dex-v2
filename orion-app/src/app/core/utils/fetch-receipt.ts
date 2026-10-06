/**
 * =============================================================================
 * RECEIPT FETCHER
 * =============================================================================
 *
 * Pulls a transaction receipt with a public-RPC fallback. Used by both swap
 * execution and send so that:
 *   1. We can detect on-chain reverts (`receipt.status === 0`) — ethers v6's
 *      `waitForTransaction` does NOT throw on revert, it resolves with a
 *      receipt whose status is 0.
 *   2. Privy embedded wallets — which return `nonce: "undefined"` (the
 *      literal string) and crash the ethers v6 receipt parser — don't blind
 *      the caller. We just retry against a fresh `JsonRpcProvider` from the
 *      public RPC list.
 *
 * Returns `null` only when both paths give up (no provider for the chain,
 * timeout). Caller treats `null` as "broadcast succeeded but confirmation
 * unknown" rather than as a hard failure.
 */

import { JsonRpcProvider, type TransactionReceipt } from 'ethers';
import { PUBLIC_RPCS } from '../constants/public-rpcs.constant';

/**
 * Fetch a 1-confirmation receipt. Tries the wallet provider first; on
 * failure, walks the public RPCs for the chain.
 */
export async function fetchReceiptWithFallback(
  walletProvider: any,
  txHash: string,
  chainId: number,
  timeoutMs: number = 30_000,
): Promise<TransactionReceipt | null> {
  if (walletProvider) {
    try {
      const receipt = await walletProvider.waitForTransaction(txHash, 1, timeoutMs);
      if (receipt) return receipt;
    } catch (err) {
      // TIMEOUT on the wallet provider is the *expected* path for bridge
      // entry txs (LI.FI Diamond / Squid Router) — they often don't surface
      // a clean receipt because the user-side leg finalises through a
      // relayer. Drop to debug-level so the console isn't full of red on
      // legitimate cross-chain swaps. Anything other than a timeout still
      // gets a louder warning since it usually points at a real issue.
      const code = (err as any)?.code;
      if (code === 'TIMEOUT') {
        console.debug('[Receipt] wallet provider timed out, falling back to public RPC');
      } else {
        console.warn('[Receipt] wallet provider failed, falling back to public RPC:', code);
      }
    }
  }
  return pollPublicRpcReceipt(chainId, txHash, timeoutMs);
}

/**
 * Walks the public RPCs for a chain, polling each for a receipt.
 *
 * The timeout window is split per URL (with an overall cap) rather than
 * shared across the whole loop — a healthy-but-lagging first RPC must not
 * be able to eat the entire window and starve the rest of the list. The
 * pass over the list then repeats until the overall deadline: fast-failing
 * (dead) RPCs must not shrink the total window for the healthy ones, so a
 * URL whose slice ran out gets fresh slices on later passes.
 *
 * `providerFactory` / `pollIntervalMs` are injectable so this is
 * unit-testable without real network or multi-second real timers.
 */
export async function pollPublicRpcReceipt(
  chainId: number,
  txHash: string,
  timeoutMs: number,
  providerFactory: (url: string) => Pick<JsonRpcProvider, 'getTransactionReceipt'> = (url) =>
    new JsonRpcProvider(url),
  pollIntervalMs: number = 2_000,
): Promise<TransactionReceipt | null> {
  const urls = PUBLIC_RPCS[chainId];
  if (!urls || urls.length === 0) return null;

  // Split the window across URLs: one healthy-but-lagging RPC must not
  // monopolize the whole timeout while a peer already has the receipt.
  const overallDeadline = Date.now() + timeoutMs;
  const perUrlMs = Math.floor(timeoutMs / urls.length);

  while (Date.now() < overallDeadline) {
    let polledThisPass = false;

    for (const url of urls) {
      if (Date.now() >= overallDeadline) break;
      const urlDeadline = Math.min(Date.now() + perUrlMs, overallDeadline);
      try {
        const provider = providerFactory(url);
        // do-while: even a zero-width slice (timeoutMs < urls.length) still
        // gets one attempt per pass instead of silently skipping the URL.
        do {
          const receipt = await provider.getTransactionReceipt(txHash);
          polledThisPass = true;
          if (receipt) return receipt as TransactionReceipt;
          await new Promise((r) => setTimeout(r, pollIntervalMs));
        } while (Date.now() < urlDeadline);
      } catch (err) {
        console.warn(`[Receipt] poll via ${url} failed:`, (err as { code?: string })?.code);
      }
    }

    // A pass where every provider threw immediately completes in ~0ms —
    // don't spin hot against dead RPCs; pause before the next pass. Any
    // successful poll already slept `pollIntervalMs` inside the URL loop.
    if (!polledThisPass && Date.now() < overallDeadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
  return null;
}
