/**
 * Swap Execution Service
 * Handles executing swap transactions (backend aggregators + LI.FI fallback).
 * Owns the transaction trust boundary: every quote passes the verified
 * contract allowlist, native-value ceiling and approval-spender checks
 * before its calldata can reach the signer.
 */
import {inject, Injectable} from '@angular/core';
import {Contract, JsonRpcProvider, getAddress, isAddress, parseUnits} from 'ethers';
import {Token} from '../../models/token.model';
import type {AggregatorName, SwapQuote} from '../../models/swap.model';
import {WalletService} from '../wallet.service';
import {ChainService} from './chain.service';
import {PUBLIC_RPCS} from '../../constants/public-rpcs.constant';
import {getNetworkById, getNetworkName, getVerifiedAggregatorContracts} from '../../constants';
import {fetchReceiptWithFallback} from '../../utils/fetch-receipt';

/** ERC20 ABI for approval operations */
const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

/** Quote warning age (25 seconds) */
const QUOTE_WARNING_AGE_MS = 25000;

/** Quote expired age (45 seconds) */
const QUOTE_EXPIRED_AGE_MS = 45000;

/**
 * Upper bound for `gas_limit` accepted from a backend aggregator response.
 * No legitimate swap on the supported chains exceeds ~3M gas; 5M leaves
 * head-room for unusual cross-chain bridges while still rejecting nonsense
 * (e.g. a compromised backend asking the wallet to authorise 10x normal gas).
 */
const MAX_TX_GAS_LIMIT = 5_000_000n;

/**
 * Cross-chain native-value headroom over the quoted swap amount, expressed
 * as a rational (3/2 = ×1.5). Bridges (Squid, LI.FI bridge routes) may fold
 * a relayer/destination-gas fee into `tx.value` on top of the swapped
 * amount, so an exact ceiling would break legitimate cross-chain quotes —
 * but the allowance must stay bounded: a backend that asks for 10× the
 * swap amount is exfiltrating native funds, not paying relayers. The
 * backend enforces the same ceiling on the same data; this is the
 * defense-in-depth mirror.
 */
const CROSS_CHAIN_VALUE_HEADROOM_NUM = 3n;
const CROSS_CHAIN_VALUE_HEADROOM_DEN = 2n;

/** Native placeholder addresses (zero address and the 0xeeee… convention). */
export function isNativeTokenAddress(address: string): boolean {
  const addr = address.toLowerCase();
  return (
    addr === '0x0000000000000000000000000000000000000000' ||
    addr === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  );
}

/**
 * Which allowlist applies to this quote. Backend quotes name their
 * aggregator explicitly; the legacy LI.FI SDK fallback path doesn't, but
 * its transaction target is the same LiFiDiamond the `lifi` allowlist
 * verifies — so it gets the same protection instead of a free pass.
 * `undefined` means "the quote carries no aggregator identity at all" —
 * callers treat that as fail-closed: no production path produces a quote
 * with transaction data but neither an `aggregator` name
 * (QuoteService.convertAggregatorQuote always stamps one) nor a
 * `_lifiRoute` (the SDK fallback always attaches one), so the only way to
 * reach that shape is a malformed or hostile backend response.
 */
export function resolveQuoteAggregator(quote: SwapQuote): AggregatorName | undefined {
  if (quote.aggregator) return quote.aggregator;
  if (quote._lifiRoute) return 'lifi';
  return undefined;
}

// No fail-open exemption set: every empty/unknown aggregator allowlist fails
// CLOSED in assertVerifiedAggregatorContract below. `quote.aggregator` is read
// from the backend RESPONSE, so a fail-open branch (even for a known-disabled
// adapter like ParaSwap) would let a compromised backend skip verification by
// labeling a hostile quote with that name. ParaSwap is disabled backend-side,
// so failing closed costs nothing legitimate.

/** User-facing (presentError-friendly: short, no hex, no braces). */
function verifiedListError(surface: 'swap' | 'approval'): Error {
  return new Error(
    surface === 'swap'
      ? "This quote's swap contract isn't on Orion's verified list. Please refresh the quote."
      : "This quote's approval contract isn't on Orion's verified list. Please refresh the quote.",
  );
}

/**
 * Allowlist gate shared by the calldata target and the approval spender.
 * Fails CLOSED: throws the verified-list error when the candidate isn't on the
 * aggregator+chain pair's verified list, OR when that list is empty for ANY
 * aggregator (unknown name, disabled adapter, or unsupported chain). No
 * exemptions — `quote.aggregator` is backend-controlled, so a fail-open branch
 * would be the exact bypass this gate exists to prevent.
 */
