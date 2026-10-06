/**
 * Pure-helper tests for SwapExecutionService.
 *
 * No TestBed: every function under test is a pure export — pulling the
 * wallet/Privy DI graph into Karma breaks the run (webpack can't parse the
 * `with type: 'json'` imports inside the @privy-io dependency tree).
 *
 * Covers the transaction trust boundary (public-test audit #9/#10):
 *  - verified-contract allowlist on the calldata target and the approval
 *    spender (defense-in-depth mirror of the backend allowlist);
 *  - native-value ceiling: a quote may never ask the wallet to send more
 *    native funds than the user confirmed on review;
 *  - insufficientFundsMessage advice copy.
 *
 * (The `approveToken` describe at the bottom is the exception — it stubs
 * WalletService with a spy object, same pattern as send.service.spec.ts, so
 * the real Privy/RPC dependency tree is never instantiated.)
 */
import { TestBed } from '@angular/core/testing';
import { AbiCoder } from 'ethers';
import type { JsonRpcSigner } from 'ethers';
import {
  insufficientFundsMessage,
  validateSwapTransactionRequest,
  validateApprovalAddress,
  revertSelectorOf,
  classifySwapRevert,
  shouldBlockBroadcast,
  SwapExecutionService,
} from './swap-execution.service';
import { AggregatorName, SwapQuote } from '../../models/swap.model';
import { Token } from '../../models/token.model';
import { WalletService } from '../wallet.service';

// Published contracts (EIP-55, as upstreams return them) — must match the
// lowercase allowlist in aggregator-contracts.constant.ts.
const ZEROX_ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734';
const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
const ODOS_ROUTER_ETHEREUM = '0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559';
const ODOS_ROUTER_BASE = '0x19cEeAd7105607Cd444F5ad10dd51356436095a1';
const SQUID_ROUTER = '0xce16F69375520ab01377ce7B88f5BA8C48F8D666';

/** A well-formed address that is on NO allowlist (Permit2). */
const UNLISTED_CONTRACT = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const NATIVE_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
// Lowercase on purpose: token addresses are only ever compared lowercased,
// and a hand-typed EIP-55 form would be a checksum landmine in fixtures.
const USDC_ETHEREUM = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

const ONE_ETH_WEI = 1_000_000_000_000_000_000n;

function makeToken(overrides: Partial<Token> = {}): Token {
  return {
    address: USDC_ETHEREUM,
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    chainId: 1,
    ...overrides,
  };
}

function makeQuote(overrides: Partial<SwapQuote> = {}): SwapQuote {
  return {
    id: 'q-test',
    fromToken: makeToken(),
    toToken: makeToken({ symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 }),
    fromAmount: '1',
    toAmount: '0.0005',
    fromAmountUSD: '1.00',
    toAmountUSD: '0.99',
    exchangeRate: '1 USDC = 0.0005 WETH',
    priceImpact: '0',
    gasCost: '0',
    gasCostUSD: '1.00',
    estimatedTime: 30,
    route: [],
    slippage: 0.5,
    minimumReceived: '0.000497',
    ...overrides,
  };
}

function makeTx(overrides: Partial<{ to: string; data: string; value?: string; gasLimit?: string | bigint }> = {}): {
  to: string;
  data: string;
  value?: string;
  gasLimit?: string | bigint;
} {
  return { to: ZEROX_ALLOWANCE_HOLDER, data: '0x12345678abcd', ...overrides };
}

describe('insufficientFundsMessage', () => {
  it('advises a smaller percentage only when the NATIVE token is being sold', () => {
    const msg = insufficientFundsMessage(true, 1);
    expect(msg).toContain('ETH');
    expect(msg).toContain('smaller percentage');
  });

  it('advises topping up the native token for an ERC-20 swap — never a smaller amount', () => {
    // A USDC seller with zero ETH: the token amount is fine, the gas
    // account is empty. "Try a smaller percentage" cannot help.
    const msg = insufficientFundsMessage(false, 1);
    expect(msg).toContain('top up your ETH balance');
    expect(msg).toContain('Ethereum');
    expect(msg).not.toContain('smaller percentage');
  });

  it('names the chain-specific native token (POL on Polygon)', () => {
    const native = insufficientFundsMessage(true, 137);
    expect(native).toContain('POL');

    const erc20 = insufficientFundsMessage(false, 137);
    expect(erc20).toContain('top up your POL balance');
    expect(erc20).toContain('Polygon');
  });

  it('falls back to ETH for an unknown chain instead of breaking the copy', () => {
    const msg = insufficientFundsMessage(false, 999999);
    expect(msg).toContain('ETH');
  });
});

