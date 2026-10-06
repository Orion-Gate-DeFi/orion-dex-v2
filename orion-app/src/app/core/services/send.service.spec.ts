import { TestBed } from '@angular/core/testing';
import { parseUnits } from 'ethers';
import type { JsonRpcSigner } from 'ethers';
import { SendService, isBurnAddress, truncateDecimals } from './send.service';
import { WalletService } from './wallet.service';
import { GasService } from './swap/gas.service';

// Pure-helper specs — no TestBed: SendService itself drags in WalletService /
// GasService (Privy, RPC providers), while the safety-critical logic under
// test is exported standalone exactly so it can be verified in isolation.
// (The reentrancy describe at the bottom is the exception — it stubs both
// dependencies with spies, so nothing real is instantiated.)

describe('truncateDecimals', () => {
  it('truncates a USD-mode artefact so parseUnits succeeds for 6-decimal tokens', () => {
    // 10 USD / 0.9998 → '10.00200040' — the audit's USDC repro.
    const truncated = truncateDecimals('10.00200040', 6);
    expect(truncated).toBe('10.002000');
    expect(parseUnits(truncated, 6)).toBe(10002000n);
  });

  it('makes toFixed(8) output parseable for a 6-decimal token', () => {
    // The original bug: ethers throws on excess significant fraction digits.
    expect(() => parseUnits('10.12345678', 6)).toThrow();
    expect(() => parseUnits(truncateDecimals('10.12345678', 6), 6)).not.toThrow();
  });

  it('truncates — never rounds — excess fractional digits', () => {
    expect(truncateDecimals('0.3333333', 6)).toBe('0.333333');
    expect(truncateDecimals('0.9999999', 6)).toBe('0.999999');
  });

  it('truncates the over-precise toFixed used for send strings instead of rounding half-up', () => {
    // SendComponent.toAmountString pattern: value.toFixed(d + 2), then
    // truncate to d. A bare toFixed(6) would round 0.9999999 → '1.000000',
    // letting MAX on a 6-decimal ERC-20 exceed the confirmed amount/balance.
    const d = 6;
    expect(truncateDecimals((0.9999999).toFixed(d + 2), d)).toBe('0.999999');
  });

  it('zeroes exponent-notation input instead of passing it through', () => {
    // 'e' splits into no clippable fraction — '1e-7' previously passed
    // through unchanged and blew up parseUnits downstream.
    expect(truncateDecimals('1e-7', 6)).toBe('0');
    expect(truncateDecimals('1E21', 18)).toBe('0');
  });

  it('keeps trailing zeros within the allowed precision', () => {
    expect(truncateDecimals('1.230000', 6)).toBe('1.230000');
    expect(parseUnits(truncateDecimals('1.230000', 6), 6)).toBe(1230000n);
  });

  it('passes integer amounts through unchanged', () => {
    expect(truncateDecimals('5', 6)).toBe('5');
    expect(truncateDecimals('5', 18)).toBe('5');
  });

  it('drops the entire fraction when decimals is 0', () => {
    expect(truncateDecimals('7.999', 0)).toBe('7');
  });

  it('leaves 18-decimal amounts untouched (passthrough)', () => {
    const amount = '1.234567890123456789';
    expect(truncateDecimals(amount, 18)).toBe(amount);
    expect(() => parseUnits(truncateDecimals(amount, 18), 18)).not.toThrow();
  });

  it('normalises a dangling decimal point', () => {
    expect(truncateDecimals('10.', 6)).toBe('10');
  });

  it('handles a leading decimal point', () => {
    expect(truncateDecimals('.5', 6)).toBe('0.5');
  });
});