function assertVerifiedAggregatorContract(
  aggregator: AggregatorName,
  chainId: number,
  candidate: string,
  surface: 'swap' | 'approval',
): void {
  const allowlist = getVerifiedAggregatorContracts(aggregator, chainId);
  if (allowlist.length === 0 || !allowlist.includes(candidate.toLowerCase())) {
    throw verifiedListError(surface);
  }
}

/**
 * Sanity-check a transaction request before it reaches the signer. Pure and
 * exported so the trust-boundary table tests run without TestBed (specs
 * that pull the Privy DI graph break Karma).
 *
 * Beyond shape checks, two trust-boundary gates (audit #9/#10):
 *  - `to` must be a verified contract for the quote's aggregator+chain.
 *    Fail closed: a missing/unknown aggregator name, or a known one on a
 *    chain without a verified list, is rejected — only the explicit
 *    known-disabled set (ParaSwap) may skip verification;
 *  - `value` is capped by the quoted amount: a native-token swap may send
 *    at most the quoted amount (×1.5 cross-chain, bounded relayer-fee
 *    headroom — see CROSS_CHAIN_VALUE_HEADROOM); an ERC-20 swap must send
 *    no native value at all. The frontend can't audit calldata semantics,
 *    but it CAN refuse to hand over more native funds than the user agreed
 *    to on the review screen.
 */
export function validateSwapTransactionRequest(
  tx: {
    to: string;
    data: string;
    value?: string;
    gasLimit?: string | bigint;
  },
  quote: SwapQuote,
): { to: string; data: string; value?: string; gasLimit?: bigint } {
  if (!tx.to || !isAddress(tx.to)) {
    throw new Error('Invalid swap target address. Please refresh the quote.');
  }
  const checksummedTo = getAddress(tx.to);

  const aggregator = resolveQuoteAggregator(quote);
  if (!aggregator) {
    // Fail closed: a quote with calldata but no aggregator identity is a
    // malformed or hostile backend response (see resolveQuoteAggregator) —
    // there is nothing to verify the target against, so it never signs.
    throw verifiedListError('swap');
  }
  assertVerifiedAggregatorContract(
    aggregator,
    quote.fromToken.chainId,
    checksummedTo,
    'swap',
  );

  if (!tx.data || typeof tx.data !== 'string' || !tx.data.startsWith('0x') || tx.data.length < 10) {
    throw new Error('Quote expired. Please refresh and try again.');
  }

  let value: bigint = 0n;
  if (tx.value !== undefined && tx.value !== null) {
    try {
      value = BigInt(tx.value);
    } catch {
      throw new Error('Invalid swap amount. Please refresh the quote.');
    }
  }

  if (isNativeTokenAddress(quote.fromToken.address)) {
    // Native sell: `value` carries the swapped amount itself. All supported
    // native tokens (ETH, POL) use 18 decimals.
    let expected: bigint;
    try {
      expected = parseUnits(quote.fromAmount, 18);
    } catch {
      throw new Error('Invalid swap amount. Please refresh the quote.');
    }
    const isCrossChain = quote.fromToken.chainId !== quote.toToken.chainId;
    const ceiling = isCrossChain
      ? (expected * CROSS_CHAIN_VALUE_HEADROOM_NUM) / CROSS_CHAIN_VALUE_HEADROOM_DEN
      : expected;
    if (value > ceiling) {
      throw new Error('This quote asks to send more than your swap amount. Please refresh the quote.');
    }
  } else if (value !== 0n) {
    // ERC-20 sell: the input is pulled via allowance — any native value on
    // top is the backend asking for funds the user never agreed to send.
    throw new Error('This quote unexpectedly asks for native funds. Please refresh the quote.');
  }

  let normalisedGasLimit: bigint | undefined;
  if (tx.gasLimit !== undefined && tx.gasLimit !== null && tx.gasLimit !== '') {
    try {
      normalisedGasLimit = typeof tx.gasLimit === 'bigint' ? tx.gasLimit : BigInt(tx.gasLimit);
    } catch {
      throw new Error('Invalid gas limit on quote. Please refresh.');
    }
    if (normalisedGasLimit <= 0n || normalisedGasLimit > MAX_TX_GAS_LIMIT) {
      throw new Error('Quote returned an unreasonable gas limit. Please refresh.');
    }
  }

  return {
    to: checksummedTo,
    data: tx.data,
    value: tx.value,
    gasLimit: normalisedGasLimit,
  };
}

/**
 * Validate an approval (spender) address before any allowance is read or
 * granted against it. Pure and exported for the same Karma reason as
 * `validateSwapTransactionRequest`. Returns the checksummed address, or
 * `undefined` when the quote carries none (native sells need no approval).
 *
 * Rejects: malformed addresses, a spender equal to the sell token itself
 * (approving a token to spend itself is never a legitimate aggregator
 * pattern — it's how `transferFrom`-style drains are set up), and any
 * spender outside the aggregator's verified allowlist when one exists.
 */