describe('validateSwapTransactionRequest — verified-contract allowlist (#9)', () => {
  it('accepts the published 0x AllowanceHolder for a zerox quote (EIP-55 vs lowercase list)', () => {
    const quote = makeQuote({ aggregator: 'zerox' });
    const result = validateSwapTransactionRequest(makeTx(), quote);
    expect(result.to).toBe(ZEROX_ALLOWANCE_HOLDER);
  });

  it('rejects a calldata target outside the verified list for the aggregator', () => {
    const quote = makeQuote({ aggregator: 'zerox' });
    expect(() =>
      validateSwapTransactionRequest(makeTx({ to: UNLISTED_CONTRACT }), quote),
    ).toThrowError(/verified list/);
  });

  it('keys the allowlist on the chain the tx executes on — the ODOS mainnet router is rejected on Base', () => {
    const baseQuote = makeQuote({
      aggregator: 'odos',
      fromToken: makeToken({ chainId: 8453 }),
      toToken: makeToken({ symbol: 'WETH', decimals: 18, chainId: 8453 }),
    });
    expect(() =>
      validateSwapTransactionRequest(makeTx({ to: ODOS_ROUTER_ETHEREUM }), baseQuote),
    ).toThrowError(/verified list/);
    expect(
      validateSwapTransactionRequest(makeTx({ to: ODOS_ROUTER_BASE }), baseQuote).to,
    ).toBe(ODOS_ROUTER_BASE);
  });

  it('uses the FROM chain for cross-chain quotes — the chain the tx executes on', () => {
    const crossQuote = makeQuote({
      aggregator: 'squid',
      fromToken: makeToken({ chainId: 42161 }),
      toToken: makeToken({ symbol: 'WETH', decimals: 18, chainId: 8453 }),
    });
    expect(
      validateSwapTransactionRequest(makeTx({ to: SQUID_ROUTER }), crossQuote).to,
    ).toBe(SQUID_ROUTER);
  });

  it('fails CLOSED for the known-disabled aggregator (paraswap) — no fail-open exemption', () => {
    // paraswap's allowlist is empty (adapter off backend-side). The label is
    // backend-controlled, so it must NOT be a way to skip verification.
    const quote = makeQuote({ aggregator: 'paraswap' });
    expect(() =>
      validateSwapTransactionRequest(makeTx({ to: UNLISTED_CONTRACT }), quote),
    ).toThrowError(/verified list/);
  });

  it('enforces the lifi allowlist on legacy LI.FI SDK quotes (no aggregator field)', () => {
    const legacyQuote = makeQuote({ _lifiRoute: {} });
    expect(
      validateSwapTransactionRequest(makeTx({ to: LIFI_DIAMOND }), legacyQuote).to,
    ).toBe(LIFI_DIAMOND);
    expect(() =>
      validateSwapTransactionRequest(makeTx({ to: UNLISTED_CONTRACT }), legacyQuote),
    ).toThrowError(/verified list/);
  });

  it('fails CLOSED on an unknown aggregator name — the label comes from the backend response', () => {
    // `quote.aggregator` is attacker-influenced on a compromised backend: a
    // hostile response must not pick its own (unlisted) label to dodge the
    // allowlist. Only the explicit known-disabled set (paraswap) fails open.
    const quote = makeQuote({ aggregator: 'evilaggregator' as AggregatorName });
    expect(() =>
      validateSwapTransactionRequest(makeTx({ to: UNLISTED_CONTRACT }), quote),
    ).toThrowError(/verified list/);
    // Even a published contract is rejected — there is no verified list to
    // match it against, so nothing about the quote is trustworthy.
    expect(() =>
      validateSwapTransactionRequest(makeTx({ to: LIFI_DIAMOND }), quote),
    ).toThrowError(/verified list/);
  });

  it('fails CLOSED for a known aggregator on a chain without a verified list', () => {
    // All supported chains have allowlist entries; a quote executing on an
    // unsupported chain cannot be verified and must not reach the signer.
    const goerliQuote = makeQuote({
      aggregator: 'zerox',
      fromToken: makeToken({ chainId: 5 }),
      toToken: makeToken({ symbol: 'WETH', decimals: 18, chainId: 5 }),
    });
    expect(() =>
      validateSwapTransactionRequest(makeTx(), goerliQuote),
    ).toThrowError(/verified list/);
  });

  it('fails CLOSED on a bare quote (no aggregator name, no LI.FI route)', () => {
    // No production path produces this shape: backend quotes get
    // `aggregator` stamped in QuoteService.convertAggregatorQuote and SDK
    // fallback quotes carry `_lifiRoute`. A quote with calldata but no
    // aggregator identity is a malformed or hostile response — reject it
    // instead of skipping verification.
    const bareQuote = makeQuote();
    expect(() =>
      validateSwapTransactionRequest(makeTx({ to: UNLISTED_CONTRACT }), bareQuote),
    ).toThrowError(/verified list/);
    expect(() =>
      validateSwapTransactionRequest(makeTx({ to: LIFI_DIAMOND }), bareQuote),
    ).toThrowError(/verified list/);
  });
});