describe('isBurnAddress', () => {
  it('detects the zero address', () => {
    expect(isBurnAddress('0x0000000000000000000000000000000000000000')).toBeTrue();
  });

  it('detects the dEaD address regardless of case', () => {
    expect(isBurnAddress('0x000000000000000000000000000000000000dEaD')).toBeTrue();
    expect(isBurnAddress('0x000000000000000000000000000000000000DEAD')).toBeTrue();
    expect(isBurnAddress('0x000000000000000000000000000000000000dead')).toBeTrue();
  });

  it('does not flag regular addresses', () => {
    expect(isBurnAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBeFalse();
  });

  it('does not flag empty or malformed input', () => {
    expect(isBurnAddress('')).toBeFalse();
    expect(isBurnAddress('0x0')).toBeFalse();
  });
});

describe('SendService reentrancy guard', () => {
  const RECIPIENT = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

  let service: SendService;
  let mockWalletService: jasmine.SpyObj<WalletService>;

  /** Minimal signer stub; `sendTransaction` behavior set per spec. */
  function makeSigner(sendTransaction: jasmine.Spy): JsonRpcSigner {
    return { sendTransaction, provider: null } as unknown as JsonRpcSigner;
  }

  beforeEach(() => {
    mockWalletService = jasmine.createSpyObj('WalletService', [
      'getSigner',
      'ensureCorrectChain',
    ]);
    mockWalletService.ensureCorrectChain.and.resolveTo(true);

    TestBed.configureTestingModule({
      providers: [
        { provide: WalletService, useValue: mockWalletService },
        {
          provide: GasService,
          useValue: jasmine.createSpyObj('GasService', ['getNativeTokenPrice']),
        },
      ],
    });
    service = TestBed.inject(SendService);
  });

  it('rejects a concurrent native send while one is in flight', async () => {
    // First send hangs at the signature prompt — exactly the window where a
    // double-click used to fire a second prompt for the same transfer.
    const hangingSend = jasmine
      .createSpy('sendTransaction')
      .and.returnValue(new Promise(() => {}));
    mockWalletService.getSigner.and.returnValue(makeSigner(hangingSend));

    // Not awaited — it never settles. The guard flips synchronously before
    // the first await inside sendNativeToken, so the second call races it.
    void service.sendNativeToken(RECIPIENT, '0.1', 1);

    const second = await service.sendNativeToken(RECIPIENT, '0.1', 1);

    expect(second.success).toBeFalse();
    expect(second.error).toContain('already in progress');
    // EXACTLY one prompt. `toBeLessThanOrEqual(1)` also passed when the
    // first send never reached the wallet at all — it stayed green with the
    // reentrancy guard completely broken (0 prompts is not a pass either).
    expect(hangingSend.calls.count()).toBe(1);
  });

  it('rejects a concurrent ERC20 send through the same shared flag', async () => {
    const hangingSend = jasmine
      .createSpy('sendTransaction')
      .and.returnValue(new Promise(() => {}));
    mockWalletService.getSigner.and.returnValue(makeSigner(hangingSend));

    void service.sendNativeToken(RECIPIENT, '0.1', 1);

    const blocked = await service.sendERC20Token(
      {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        chainId: 1,
      },
      RECIPIENT,
      '5',
    );

    expect(blocked.success).toBeFalse();
    expect(blocked.error).toContain('already in progress');
  });

  it('releases the guard once a send settles (rejection is not a lockout)', async () => {
    const rejectingSend = jasmine
      .createSpy('sendTransaction')
      .and.rejectWith({ code: 'ACTION_REJECTED' });
    mockWalletService.getSigner.and.returnValue(makeSigner(rejectingSend));

    const first = await service.sendNativeToken(RECIPIENT, '0.1', 1);
    expect(first.success).toBeFalse();
    expect(first.error).toBe('Transaction rejected by user');

    // A new send must be allowed — the error must be the wallet rejection
    // again, NOT the concurrency error (which would mean a stuck flag).
    const second = await service.sendNativeToken(RECIPIENT, '0.1', 1);
    expect(second.error).toBe('Transaction rejected by user');
  });
});

describe('SendService chainId pinning', () => {
  // Same reasoning as the swap path (see swap-execution.service.ts): a wallet
  // that silently reverted to another network must hard-fail the signature
  // instead of broadcasting value/calldata there. These specs assert the
  // *outgoing call*, not just a success result, so a regression that drops
  // `chainId` from the request would fail loudly even though the (mocked)
  // send still "succeeds".
  const RECIPIENT = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

  let service: SendService;
  let mockWalletService: jasmine.SpyObj<WalletService>;

  /** Minimal signer stub with a controllable provider for confirmTransaction. */
  function makeSigner(sendTransaction: jasmine.Spy, provider: unknown): JsonRpcSigner {
    return { sendTransaction, provider } as unknown as JsonRpcSigner;
  }

  /** Provider stub that confirms the tx in one shot via the wallet-provider path. */
  function makeConfirmingProvider(): jasmine.SpyObj<{ waitForTransaction: () => void }> {
    const provider = jasmine.createSpyObj('provider', ['waitForTransaction']);
    provider.waitForTransaction.and.resolveTo({ status: 1 });
    return provider;
  }

  beforeEach(() => {
    mockWalletService = jasmine.createSpyObj('WalletService', [
      'getSigner',
      'ensureCorrectChain',
    ]);
    mockWalletService.ensureCorrectChain.and.resolveTo(true);

    TestBed.configureTestingModule({
      providers: [
        { provide: WalletService, useValue: mockWalletService },
        {
          provide: GasService,
          useValue: jasmine.createSpyObj('GasService', ['getNativeTokenPrice']),
        },
      ],
    });
    service = TestBed.inject(SendService);
  });

  it('pins chainId on the native transaction request', async () => {
    const sendTransaction = jasmine.createSpy('sendTransaction').and.resolveTo({ hash: '0xnativehash' });
    mockWalletService.getSigner.and.returnValue(makeSigner(sendTransaction, makeConfirmingProvider()));

    const result = await service.sendNativeToken(RECIPIENT, '1', 42161);

    expect(result.success).toBeTrue();
    expect(sendTransaction).toHaveBeenCalledOnceWith(jasmine.objectContaining({ chainId: 42161 }));
  });

  it('pins chainId on the ERC-20 transfer request', async () => {
    // ethers' `Contract` is a real (frozen ESM) export in this build, so it
    // can't be spied on directly — the assertion instead goes through the
    // same `signer.sendTransaction` boundary the native spec above uses.
    // That's the call that actually reaches the wallet, which is the thing
    // we care about here. ethers folds the `{ chainId }` override into the
    // populated transaction as a bigint (see ethers' `copyRequest`), hence
    // the bigint literal below.
    const sendTransaction = jasmine.createSpy('sendTransaction').and.resolveTo({ hash: '0xerc20hash' });
    mockWalletService.getSigner.and.returnValue(makeSigner(sendTransaction, makeConfirmingProvider()));

    const result = await service.sendERC20Token(
      {
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        chainId: 8453,
      },
      RECIPIENT,
      '5',
    );

    expect(result.success).toBeTrue();
    expect(sendTransaction).toHaveBeenCalledOnceWith(jasmine.objectContaining({ chainId: 8453n }));
  });
});