export function validateApprovalAddress(
  approvalAddress: string | undefined,
  quote: SwapQuote,
): string | undefined {
  if (!approvalAddress) return undefined;

  if (!isAddress(approvalAddress)) {
    throw new Error('Invalid approval address on quote. Please refresh the quote.');
  }
  const checksummed = getAddress(approvalAddress);

  if (checksummed.toLowerCase() === quote.fromToken.address.toLowerCase()) {
    throw new Error("This quote's approval address looks unsafe. Please refresh the quote.");
  }

  const aggregator = resolveQuoteAggregator(quote);
  if (!aggregator) {
    // Fail closed, mirroring validateSwapTransactionRequest: an approval
    // spender on a quote with no aggregator identity cannot be verified.
    throw verifiedListError('approval');
  }
  assertVerifiedAggregatorContract(
    aggregator,
    quote.fromToken.chainId,
    checksummed,
    'approval',
  );

  return checksummed;
}

export type SwapStatus = 'signing' | 'pending' | 'confirming' | 'completed';

/**
 * Result of a broadcast swap. `confirmed: false` means the transaction was
 * accepted by the network but no receipt arrived within the wait window —
 * "broadcast ok, confirmation unknown", NOT success. Callers must never
 * present an unconfirmed result as a completed swap.
 */
export interface SwapExecutionResult {
  hash: string;
  explorerUrl: string;
  confirmed: boolean;
}

/**
 * The wallet's "insufficient funds" error always refers to the NATIVE
 * balance (value + gas), but the right advice depends on what is being
 * sold. Selling the native token: value and gas come out of the same
 * balance, so a smaller amount genuinely fixes it. Selling an ERC-20:
 * the token amount is fine — the gas account is empty, and "try a smaller
 * percentage" is nonsense; the only fix is topping up the native token.
 */
export function insufficientFundsMessage(isNativeSwap: boolean, chainId: number): string {
  const native = getNetworkById(chainId)?.nativeSymbol ?? 'ETH';
  if (isNativeSwap) {
    return `Not enough ${native} for the swap amount plus network fees. Try a smaller percentage of your balance.`;
  }
  return `Not enough ${native} to pay network fees — top up your ${native} balance on ${getNetworkName(chainId)}.`;
}

/**
 * Outcome of a pre-sign `eth_call` simulation. `ok: true` means the swap
 * would succeed against the current chain state. `ok: false` means the
 * router contract reverted — `reason` is a user-friendly message; `kind`
 * lets the UI distinguish "wait for approval" from "slippage too tight".
 */
export type SimulationResult =
  | { ok: true }
  | { ok: false; reason: string; kind: 'allowance' | 'slippage' | 'transfer' | 'unknown' };

/**
 * LI.FI / DEX aggregator slippage reverts carry NO revert string — they surface
 * as a bare 4-byte custom-error selector that the text matcher can never catch.
 * Map the known ones explicitly (selectors verified via keccak):
 *   0xe52970aa  InsufficientAmountOut()                       — LI.FI GenericSwapFacetV3
 *   0x275c273c  CumulativeSlippageTooHigh(uint256,uint256)    — LI.FI
 */
const SLIPPAGE_ERROR_SELECTORS = new Set<string>(['0xe52970aa', '0x275c273c']);

const SLIPPAGE_REASON =
  'Price moved beyond your slippage tolerance. Refresh the quote, or raise your slippage in settings.';

/**
 * Pull the 4-byte revert selector (e.g. `0xe52970aa`) out of an ethers v6 error.
 * A custom error with no string args lands in `error.data` — or a nested
 * provider-error `data` (`error.info.error.data`, `error.error.data`) — never in
 * `message`. Returns the lowercased `0x…` selector, or null when absent.
 */
export function revertSelectorOf(error: unknown): string | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  while (stack.length) {
    const e = stack.pop();
    if (!e || typeof e !== 'object' || seen.has(e)) continue;
    seen.add(e);
    const rec = e as Record<string, unknown>;
    const d = rec['data'];
    if (typeof d === 'string' && /^0x[0-9a-fA-F]{8}/.test(d)) {
      return d.slice(0, 10).toLowerCase();
    }
    stack.push(rec['info'], rec['error'], rec['cause'], rec['revert']);
  }
  return null;
}

/** Structural shape of ethers v6 / aggregator errors we inspect. */
interface ProviderErrorLike {
  code?: string | number;
  reason?: string;
  shortMessage?: string;
  message?: string;
  data?: string;
  revert?: { args?: unknown[]; message?: string };
}