describe('validateSwapTransactionRequest — native value ceiling (#10)', () => {
  function nativeQuote(toChainId: number): SwapQuote {
    return makeQuote({
      aggregator: 'zerox',
      fromToken: makeToken({ address: NATIVE_ADDRESS, symbol: 'ETH', decimals: 18 }),
      toToken: makeToken({ symbol: 'USDC', chainId: toChainId }),
      fromAmount: '1',
    });
  }

  interface ValueCase {
    name: string;
    quote: SwapQuote;
    value: string | undefined;
    expectError: RegExp | null;
  }

  const cases: ValueCase[] = [
    {
      name: 'native same-chain: value equal to the quoted amount passes',
      quote: nativeQuote(1),
      value: ONE_ETH_WEI.toString(),
      expectError: null,
    },
    {
      name: 'native same-chain: one wei above the quoted amount is rejected',
      quote: nativeQuote(1),
      value: (ONE_ETH_WEI + 1n).toString(),
      expectError: /more than your swap amount/,
    },
    {
      name: 'native cross-chain: up to ×1.5 passes (bounded relayer-fee headroom)',
      quote: nativeQuote(8453),
      value: ((ONE_ETH_WEI * 3n) / 2n).toString(),
      expectError: null,
    },
    {
      name: 'native cross-chain: above ×1.5 is rejected',
      quote: nativeQuote(8453),
      value: ((ONE_ETH_WEI * 3n) / 2n + 1n).toString(),
      expectError: /more than your swap amount/,
    },
    {
      name: 'ERC-20: undefined value passes',
      quote: makeQuote({ aggregator: 'zerox' }),
      value: undefined,
      expectError: null,
    },
    {
      name: "ERC-20: '0' passes",
      quote: makeQuote({ aggregator: 'zerox' }),
      value: '0',
      expectError: null,
    },
    {
      name: "ERC-20: '0x0' passes",
      quote: makeQuote({ aggregator: 'zerox' }),
      value: '0x0',
      expectError: null,
    },
    {
      name: 'ERC-20: any non-zero native value is rejected (input is pulled via allowance)',
      quote: makeQuote({ aggregator: 'zerox' }),
      value: '1',
      expectError: /native funds/,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const run = (): unknown =>
        validateSwapTransactionRequest(makeTx({ value: c.value }), c.quote);
      if (c.expectError) {
        expect(run).toThrowError(c.expectError);
      } else {
        expect(run).not.toThrow();
      }
    });
  }

  it('rejects an unparseable native amount instead of skipping the ceiling', () => {
    const quote = nativeQuote(1);
    quote.fromAmount = 'not-a-number';
    expect(() =>
      validateSwapTransactionRequest(makeTx({ value: '1' }), quote),
    ).toThrowError(/Invalid swap amount/);
  });
});

