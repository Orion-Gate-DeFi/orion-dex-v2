/**
 * GasService — native-token USD price caching.
 *
 * The gas strip refreshes every 30 s; the native price used for the USD
 * conversion must come from a per-chain cache (~5 min TTL) instead of
 * re-hitting the LI.FI proxy on every tick.
 */
import { TestBed } from '@angular/core/testing';
import { GasService } from './gas.service';
import { WalletService } from '../wallet.service';
import { AuthService } from '../auth.service';
import { RpcPoolService } from '../rpc-pool.service';

describe('GasService — getNativeTokenPrice', () => {
  let service: GasService;
  let fetchSpy: jasmine.Spy;

  const priceResponse = (priceUSD: string): Response =>
    ({ ok: true, json: () => Promise.resolve({ priceUSD }) } as Response);

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        GasService,
        { provide: WalletService, useValue: {} },
        { provide: AuthService, useValue: { getAccessTokenAsync: () => Promise.resolve(null) } },
        { provide: RpcPoolService, useValue: {} },
      ],
    });
    service = TestBed.inject(GasService);
    fetchSpy = spyOn(window, 'fetch');
  });

  it('serves the cached price on a second call within the TTL (no re-fetch)', async () => {
    fetchSpy.and.resolveTo(priceResponse('2500'));

    expect(await service.getNativeTokenPrice(1)).toBe(2500);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second 30 s gas tick within the TTL: cache hit, proxy untouched.
    expect(await service.getNativeTokenPrice(1)).toBe(2500);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the TTL has elapsed', async () => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date());
    try {
      fetchSpy.and.resolveTo(priceResponse('2500'));
      expect(await service.getNativeTokenPrice(1)).toBe(2500);

      jasmine.clock().tick(300_001);
      fetchSpy.and.resolveTo(priceResponse('2600'));
      expect(await service.getNativeTokenPrice(1)).toBe(2600);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('keeps the cache per-chain: a cached ETH price does not serve Polygon', async () => {
    fetchSpy.and.resolveTo(priceResponse('2500'));
    await service.getNativeTokenPrice(1);

    fetchSpy.and.resolveTo(priceResponse('0.45'));
    expect(await service.getNativeTokenPrice(137)).toBe(0.45);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not cache the fallback: a failed fetch retries the proxy next tick', async () => {
    fetchSpy.and.rejectWith(new Error('proxy down'));
    expect(await service.getNativeTokenPrice(1)).toBe(3500); // hardcoded fallback

    fetchSpy.and.resolveTo(priceResponse('2500'));
    expect(await service.getNativeTokenPrice(1)).toBe(2500);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not cache a non-ok proxy response either', async () => {
    fetchSpy.and.resolveTo({ ok: false } as Response);
    expect(await service.getNativeTokenPrice(1)).toBe(3500);

    await service.getNativeTokenPrice(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

/**
 * Gas categorization drives the colour and copy of the fee badge — the only
 * "is this expensive?" signal most users read before signing. Every
 * assertion below sits ON a threshold: a widened bound (cost < 5 → cost < 50)
 * paints a $40 mainnet swap as "Cheap" while nothing else in the app notices.
 */
describe('GasService — cost/level categorization thresholds', () => {
  let service: GasService;

  /** categorizeGasLevel is private; the thresholds it owns are the contract. */
  const level = (chainId: number, gwei: number): string =>
    (service as unknown as { categorizeGasLevel(c: number, g: number): string })
      .categorizeGasLevel(chainId, gwei);

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        GasService,
        { provide: WalletService, useValue: {} },
        { provide: AuthService, useValue: { getAccessTokenAsync: () => Promise.resolve(null) } },
        { provide: RpcPoolService, useValue: {} },
      ],
    });
    service = TestBed.inject(GasService);
  });

  describe('categorizeGasCost (USD)', () => {
    it('calls anything under $5 cheap', () => {
      expect(service.categorizeGasCost('4.99').level).toBe('cheap');
    });

    it('flips to normal exactly AT $5', () => {
      expect(service.categorizeGasCost('5').level).toBe('normal');
    });

    it('stays normal up to (but not including) $15', () => {
      expect(service.categorizeGasCost('14.99').level).toBe('normal');
    });

    it('flips to high exactly AT $15', () => {
      expect(service.categorizeGasCost('15').level).toBe('high');
    });

    it('echoes the cost back with 2-decimal formatting', () => {
      const info = service.categorizeGasCost('7.5');
      expect(info.estimatedUSD).toBe('7.50');
    });
  });

  describe('categorizeGasLevel (gwei, per chain)', () => {
    it('uses the mainnet scale on Ethereum: 20 / 50 / 100', () => {
      expect(level(1, 19.99)).toBe('cheap');
      expect(level(1, 20)).toBe('normal');
      expect(level(1, 49.99)).toBe('normal');
      expect(level(1, 50)).toBe('high');
      expect(level(1, 99.99)).toBe('high');
      expect(level(1, 100)).toBe('very_high');
    });

    it('uses the Avalanche scale (25 nAVAX base-fee floor): 30 / 50 / 100', () => {
      // The L2 thresholds would peg Avalanche at 'very_high' permanently.
      expect(level(43114, 29.99)).toBe('cheap');
      expect(level(43114, 30)).toBe('normal');
      expect(level(43114, 49.99)).toBe('normal');
      expect(level(43114, 50)).toBe('high');
      expect(level(43114, 99.99)).toBe('high');
      expect(level(43114, 100)).toBe('very_high');
    });

    it('uses the L2 scale everywhere else: 0.1 / 0.5 / 2', () => {
      for (const chainId of [8453, 42161, 10, 137, 56]) {
        expect(level(chainId, 0.09)).toBe('cheap');
        expect(level(chainId, 0.1)).toBe('normal');
        expect(level(chainId, 0.49)).toBe('normal');
        expect(level(chainId, 0.5)).toBe('high');
        expect(level(chainId, 1.99)).toBe('high');
        expect(level(chainId, 2)).toBe('very_high');
      }
    });
  });
});