/**
 * Narrow an unknown thrown value to the structural error shape. Non-object /
 * null thrown values intentionally degrade to `{}` so callers (`parseSwapError`,
 * `classifySwapRevert`) fall through to their generic fallback message instead
 * of throwing — a deliberate hardening over the old direct-access code (which
 * would TypeError on a null throw and swallow the user-facing message),
 * accepted at review.
 */
function asProviderError(err: unknown): ProviderErrorLike {
  return (typeof err === 'object' && err !== null ? err : {}) as ProviderErrorLike;
}

/**
 * Classify a swap-router revert into a user-facing reason. Pure (no `this`) so
 * it is unit-testable without a provider. Order matters: a known custom-error
 * selector wins before the text heuristics AND before the "missing revert data"
 * fail-open — otherwise a no-string slippage revert is mis-read as success.
 */
export function classifySwapRevert(err: unknown): SimulationResult {
  const e = asProviderError(err);
  const selector = revertSelectorOf(err);
  if (selector && SLIPPAGE_ERROR_SELECTORS.has(selector)) {
    return { ok: false, reason: SLIPPAGE_REASON, kind: 'slippage' };
  }

  const blob = [e.reason, e.shortMessage, e.revert?.args?.[0], e.message]
    .filter((x: unknown): x is string => typeof x === 'string')
    .join(' | ')
    .toLowerCase();

  // "missing revert data" is what ethers v6 says when eth_call fails without a
  // clean revert reason — typical for routers that delegate-call through
  // proxies, wrap calldata in multicall, or otherwise can't be simulated
  // cleanly without full mempool state. Most still execute when broadcast, so
  // flagging them "would revert" is a false-positive scare. Fail open — but
  // only AFTER the selector check above, so a real (no-string) slippage revert
  // is not swallowed here.
  if (blob.includes('missing revert data')) {
    return { ok: true };
  }

  // Common patterns we can rephrase for the user. Conservative — only remap
  // when we're confident, otherwise show the raw revert.
  if (blob.includes('insufficient allowance') || blob.includes('erc20: transfer amount exceeds allowance')) {
    return {
      ok: false,
      reason: 'Token approval not yet confirmed on-chain. Wait a few seconds and retry.',
      kind: 'allowance',
    };
  }
  if (
    blob.includes('min return not reached') ||
    blob.includes('return amount is not enough') ||
    blob.includes('slippage') ||
    blob.includes('insufficientamountout') ||
    blob.includes('cumulativeslippagetoohigh')
  ) {
    return { ok: false, reason: SLIPPAGE_REASON, kind: 'slippage' };
  }
  if (blob.includes('transfer_from_failed') || blob.includes('transferfrom failed') || blob.includes('safe_transfer_from_failed')) {
    return {
      ok: false,
      reason: 'Token transfer was blocked. The contract may be paused or your balance changed.',
      kind: 'transfer',
    };
  }

  const raw = e.shortMessage || e.reason || e.message || 'Transaction would revert on-chain';
  return { ok: false, reason: raw, kind: 'unknown' };
}

/**
 * Broadcast gate policy. Block ONLY on a confident on-chain revert
 * (slippage / allowance / transfer); fail OPEN on `unknown` — which also covers
 * infra failures (no RPC, wallet not connected) — so a network hiccup never
 * blocks an otherwise-good swap.
 */
export function shouldBlockBroadcast(sim: SimulationResult): boolean {
  return !sim.ok && (sim.kind === 'slippage' || sim.kind === 'allowance' || sim.kind === 'transfer');
}

@Injectable({
  providedIn: 'root',
})
export class SwapExecutionService {
  private walletService = inject(WalletService);
  private chainService = inject(ChainService);

  /**
   * Reentrancy guard. A double-click on Confirm — or any caller that fires
   * `executeSwap` twice before the first resolves — would otherwise produce
   * two parallel `signer.sendTransaction` calls. Privy's embedded wallet
   * auto-signs with no UI prompt, so it can broadcast both before the user
   * sees anything. The component-level `[disabled]` on the button is a soft
   * guard; this flag is the hard one.
   */
  private isExecuting = false;

  /**
   * Indirection over the module-level receipt util so unit tests can stub
   * the network without monkey-patching the ES module.
   */
  private fetchReceipt: typeof fetchReceiptWithFallback = fetchReceiptWithFallback;