describe('validateSwapTransactionRequest — gas-limit ceiling', () => {
  // MAX_TX_GAS_LIMIT is 5_000_000n. The ceiling is what stops a hostile or
  // broken backend from handing the wallet a gas limit that burns the user's
  // whole native balance on a transaction that was never going to succeed.
  const quote = (): SwapQuote => makeQuote({ aggregator: 'zerox' });

  it('accepts a gas limit just under the ceiling', () => {
    const result = validateSwapTransactionRequest(makeTx({ gasLimit: 4_999_999n }), quote());
    expect(result.gasLimit).toBe(4_999_999n);
  });

  it('accepts the ceiling itself (boundary is inclusive)', () => {
    const result = validateSwapTransactionRequest(makeTx({ gasLimit: 5_000_000n }), quote());
    expect(result.gasLimit).toBe(5_000_000n);
  });

  it('rejects one wei of gas ABOVE the ceiling', () => {
    expect(() =>
      validateSwapTransactionRequest(makeTx({ gasLimit: 5_000_001n }), quote()),
    ).toThrowError(/unreasonable gas limit/);
  });

  it('rejects a zero gas limit — "0" is not "unset"', () => {
    // The unset sentinel is undefined / '': an explicit '0' is a malformed
    // quote, not permission to let the wallet estimate.
    expect(() =>
      validateSwapTransactionRequest(makeTx({ gasLimit: '0' }), quote()),
    ).toThrowError(/unreasonable gas limit/);
    expect(() =>
      validateSwapTransactionRequest(makeTx({ gasLimit: 0n }), quote()),
    ).toThrowError(/unreasonable gas limit/);
  });

  it('rejects an over-ceiling limit given as a decimal string', () => {
    expect(() =>
      validateSwapTransactionRequest(makeTx({ gasLimit: '5000001' }), quote()),
    ).toThrowError(/unreasonable gas limit/);
  });

  it('leaves the gas limit unset when the quote omits it', () => {
    expect(validateSwapTransactionRequest(makeTx(), quote()).gasLimit).toBeUndefined();
    expect(validateSwapTransactionRequest(makeTx({ gasLimit: '' }), quote()).gasLimit).toBeUndefined();
  });
});

describe('validateApprovalAddress — spender trust boundary (#9)', () => {
  it('passes through an absent approval address (native sells need none)', () => {
    expect(validateApprovalAddress(undefined, makeQuote({ aggregator: 'zerox' }))).toBeUndefined();
    expect(validateApprovalAddress('', makeQuote({ aggregator: 'zerox' }))).toBeUndefined();
  });

  it('rejects a malformed approval address', () => {
    expect(() =>
      validateApprovalAddress('not-an-address', makeQuote({ aggregator: 'zerox' })),
    ).toThrowError(/Invalid approval address/);
  });

  it('rejects a spender equal to the sell token itself (case-insensitive)', () => {
    const quote = makeQuote({ aggregator: 'paraswap' });
    expect(() =>
      validateApprovalAddress(quote.fromToken.address.toLowerCase(), quote),
    ).toThrowError(/unsafe/);
  });

  it('accepts the published spender and returns it checksummed', () => {
    const quote = makeQuote({ aggregator: 'zerox' });
    expect(
      validateApprovalAddress(ZEROX_ALLOWANCE_HOLDER.toLowerCase(), quote),
    ).toBe(ZEROX_ALLOWANCE_HOLDER);
  });

  it('rejects a spender outside the verified list — rotating 0x Settler addresses must never be approved', () => {
    const quote = makeQuote({ aggregator: 'zerox' });
    expect(() => validateApprovalAddress(UNLISTED_CONTRACT, quote)).toThrowError(/verified list/);
  });

  it('fails CLOSED for the known-disabled aggregator (paraswap) — empty allowlist throws', () => {
    const quote = makeQuote({ aggregator: 'paraswap' });
    expect(() => validateApprovalAddress(UNLISTED_CONTRACT, quote)).toThrowError(/verified list/);
  });

  it('enforces the lifi allowlist for legacy LI.FI SDK quotes', () => {
    const legacyQuote = makeQuote({ _lifiRoute: {} });
    expect(validateApprovalAddress(LIFI_DIAMOND, legacyQuote)).toBe(LIFI_DIAMOND);
    expect(() => validateApprovalAddress(UNLISTED_CONTRACT, legacyQuote)).toThrowError(/verified list/);
  });

  it('fails CLOSED on an unknown aggregator name (backend-influenced label)', () => {
    const quote = makeQuote({ aggregator: 'evilaggregator' as AggregatorName });
    expect(() => validateApprovalAddress(UNLISTED_CONTRACT, quote)).toThrowError(/verified list/);
    expect(() => validateApprovalAddress(ZEROX_ALLOWANCE_HOLDER, quote)).toThrowError(/verified list/);
  });

  it('fails CLOSED on a bare quote that still carries an approval address', () => {
    // Same reasoning as the swap-target gate: no production quote is bare
    // (see that spec), so an unverifiable spender never gets an allowance.
    const bareQuote = makeQuote();
    expect(() => validateApprovalAddress(UNLISTED_CONTRACT, bareQuote)).toThrowError(/verified list/);
    // An ABSENT approval address on a bare quote stays fine — native sells
    // grant no allowance, so there is nothing to verify.
    expect(validateApprovalAddress(undefined, bareQuote)).toBeUndefined();
  });
});

