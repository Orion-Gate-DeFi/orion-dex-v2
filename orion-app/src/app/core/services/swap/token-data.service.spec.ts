/**
 * TokenDataService — token-list fetch dedup + failure cooldown, and the
 * portfolio-balances TTL cache + in-flight dedup.
 *
 * The LI.FI `getTokens` export can't be spied on under Karma/esbuild
 * (ES-module bindings are sealed), so the service keeps the call as an
 * instance field (`lifiGetTokens`) that these specs stub directly. The
 * portfolio path goes through `window.fetch`, which CAN be spied on.
 */
import { TestBed } from '@angular/core/testing';
import { TokenDataService } from './token-data.service';
import { WalletService } from '../wallet.service';
import { AuthService } from '../auth.service';

describe('TokenDataService', () => {
  let service: TokenDataService;
  let lifiGetTokensSpy: jasmine.Spy;

  const lifiToken = {
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    chainId: 1,
    logoURI: '',
    priceUSD: '1',
  };

  type TokensResponse = { tokens: Record<number, (typeof lifiToken)[]> };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        TokenDataService,
        { provide: WalletService, useValue: {} },
        { provide: AuthService, useValue: { getAccessTokenAsync: () => Promise.resolve(null) } },
      ],
    });
    service = TestBed.inject(TokenDataService);
    lifiGetTokensSpy = jasmine.createSpy('getTokens');
    (service as unknown as { lifiGetTokens: jasmine.Spy }).lifiGetTokens = lifiGetTokensSpy;
  });

  it('dedupes concurrent fetches for the same chain into one SDK call', async () => {
    let resolveFetch!: (value: TokensResponse) => void;
    lifiGetTokensSpy.and.returnValue(new Promise(resolve => { resolveFetch = resolve; }));

    const first = service.getTokensForChain(1);
    const second = service.getTokensForChain(1);
    expect(lifiGetTokensSpy).toHaveBeenCalledTimes(1);

    resolveFetch({ tokens: { 1: [lifiToken] } });
    const [a, b] = await Promise.all([first, second]);
    expect(a.length).toBe(1);
    expect(b).toEqual(a);

    // Subsequent calls hit the cache, not the SDK.
    await service.getTokensForChain(1);
    expect(lifiGetTokensSpy).toHaveBeenCalledTimes(1);
    expect(service.cachedTokens().get(1)?.length).toBe(1);
  });

  it('does not dedupe across different chains', async () => {
    lifiGetTokensSpy.and.callFake(({ chains }: { chains: number[] }) =>
      Promise.resolve({ tokens: { [chains[0]]: [] } })
    );

    await Promise.all([service.getTokensForChain(1), service.getTokensForChain(10)]);
    expect(lifiGetTokensSpy).toHaveBeenCalledTimes(2);
  });

  it('applies a per-chain cooldown after a failure so the 30 s tick cannot hammer the SDK', async () => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date());
    try {
      lifiGetTokensSpy.and.rejectWith(new Error('LI.FI down'));

      expect(await service.getTokensForChain(1)).toEqual([]);
      expect(lifiGetTokensSpy).toHaveBeenCalledTimes(1);

      // Within the cooldown: fail open without another SDK hit.
      expect(await service.getTokensForChain(1)).toEqual([]);
      expect(lifiGetTokensSpy).toHaveBeenCalledTimes(1);

      // Past the cooldown: retry — and a success populates the cache.
      jasmine.clock().tick(60_001);
      lifiGetTokensSpy.and.resolveTo({ tokens: { 1: [lifiToken] } });
      const tokens = await service.getTokensForChain(1);
      expect(lifiGetTokensSpy).toHaveBeenCalledTimes(2);
      expect(tokens.length).toBe(1);
      expect(service.cachedTokens().get(1)?.length).toBe(1);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('keeps the cooldown per-chain: a failing chain does not block others', async () => {
    lifiGetTokensSpy.and.callFake(({ chains }: { chains: number[] }) =>
      chains[0] === 1
        ? Promise.reject(new Error('chain 1 down'))
        : Promise.resolve({ tokens: { [chains[0]]: [lifiToken] } })
    );

    expect(await service.getTokensForChain(1)).toEqual([]);
    const base = await service.getTokensForChain(8453);
    expect(base.length).toBe(1);
    expect(lifiGetTokensSpy).toHaveBeenCalledTimes(2);
  });

  it('clearCache resets the failure cooldown so a deliberate clear may retry immediately', async () => {
    lifiGetTokensSpy.and.rejectWith(new Error('LI.FI down'));
    expect(await service.getTokensForChain(1)).toEqual([]);
    expect(lifiGetTokensSpy).toHaveBeenCalledTimes(1);

    service.clearCache();
    lifiGetTokensSpy.and.resolveTo({ tokens: { 1: [lifiToken] } });
    const tokens = await service.getTokensForChain(1);
    expect(lifiGetTokensSpy).toHaveBeenCalledTimes(2);
    expect(tokens.length).toBe(1);
  });

  describe('getPortfolioBalances — TTL cache + in-flight dedup', () => {
    const WALLET = '0xabcd000000000000000000000000000000000001';
    let fetchSpy: jasmine.Spy;

    const proxyResponse = (): Response =>
      ({
        ok: true,
        json: () =>
          Promise.resolve({
            balances: {
              '1': [
                {
                  address: lifiToken.address,
                  symbol: 'USDC',
                  name: 'USD Coin',
                  decimals: 6,
                  amount: '5000000', // 5 USDC
                  priceUSD: '1',
                  logoURI: '',
                },
              ],
            },
          }),
      } as Response);

    beforeEach(() => {
      fetchSpy = spyOn(window, 'fetch');
    });

    it('dedupes concurrent calls for the same wallet+chains into one proxy request', async () => {
      let resolveFetch!: (value: Response) => void;
      fetchSpy.and.returnValue(new Promise<Response>((resolve) => { resolveFetch = resolve; }));

      const first = service.getPortfolioBalances(WALLET, [1]);
      const second = service.getPortfolioBalances(WALLET, [1]);
      resolveFetch(proxyResponse());

      const [a, b] = await Promise.all([first, second]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(a.length).toBe(1);
      expect(a[0].balance).toBe(5);
      expect(b).toEqual(a);

      // The primary source is the backend /balances endpoint (Alchemy-backed):
      // address + chains, and deliberately NO `_t` buster — the backend owns
      // the freshness window (a short server-side TTL).
      const url = fetchSpy.calls.mostRecent().args[0] as string;
      expect(url).toContain('/balances?');
      expect(url).toContain('address=' + WALLET);
      expect(url).toContain('chains=1');
    });

    it('serves the TTL cache on a sequential second call, and refetches after expiry', async () => {
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date());
      try {
        fetchSpy.and.resolveTo(proxyResponse());

        const first = await service.getPortfolioBalances(WALLET, [1]);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // Within the 12 s TTL: cache hit, the proxy is untouched.
        jasmine.clock().tick(11_000);
        const second = await service.getPortfolioBalances(WALLET, [1]);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(second).toEqual(first);

        // Past the TTL: a post-swap refresh must see fresh balances.
        jasmine.clock().tick(1_500);
        await service.getPortfolioBalances(WALLET, [1]);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('keys the cache by wallet+chains (chain order does not defeat it)', async () => {
      fetchSpy.and.resolveTo(proxyResponse());

      await service.getPortfolioBalances(WALLET, [1]);
      // Different wallet: own request.
      await service.getPortfolioBalances('0x0000000000000000000000000000000000000002', [1]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // Different chain set: own request…
      await service.getPortfolioBalances(WALLET, [1, 8453]);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      // …but a reordered, identical set is the same key.
      await service.getPortfolioBalances(WALLET, [8453, 1]);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('never caches failures: the error propagates and the next call retries', async () => {
      // Both sources fail → rejected. A failed attempt tries the backend AND
      // the LI.FI fallback, so it makes two fetch calls.
      fetchSpy.and.resolveTo({ ok: false, status: 500 } as Response);
      await expectAsync(service.getPortfolioBalances(WALLET, [1])).toBeRejected();
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // Not cached: the next call retries and the backend now succeeds (one call).
      fetchSpy.and.resolveTo(proxyResponse());
      const balances = await service.getPortfolioBalances(WALLET, [1]);
      expect(balances.length).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('falls back to the LI.FI proxy when the backend /balances endpoint is unavailable', async () => {
      // Backend answers 503 (e.g. Alchemy key not provisioned yet); the legacy
      // LI.FI proxy serves the portfolio so balances still load.
      fetchSpy.and.callFake((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('address=')) {
          return Promise.resolve({ ok: false, status: 503 } as Response); // backend
        }
        return Promise.resolve(proxyResponse()); // LI.FI /wallets/{addr}/balances
      });

      const balances = await service.getPortfolioBalances(WALLET, [1]);
      expect(balances.length).toBe(1); // served from the LI.FI fallback
      expect(fetchSpy).toHaveBeenCalledTimes(2); // backend tried, then LI.FI

      const fallbackUrl = fetchSpy.calls.mostRecent().args[0] as string;
      expect(fallbackUrl).toContain('/wallets/');
      expect(fallbackUrl).toContain('_t=');
    });

    it('force bypasses a warm TTL cache and re-warms it for the auto path', async () => {
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date());
      try {
        fetchSpy.and.resolveTo(proxyResponse());

        await service.getPortfolioBalances(WALLET, [1]);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // Well inside the 12 s TTL a forced call (post-send refresh) must
        // still hit the proxy — the warm cache holds PRE-send balances.
        jasmine.clock().tick(2_000);
        await service.getPortfolioBalances(WALLET, [1], { force: true });
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        // The forced result re-warmed the cache: the auto-tick path keeps
        // being served from it without another request.
        jasmine.clock().tick(2_000);
        await service.getPortfolioBalances(WALLET, [1]);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('force still shares the in-flight request with concurrent callers', async () => {
      let resolveFetch!: (value: Response) => void;
      fetchSpy.and.returnValue(new Promise<Response>((resolve) => { resolveFetch = resolve; }));

      const plain = service.getPortfolioBalances(WALLET, [1]);
      const forced = service.getPortfolioBalances(WALLET, [1], { force: true });
      resolveFetch(proxyResponse());

      const [a, b] = await Promise.all([plain, forced]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(b).toEqual(a);
    });

    it('clearCache drops the portfolio cache so the next call refetches', async () => {
      fetchSpy.and.resolveTo(proxyResponse());
      await service.getPortfolioBalances(WALLET, [1]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      service.clearCache();
      await service.getPortfolioBalances(WALLET, [1]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});