  /**
   * Execute a swap using the cached LI.FI quote
   *
   * CRITICAL: Uses the SAME quote that was approved by user.
   * Never fetch a fresh quote here - different routes have different approvalAddresses.
   */
  async executeSwap(
    quote: SwapQuote,
    onStatusChange?: (status: SwapStatus, hash?: string) => void,
    opts?: { skipSimulationGate?: boolean },
  ): Promise<SwapExecutionResult> {
    if (this.isExecuting) {
      throw new Error('A swap is already in progress. Please wait for it to complete.');
    }
    this.isExecuting = true;

    try {
      // Check quote freshness
      this.validateQuoteAge(quote);

      // Ensure correct chain
      const requiredChainId = quote.fromToken.chainId;
      await this.ensureCorrectChain(requiredChainId);

      // Get signer
      const signer = this.walletService.getSigner();
      if (!signer) {
        throw new Error('Wallet not connected');
      }

      // Get transaction data from quote (backend aggregator or LI.FI SDK).
      // `validateSwapTransactionRequest` guards against malformed / hostile
      // backend responses (unknown contracts, native-value overreach) before
      // they reach the signer.
      const transactionRequest = validateSwapTransactionRequest(
        this.extractTransactionRequest(quote),
        quote,
      );

      try {
        // Final pre-broadcast gate: re-simulate the EXACT calldata and refuse to
        // spend gas on a definitively-reverting swap. This closes the hole where
        // a quote-supplied `gasLimit` skips `estimateGas` (the only other on-chain
        // pre-check). Same-chain only — `simulateSwap` no-ops cross-chain. Skipped
        // when the user explicitly acknowledged a revert at review and chose to
        // proceed. Fails OPEN on anything but a confident revert (see
        // `shouldBlockBroadcast`) so an RPC hiccup never blocks a good swap.
        if (!opts?.skipSimulationGate) {
          const sim = await this.simulateSwap(quote);
          if (!sim.ok && shouldBlockBroadcast(sim)) {
            throw new Error(sim.reason);
          }
        }

        onStatusChange?.('signing');

        // Estimate gas if needed
        let gasLimit = transactionRequest.gasLimit;
        if (!gasLimit) {
          gasLimit = await this.estimateGas(signer, transactionRequest);
        }

        // Send transaction. `chainId` is pinned to the quote's source chain:
        // a wallet that silently reverted to another network hard-fails the
        // signature instead of broadcasting the calldata to the wrong chain.
        const tx = await signer.sendTransaction({
          to: transactionRequest.to,
          data: transactionRequest.data,
          value: transactionRequest.value || '0',
          gasLimit,
          chainId: requiredChainId,
        });

        onStatusChange?.('pending', tx.hash);

        // Inspect the receipt's `status` so an on-chain revert (status === 0)
        // surfaces as an error instead of being silently reported as "completed"
        // — ethers v6's `waitForTransaction` does NOT throw on revert, it
        // resolves with a receipt whose status is 0.
        //
        // The wallet's own provider may throw before we ever see the receipt:
        // Privy embedded wallets return `nonce: "undefined"` (string) on the
        // receipt RPC response, which crashes ethers v6's parser. When that
        // happens we fall back to a fresh public-RPC `JsonRpcProvider` for the
        // chain, which parses the same response cleanly.
        const receipt = await this.fetchReceipt(
          signer.provider,
          tx.hash,
          requiredChainId,
        );

        if (receipt && receipt.status === 0) {
          // The receipt has no revert reason — recover a user-facing cause
          // (slippage / allowance / transfer) instead of a generic "couldn't
          // complete". `parseSwapError` passes the message through unchanged.
          throw new Error(await this.describeFailedReceipt(quote));
        }

        // A null receipt means "broadcast ok, confirmation unknown" (both
        // the wallet provider and the public-RPC fallback gave up) — NOT
        // success. Emitting 'completed' here painted a false success screen
        // and wrote a success history record for a tx that may never mine.
        // 'confirming' keeps the UI honest; the caller decides how to keep
        // watching (background re-poll / history stays pending).
        if (receipt) {
          onStatusChange?.('completed', tx.hash);
        } else {
          onStatusChange?.('confirming', tx.hash);
        }

        return {
          hash: tx.hash,
          explorerUrl: this.chainService.getExplorerUrl(requiredChainId, tx.hash),
          confirmed: receipt !== null,
        };
      } catch (error: any) {
        throw this.parseSwapError(error, quote);
      }
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Check if token needs approval before swap
   */
  async checkApproval(quote: SwapQuote): Promise<{
    needsApproval: boolean;
    currentAllowance: string;
    requiredAmount: string;
    spenderAddress: string;
  }> {
    const fromToken = quote.fromToken;

    // Native tokens don't need approval
    if (this.isNativeToken(fromToken)) {
      return {
        needsApproval: false,
        currentAllowance: 'unlimited',
        requiredAmount: quote.fromAmount,
        spenderAddress: '',
      };
    }

    const approvalAddress = this.extractApprovalAddress(quote);

    if (!approvalAddress) {
      return {
        needsApproval: false,
        currentAllowance: 'unlimited',
        requiredAmount: quote.fromAmount,
        spenderAddress: '',
      };
    }

    try {
      const provider = this.walletService.getProvider();
      const userAddress = this.walletService.address();

      if (!provider || !userAddress) {
        return {
          needsApproval: true,
          currentAllowance: '0',
          requiredAmount: quote.fromAmount,
          spenderAddress: approvalAddress,
        };
      }

      const contract = new Contract(fromToken.address, ERC20_ABI, provider);
      const allowance = await contract['allowance'](userAddress, approvalAddress);
      const requiredAmount = parseUnits(quote.fromAmount, fromToken.decimals);

      return {
        needsApproval: allowance < requiredAmount,
        currentAllowance: allowance.toString(),
        requiredAmount: requiredAmount.toString(),
        spenderAddress: approvalAddress,
      };
    } catch (error) {
      console.error('[Swap] Error checking approval:', error);
      return {
        needsApproval: true,
        currentAllowance: '0',
        requiredAmount: quote.fromAmount,
        spenderAddress: approvalAddress,
      };
    }
  }

  /**
   * Approve token for swap (exact fromAmount + 1% round-up).
   * The small buffer protects against silent re-quote nudging the required
   * input up by a tiny amount; anything larger bloats the upper-bound of
   * what the spender contract can pull.
   */
  async approveToken(quote: SwapQuote): Promise<string> {
    const fromToken = quote.fromToken;

    if (this.isNativeToken(fromToken)) {
      return '';
    }

    // Ensure correct chain
    await this.ensureCorrectChain(fromToken.chainId);

    const approvalAddress = this.extractApprovalAddress(quote);

    if (!approvalAddress) {
      throw new Error('No approval address found');
    }

    const signer = this.walletService.getSigner();
    if (!signer) {
      throw new Error('Wallet not connected');
    }

    try {
      const contract = new Contract(fromToken.address, ERC20_ABI, signer);

      // USDT (and a handful of older tokens) revert on `approve` if the
      // existing allowance is non-zero — they require an explicit reset to 0
      // first. Catch the rejection here so the user sees a USDT-specific
      // message instead of generic "Failed to approve token", and so a
      // subsequent re-attempt isn't blocked by the outer catch swallowing
      // context.
      const userAddress = this.walletService.address();
      if (userAddress) {
        const currentAllowance = await contract['allowance'](userAddress, approvalAddress);
        if (currentAllowance > 0n) {
          try {
            // chainId pinned for the same reason as the swap tx: a wallet on
            // the wrong network must hard-fail, not approve on another chain.
            const resetTx = await contract['approve'](approvalAddress, 0, {
              chainId: fromToken.chainId,
            });
            if (signer.provider) {
              // Same Privy embedded-wallet issue as the main approve wait below:
              // nonce:"undefined" crashes ethers' receipt parser, and mainnet
              // inclusion can exceed 30s. The reset tx is already broadcast —
              // nonce ordering guarantees it mines before the follow-up approve,
              // so a failed *wait* must not abort the flow.
              try {
                await signer.provider.waitForTransaction(resetTx.hash, 1, 30000);
              } catch (waitError) {
                console.warn(
                  '[Swap] USDT reset waitForTransaction failed or timed out (reset tx already sent):',
                  (waitError as { code?: string })?.code,
                );
              }
            }
          } catch (resetError: any) {
            if (resetError?.code === 'ACTION_REJECTED' || resetError?.code === 4001) {
              // Kept short: presentError treats >120 chars as technical, and
              // the old long phrasing left almost no headroom for the symbol.
              // (error-presenter also whitelists this template by prefix.)
              throw new Error(
                `${fromToken.symbol} needs its old allowance reset to zero first — approve the reset transaction.`,
              );
            }
            throw new Error(
              `Couldn't reset existing ${fromToken.symbol} allowance: ${resetError?.shortMessage || resetError?.message || 'unknown error'}.`,
            );
          }
        }
      }

      // 1% round-up — exact fromAmount is the honest number. Extra 1%
      // absorbs silent re-quote drift without meaningfully widening the
      // attack surface if the spender contract ever goes rogue.
      const exactAmount = parseUnits(quote.fromAmount, fromToken.decimals);
      const amount = (exactAmount * 101n) / 100n;
      // chainId pinned — see the reset branch above.
      const tx = await contract['approve'](approvalAddress, amount, {
        chainId: fromToken.chainId,
      });

      // Wait for confirmation - same nonce issue with Privy embedded wallets
      try {
        const provider = signer.provider;
        if (provider) {
          await provider.waitForTransaction(tx.hash, 1, 30000);
        }
      } catch (waitError) {
        console.warn('[Swap] approve waitForTransaction failed or timed out (tx already sent):', (waitError as any)?.code);
      }

      return tx.hash;
    } catch (error: any) {
      if (error.code === 'ACTION_REJECTED') {
        throw new Error('Transaction was rejected by user');
      }
      throw new Error(error.message || 'Failed to approve token');
    }
  }

  /**
   * Pre-sign simulation. Runs `eth_call` against the swap calldata so the
   * UI can show "Will succeed ✓" / "Would revert: <reason>" *before* the
   * user signs. Lets us catch:
   *   - approval still in mempool ("insufficient allowance")
   *   - quote drifted past slippage ("Min return not reached")
   *   - random router revert from a malformed quote
   *
   * Cross-chain bridges deliberately skip simulation: bridge entry contracts
   * (LI.FI Diamond, Squid Router) often revert on plain `eth_call` because
   * they require off-chain attestation / relayer state that only exists at
   * broadcast time. Simulating them produces false-positive "missing revert
   * data" results that scare users off legitimate trades.
   *
   * Best-effort by design: a network failure on the RPC side resolves to
   * `ok: false` with `kind: 'unknown'`. Caller decides whether to gate the
   * Confirm CTA — we never broadcast based on simulation alone.
   */
  async simulateSwap(quote: SwapQuote): Promise<SimulationResult> {
    // Same chain only — see header comment for why.
    if (quote.fromToken.chainId !== quote.toToken.chainId) {
      return { ok: true };
    }

    const requiredChainId = quote.fromToken.chainId;

    let txReq: { to: string; data: string; value?: string };
    try {
      txReq = validateSwapTransactionRequest(this.extractTransactionRequest(quote), quote);
    } catch (err: any) {
      return { ok: false, reason: err?.message || 'Invalid transaction request', kind: 'unknown' };
    }

    const userAddress = this.walletService.address();
    if (!userAddress) {
      return { ok: false, reason: 'Wallet not connected', kind: 'unknown' };
    }

    const provider = await this.getReadProviderForChain(requiredChainId);
    if (!provider) {
      return { ok: false, reason: 'No network connection for pre-check', kind: 'unknown' };
    }

    try {
      await provider.call({
        from: userAddress,
        to: txReq.to,
        data: txReq.data,
        value: txReq.value || '0x0',
      });
      return { ok: true };
    } catch (err: any) {
      return this.classifyRevert(err);
    }
  }

  /**
   * Wallet provider when it's already on the requested chain (cheapest;
   * no extra socket); otherwise fall back to a fresh public RPC. Mirrors
   * the strategy used in `pollPublicRpcReceipt`.
   */
  private async getReadProviderForChain(chainId: number): Promise<any | null> {
    const walletChainId = this.walletService.chainId();
    if (walletChainId === chainId) {
      const wallet = this.walletService.getProvider();
      if (wallet) return wallet;
    }
    const urls = PUBLIC_RPCS[chainId];
    if (!urls || urls.length === 0) return null;
    for (const url of urls) {
      try {
        const provider = new JsonRpcProvider(url);
        await provider.getNetwork();
        return provider;
      } catch {
        // try next
      }
    }
    return null;
  }

  // Thin instance wrapper over the pure `classifySwapRevert` (kept so the
  // simulateSwap call site reads naturally; the logic + tests live module-level).
  private classifyRevert(err: unknown): SimulationResult {
    return classifySwapRevert(err);
  }

  /**
   * Best-effort reason for a receipt that reverted (status 0). The receipt
   * carries no revert reason, so re-run the same swap as an `eth_call` and
   * classify it. When the call now passes (state moved since inclusion —
   * typical for a marginal slippage swap that cleared the pre-check then
   * drifted under min-out) the dominant cause is price drift, so we say so
   * plainly. Never throws — always returns a user-facing string.
   */
  private async describeFailedReceipt(quote: SwapQuote): Promise<string> {
    try {
      const sim = await this.simulateSwap(quote);
      if (!sim.ok) return sim.reason;
    } catch {
      // Inconclusive (RPC down, etc.) — fall through to the honest default.
    }
    // simulateSwap no-ops for cross-chain (returns ok:true), so we never recover
    // a specific reason there — don't assert "slippage" we didn't verify.
    if (quote.fromToken.chainId !== quote.toToken.chainId) {
      return (
        'The cross-chain swap reverted on its source chain. Open it in the ' +
        'explorer for details, then refresh the quote and try again.'
      );
    }
    return (
      'The swap reverted on-chain. This usually means the price moved past your ' +
      'slippage tolerance between preview and execution — refresh the quote, and ' +
      'if it keeps failing, raise your slippage in settings.'
    );
  }

  /**
   * Check if token is native (ETH, POL, etc.)
   */
  isNativeToken(token: Token): boolean {
    return isNativeTokenAddress(token.address);
  }

  // ---------------------------------------------------------------------------
  // Private: Transaction Data Extraction
  // ---------------------------------------------------------------------------

  /**
   * Extract transaction request data from a quote.
   * Supports both backend aggregator API and LI.FI SDK paths.
   */
  private extractTransactionRequest(quote: SwapQuote): {
    to: string;
    data: string;
    value?: string;
    gasLimit?: string | bigint;
  } {
    // Path 1: Backend multi-aggregator API
    if (quote._aggregatorData?.tx_request) {
      const tx = quote._aggregatorData.tx_request;
      return {
        to: tx.to,
        data: tx.data,
        value: tx.value,
        gasLimit: tx.gas_limit,
      };
    }

    // Path 2: LI.FI SDK (fallback)
    if (quote._lifiRoute?.transactionRequest) {
      return quote._lifiRoute.transactionRequest;
    }

    throw new Error('Invalid quote - missing transaction data');
  }

  /**
   * Extract the approval (spender) address from a quote and run it through
   * the trust-boundary checks (`validateApprovalAddress`): well-formed,
   * not the sell token itself, and on the aggregator's verified contract
   * allowlist when one exists. Each aggregator maps its own field to a
   * unified approvalAddress.
   */
  private extractApprovalAddress(quote: SwapQuote): string | undefined {
    // Path 1: Backend multi-aggregator API
    if (quote._aggregatorData) {
      return validateApprovalAddress(quote._aggregatorData.approval_address || undefined, quote);
    }

    // Path 2: LI.FI SDK
    return validateApprovalAddress(quote._lifiRoute?.estimate?.approvalAddress, quote);
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  private validateQuoteAge(quote: SwapQuote): void {
    if (!quote.createdAt) return;

    const age = Date.now() - quote.createdAt;

    if (age > QUOTE_EXPIRED_AGE_MS) {
      throw new Error('Quote expired. Please refresh and try again.');
    }

    if (age > QUOTE_WARNING_AGE_MS) {
      console.warn('[Swap] Quote is getting stale');
    }
  }

  private async ensureCorrectChain(chainId: number): Promise<void> {
    const currentChainId = this.walletService.chainId();

    if (currentChainId !== chainId) {
      const switched = await this.walletService.ensureCorrectChain(chainId);
      if (!switched) {
        throw new Error(`Please switch to ${this.chainService.getChainName(chainId)} network`);
      }
    }
  }

  private async estimateGas(signer: any, tx: any): Promise<bigint> {
    try {
      const estimated = await signer.estimateGas({
        to: tx.to,
        data: tx.data,
        value: tx.value || '0',
      });
      // Add 20% buffer
      return (estimated * 120n) / 100n;
    } catch (error: any) {
      throw new Error('Transaction would fail. Try refreshing the quote.');
    }
  }

  private parseSwapError(error: unknown, quote: SwapQuote): Error {
    const e = asProviderError(error);
    if (e.code === 'ACTION_REJECTED' || e.code === 4001) {
      return new Error('Transaction was rejected by user');
    }

    // No-string slippage custom errors (e.g. LI.FI `InsufficientAmountOut()`)
    // arrive as a bare selector in `error.data`; the text checks below miss them.
    const selector = revertSelectorOf(error);
    if (selector && SLIPPAGE_ERROR_SELECTORS.has(selector)) {
      return new Error(SLIPPAGE_REASON);
    }

    const message = e.message || '';
    const shortMessage = e.shortMessage || '';

    if (message.includes('Min return not reached')) {
      return new Error('Price changed too much. Try increasing slippage.');
    }
    if (message.includes('insufficient funds')) {
      // The wallet's "insufficient funds" check covers value + gas on the
      // NATIVE balance. The advice must match what is being sold — telling
      // a USDC seller with zero ETH to "try a smaller percentage" is
      // nonsense (see insufficientFundsMessage).
      return new Error(
        insufficientFundsMessage(this.isNativeToken(quote.fromToken), quote.fromToken.chainId),
      );
    }
    if (message.includes('insufficient allowance')) {
      return new Error('Token approval expired. Please approve again.');
    }
    if (e.code === 'CALL_EXCEPTION') {
      const reason = e.reason || e.revert?.message;
      if (reason && reason !== 'null') {
        return new Error(`Swap failed: ${reason}`);
      }
      return new Error('Quote expired. Please refresh and try again.');
    }

    return new Error(shortMessage || message || 'Failed to execute swap');
  }
}