describe('revertSelectorOf — pull the custom-error selector out of an ethers error', () => {
  it('reads a top-level `data` selector (no-string custom error)', () => {
    expect(revertSelectorOf({ data: '0xe52970aa' })).toBe('0xe52970aa');
  });

  it('reads a longer revert blob and keeps only the 4-byte selector', () => {
    // Error(string) shape: selector + offset + length + bytes — only the head matters.
    const blob = '0x08c379a0' + '0'.repeat(120);
    expect(revertSelectorOf({ data: blob })).toBe('0x08c379a0');
  });

  it('digs through the nested JSON-RPC error provider wrapper', () => {
    expect(revertSelectorOf({ info: { error: { data: '0x275C273C' } } })).toBe('0x275c273c');
  });

  it('returns null when there is no revert data', () => {
    expect(revertSelectorOf({ message: 'execution reverted' })).toBeNull();
    expect(revertSelectorOf({ data: '0x' })).toBeNull();
    expect(revertSelectorOf(undefined)).toBeNull();
  });

  it('does not loop forever on a self-referential error object', () => {
    const cyclic: any = { message: 'x' };
    cyclic.cause = cyclic;
    expect(revertSelectorOf(cyclic)).toBeNull();
  });
});

describe('classifySwapRevert — map a router revert to a user-facing reason', () => {
  it('maps LI.FI InsufficientAmountOut() (0xe52970aa) to a slippage reason', () => {
    const r = classifySwapRevert({ data: '0xe52970aa' });
    expect(r.ok).toBeFalse();
    expect(r).toEqual(jasmine.objectContaining({ kind: 'slippage' }));
    if (!r.ok) expect(r.reason).toContain('slippage');
  });

  it('maps CumulativeSlippageTooHigh (0x275c273c) to a slippage reason', () => {
    const r = classifySwapRevert({ info: { error: { data: '0x275c273c' } } });
    expect(r).toEqual(jasmine.objectContaining({ ok: false, kind: 'slippage' }));
  });

  it('lets a known slippage SELECTOR win over the "missing revert data" fail-open', () => {
    // The exact trap from production: a no-string slippage revert that also
    // carries ethers\' "missing revert data" text must NOT be read as ok:true.
    const r = classifySwapRevert({ data: '0xe52970aa', message: 'missing revert data' });
    expect(r).toEqual(jasmine.objectContaining({ ok: false, kind: 'slippage' }));
  });

  it('fails OPEN (ok:true) on "missing revert data" with no recognizable selector', () => {
    expect(classifySwapRevert({ message: 'missing revert data (...)' })).toEqual({ ok: true });
  });

  it('still catches the legacy string slippage patterns', () => {
    expect(classifySwapRevert({ message: 'Min return not reached' })).toEqual(
      jasmine.objectContaining({ ok: false, kind: 'slippage' }),
    );
  });

  it('classifies an allowance revert', () => {
    expect(classifySwapRevert({ message: 'ERC20: insufficient allowance' })).toEqual(
      jasmine.objectContaining({ ok: false, kind: 'allowance' }),
    );
  });

  it('falls back to kind:unknown with the raw reason for an unrecognized revert', () => {
    const r = classifySwapRevert({ shortMessage: 'execution reverted: Foo' });
    expect(r).toEqual(jasmine.objectContaining({ ok: false, kind: 'unknown' }));
    if (!r.ok) expect(r.reason).toContain('Foo');
  });
});

describe('shouldBlockBroadcast — pre-broadcast gate fails open except on confident reverts', () => {
  it('never blocks a clean simulation', () => {
    expect(shouldBlockBroadcast({ ok: true })).toBeFalse();
  });

  it('blocks on a confident on-chain revert (slippage / allowance / transfer)', () => {
    expect(shouldBlockBroadcast({ ok: false, reason: 'x', kind: 'slippage' })).toBeTrue();
    expect(shouldBlockBroadcast({ ok: false, reason: 'x', kind: 'allowance' })).toBeTrue();
    expect(shouldBlockBroadcast({ ok: false, reason: 'x', kind: 'transfer' })).toBeTrue();
  });

  it('fails OPEN on kind:unknown — infra/inconclusive must never block a good swap', () => {
    expect(shouldBlockBroadcast({ ok: false, reason: 'No network connection for pre-check', kind: 'unknown' })).toBeFalse();
  });
});

describe('SwapExecutionService.approveToken — USDT reset-tx wait must not hard-fail after broadcast', () => {
  // Well-known mainnet USDT contract — lowercase, same convention as the
  // other token fixtures in this file (addresses are compared lowercased).
  const USDT_ETHEREUM = '0xdac17f958d2ee523a2206206994597c13d831ec7';
  const WALLET_ADDRESS = '0x1234567890123456789012345678901234567890';
  const RESET_TX_HASH = '0xreset';
  const APPROVE_TX_HASH = '0xmainapprove';

  let service: SwapExecutionService;
  let mockWalletService: jasmine.SpyObj<WalletService>;

  /** ABI-encode a bare `uint256` return value, exactly what `allowance()` yields on-chain. */
  function encodedAllowance(value: bigint): string {
    return AbiCoder.defaultAbiCoder().encode(['uint256'], [value]);
  }

  /**
   * Minimal signer stub. `Contract`'s ESM export is frozen (can't be spied
   * on directly — see send.service.spec.ts) so we drive the real ethers
   * `Contract` against this stub instead: view calls (`allowance`) fall
   * back to `provider.call` (ethers' `getRunner` behavior when the signer
   * itself has no `.call`), writes (`approve`) go through `sendTransaction`.
   */
  function makeSigner(opts: {
    sendTransaction: jasmine.Spy;
    call: jasmine.Spy;
    waitForTransaction: jasmine.Spy;
  }): JsonRpcSigner {
    return {
      sendTransaction: opts.sendTransaction,
      provider: {
        call: opts.call,
        waitForTransaction: opts.waitForTransaction,
      },
    } as unknown as JsonRpcSigner;
  }

  function usdtQuote(): SwapQuote {
    return makeQuote({
      aggregator: 'zerox',
      fromToken: makeToken({ address: USDT_ETHEREUM, symbol: 'USDT', decimals: 6, chainId: 1 }),
      _aggregatorData: {
        aggregator: 'zerox',
        to_amount: '0',
        approval_address: ZEROX_ALLOWANCE_HOLDER,
        tx_request: { to: ZEROX_ALLOWANCE_HOLDER, data: '0x', value: '0' },
        quoted_at: Date.now(),
      },
    });
  }

  beforeEach(() => {
    mockWalletService = jasmine.createSpyObj('WalletService', [
      'getSigner',
      'ensureCorrectChain',
      'address',
      'chainId',
    ]);
    // Wallet already on the token's chain — ensureCorrectChain's switch path
    // is irrelevant to this test and stays unexercised.
    mockWalletService.chainId.and.returnValue(1);
    mockWalletService.address.and.returnValue(WALLET_ADDRESS);

    TestBed.configureTestingModule({
      providers: [{ provide: WalletService, useValue: mockWalletService }],
    });
    service = TestBed.inject(SwapExecutionService);
  });

  it('resolves with the main approve hash when the reset-tx wait rejects (tx already broadcast, e.g. Privy nonce/timeout)', async () => {
    const sendTransaction = jasmine
      .createSpy('sendTransaction')
      .and.returnValues(
        Promise.resolve({ hash: RESET_TX_HASH }),
        Promise.resolve({ hash: APPROVE_TX_HASH }),
      );
    const call = jasmine.createSpy('call').and.resolveTo(encodedAllowance(1000n));
    const waitForTransaction = jasmine.createSpy('waitForTransaction').and.callFake((hash: string) => {
      // Nonce ordering guarantees the reset mines before the follow-up
      // approve — the wait itself is what's flaky (Privy embedded-wallet
      // nonce:"undefined" crash / mainnet inclusion > 30s), not the tx.
      if (hash === RESET_TX_HASH) {
        return Promise.reject({ code: 'TIMEOUT' });
      }
      return Promise.resolve({ status: 1 });
    });
    mockWalletService.getSigner.and.returnValue(
      makeSigner({ sendTransaction, call, waitForTransaction }),
    );

    const hash = await service.approveToken(usdtQuote());

    expect(hash).toBe(APPROVE_TX_HASH);
    expect(waitForTransaction).toHaveBeenCalledWith(RESET_TX_HASH, 1, 30000);
    expect(waitForTransaction).toHaveBeenCalledWith(APPROVE_TX_HASH, 1, 30000);
  });

  it('still throws the USDT-specific reset error when the user rejects the reset broadcast itself', async () => {
    // The wait-timeout catch must swallow ONLY the wait failure — a rejected
    // reset broadcast (ACTION_REJECTED / 4001) is a different failure mode
    // entirely and must still surface the USDT-specific message.
    const sendTransaction = jasmine.createSpy('sendTransaction').and.rejectWith({ code: 'ACTION_REJECTED' });
    const call = jasmine.createSpy('call').and.resolveTo(encodedAllowance(1000n));
    const waitForTransaction = jasmine.createSpy('waitForTransaction');
    mockWalletService.getSigner.and.returnValue(
      makeSigner({ sendTransaction, call, waitForTransaction }),
    );

    await expectAsync(service.approveToken(usdtQuote())).toBeRejectedWithError(/reset transaction/);
    expect(waitForTransaction).not.toHaveBeenCalled();
  });
});

describe('SwapExecutionService.validateQuoteAge — the 45 s expiry wall', () => {
  let service: SwapExecutionService;

  /** The guard is private; the boundary it enforces is the public contract. */
  const validateAge = (ageMs: number): void =>
    (service as unknown as { validateQuoteAge(q: SwapQuote): void }).validateQuoteAge(
      makeQuote({ aggregator: 'zerox', createdAt: Date.now() - ageMs }),
    );

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: WalletService,
          useValue: jasmine.createSpyObj('WalletService', [
            'getSigner',
            'ensureCorrectChain',
            'address',
            'chainId',
          ]),
        },
      ],
    });
    service = TestBed.inject(SwapExecutionService);
  });

  it('throws for a quote older than the 45 s TTL', () => {
    // Aggregator calldata carries a deadline and a price the router will no
    // longer honour — signing a 46 s-old quote buys a revert.
    expect(() => validateAge(46_000)).toThrowError(/Quote expired/);
  });

  it('accepts a quote still inside the TTL', () => {
    expect(() => validateAge(44_000)).not.toThrow();
  });

  it('does not gate a quote with no createdAt (legacy SDK shape)', () => {
    const legacy = makeQuote({ aggregator: 'zerox' });
    delete legacy.createdAt;
    expect(() =>
      (service as unknown as { validateQuoteAge(q: SwapQuote): void }).validateQuoteAge(legacy),
    ).not.toThrow();
  });
});
