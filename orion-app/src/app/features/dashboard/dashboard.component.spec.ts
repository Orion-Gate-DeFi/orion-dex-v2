import { signal } from '@angular/core';
import type { WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DashboardComponent, assetTrustStatus } from './dashboard.component';
import { WalletService } from '../../core/services/wallet.service';
import { LifiService } from '../../core/services/lifi.service';
import { BalanceRefreshService } from '../../core/services/balance-refresh.service';
import { TokenDataService } from '../../core/services/swap/token-data.service';
import type { Token } from '../../core/models/token.model';
import { Subject } from 'rxjs';

describe('DashboardComponent', () => {
  let component: DashboardComponent;
  let fixture: ComponentFixture<DashboardComponent>;
  let mockWalletService: jasmine.SpyObj<WalletService>;
  let mockLifiService: jasmine.SpyObj<LifiService>;
  let mockBalanceRefreshService: jasmine.SpyObj<BalanceRefreshService>;
  let refreshSubject: Subject<void>;
  let tokensCacheSignal: WritableSignal<Map<number, Token[]>>;

  beforeEach(async () => {
    mockWalletService = jasmine.createSpyObj('WalletService', ['connect'], {
      isConnected: jasmine.createSpy().and.returnValue(false),
      address: jasmine.createSpy().and.returnValue(null),
      isConnectedInPrivy: jasmine.createSpy().and.returnValue(false)
    });

    mockLifiService = jasmine.createSpyObj('LifiService', [
      'getPortfolioBalances',
      'getPortfolioBalancesOrThrow'
    ]);

    refreshSubject = new Subject<void>();
    mockBalanceRefreshService = jasmine.createSpyObj('BalanceRefreshService', ['triggerRefresh'], {
      refresh$: refreshSubject.asObservable()
    });

    // The dashboard reads the selector's cached token lists as its trusted
    // source; tests drive trust scenarios through this signal.
    tokensCacheSignal = signal(new Map<number, Token[]>());
    const mockTokenDataService: Pick<TokenDataService, 'cachedTokens' | 'getTokensForChain'> = {
      cachedTokens: tokensCacheSignal.asReadonly(),
      getTokensForChain: jasmine.createSpy('getTokensForChain').and.resolveTo([])
    };

    await TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [
        provideRouter([]),
        { provide: WalletService, useValue: mockWalletService },
        { provide: LifiService, useValue: mockLifiService },
        { provide: BalanceRefreshService, useValue: mockBalanceRefreshService },
        { provide: TokenDataService, useValue: mockTokenDataService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(DashboardComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should initialize with loading state', () => {
    expect(component.isLoading()).toBe(true);
  });

  it('should have last updated as null initially', () => {
    expect(component.lastUpdated()).toBeNull();
  });

  it('should format time since update correctly', () => {
    const now = new Date();

    // 30 seconds ago
    component.lastUpdated.set(new Date(now.getTime() - 30000));
    (component as any).updateTimeSinceUpdate();
    expect(component.timeSinceUpdate()).toContain('s ago');

    // 1 minute ago
    component.lastUpdated.set(new Date(now.getTime() - 65000));
    (component as any).updateTimeSinceUpdate();
    expect(component.timeSinceUpdate()).toContain('m ago');

    // 2 minutes ago
    component.lastUpdated.set(new Date(now.getTime() - 125000));
    (component as any).updateTimeSinceUpdate();
    expect(component.timeSinceUpdate()).toContain('m ago');
  });

  it('clears BOTH the auto-refresh and the timer-display intervals on destroy', () => {
    const clearIntervalSpy = spyOn(window, 'clearInterval').and.callThrough();
    // Real handles, so the assertion pins identity — not merely "clearInterval
    // was called at some point". A leaked 30 s portfolio refresh keeps hitting
    // the LI.FI balance API for every dashboard the user ever opened.
    const refreshHandle = setInterval(() => {}, 60_000);
    const timerHandle = setInterval(() => {}, 60_000);
    component['refreshIntervalId'] = refreshHandle;
    component['timerIntervalId'] = timerHandle;

    component.ngOnDestroy();

    expect(clearIntervalSpy).toHaveBeenCalledWith(refreshHandle);
    expect(clearIntervalSpy).toHaveBeenCalledWith(timerHandle);
    expect(component['refreshIntervalId']).toBeNull();
    expect(component['timerIntervalId']).toBeNull();
  });

  it('should update last updated time when loading portfolio', async () => {
    mockWalletService.isConnected.and.returnValue(true);
    mockWalletService.address.and.returnValue('0x123');
    mockLifiService.getPortfolioBalancesOrThrow.and.returnValue(Promise.resolve([]));

    await component.loadPortfolio();

    expect(component.lastUpdated()).toBeTruthy();
  });

  describe('error handling', () => {
    const ethBalance = {
      symbol: 'ETH',
      name: 'Ethereum',
      address: '0x0000000000000000000000000000000000000000',
      logoURI: '',
      balance: 1,
      balanceUSD: 3000,
      priceUSD: 3000,
      chainId: 1,
      decimals: 18
    };

    beforeEach(() => {
      mockWalletService.isConnected.and.returnValue(true);
      mockWalletService.address.and.returnValue('0x123');
    });

    it('should set loadError when the first load fails (no data yet)', async () => {
      mockLifiService.getPortfolioBalancesOrThrow.and.callFake(() =>
        Promise.reject(new Error('proxy 502'))
      );

      await component.loadPortfolio();

      expect(component.loadError()).toBe(true);
      expect(component.refreshFailed()).toBe(false);
      expect(component.assets()).toEqual([]);
      expect(component.isLoading()).toBe(false);
    });

    it('should keep loaded assets and set refreshFailed when a refresh fails', async () => {
      mockLifiService.getPortfolioBalancesOrThrow.and.returnValue(Promise.resolve([ethBalance]));
      await component.refresh();
      expect(component.assets().length).toBe(1);

      mockLifiService.getPortfolioBalancesOrThrow.and.callFake(() =>
        Promise.reject(new Error('network down'))
      );
      await component.refresh();

      expect(component.assets().length).toBe(1);
      expect(component.refreshFailed()).toBe(true);
      expect(component.loadError()).toBe(false);
    });

    it('should clear error flags on the next successful load', async () => {
      mockLifiService.getPortfolioBalancesOrThrow.and.callFake(() =>
        Promise.reject(new Error('network down'))
      );
      await component.refresh();
      expect(component.loadError()).toBe(true);

      mockLifiService.getPortfolioBalancesOrThrow.and.returnValue(Promise.resolve([ethBalance]));
      await component.refresh();

      expect(component.loadError()).toBe(false);
      expect(component.refreshFailed()).toBe(false);
      expect(component.assets().length).toBe(1);
    });

    it('refresh() should bypass the min-fetch-interval debounce (Retry path)', async () => {
      mockLifiService.getPortfolioBalancesOrThrow.and.callFake(() =>
        Promise.reject(new Error('boom'))
      );

      await component.loadPortfolio();
      expect(mockLifiService.getPortfolioBalancesOrThrow).toHaveBeenCalledTimes(1);

      // A direct call within MIN_FETCH_INTERVAL is debounced…
      await component.loadPortfolio();
      expect(mockLifiService.getPortfolioBalancesOrThrow).toHaveBeenCalledTimes(1);

      // …but refresh() (wired to the Retry button) forces through.
      await component.refresh();
      expect(mockLifiService.getPortfolioBalancesOrThrow).toHaveBeenCalledTimes(2);
    });

    it('should clear stale assets and set loadError when the new account\'s first load fails after a switch', async () => {
      // Account A loads fine.
      mockWalletService.address.and.returnValue('0xAAA');
      mockLifiService.getPortfolioBalancesOrThrow.and.returnValue(Promise.resolve([ethBalance]));
      await component.refresh();
      expect(component.assets().length).toBe(1);

      // Account switch: address changes while isConnected stays true; the
      // new account's first fetch fails.
      mockWalletService.address.and.returnValue('0xBBB');
      mockLifiService.getPortfolioBalancesOrThrow.and.callFake(() =>
        Promise.reject(new Error('rpc down'))
      );
      await component.loadPortfolio();

      // Account A's portfolio must never render under account B's identity.
      expect(component.assets()).toEqual([]);
      expect(component.loadError()).toBe(true);
      expect(component.refreshFailed()).toBe(false);
    });

    it('should fetch immediately on account switch (debounce is per-account)', async () => {
      mockLifiService.getPortfolioBalancesOrThrow.and.returnValue(Promise.resolve([ethBalance]));
      await component.loadPortfolio();
      expect(mockLifiService.getPortfolioBalancesOrThrow).toHaveBeenCalledTimes(1);

      // Within MIN_FETCH_INTERVAL, but the address changed — must not skip.
      mockWalletService.address.and.returnValue('0xBBB');
      await component.loadPortfolio();
      expect(mockLifiService.getPortfolioBalancesOrThrow).toHaveBeenCalledTimes(2);
    });

    it('should discard a stale response that resolves after the account changed', async () => {
      let resolveFetch!: (value: (typeof ethBalance)[]) => void;
      mockLifiService.getPortfolioBalancesOrThrow.and.returnValue(
        new Promise(resolve => { resolveFetch = resolve; })
      );
      const inFlight = component.loadPortfolio();

      // Account switches while the request is in flight…
      mockWalletService.address.and.returnValue('0xBBB');
      resolveFetch([ethBalance]);
      await inFlight;

      // …so the old account's data must be discarded, not shown under 0xBBB.
      expect(component.assets()).toEqual([]);
      expect(component.lastUpdated()).toBeNull();
      expect(component.isLoading()).toBe(false);
    });

    it('a stale request\'s finally must not clear a newer request\'s loading flags', async () => {
      // Account A loads, then its slow background tick hangs in flight.
      mockWalletService.address.and.returnValue('0xAAA');
      mockLifiService.getPortfolioBalancesOrThrow.and.resolveTo([ethBalance]);
      await component.refresh();

      (component as unknown as { lastFetchTime: number }).lastFetchTime = 0;
      let resolveSlowTick!: (value: (typeof ethBalance)[]) => void;
      mockLifiService.getPortfolioBalancesOrThrow.and.returnValue(
        new Promise(resolve => { resolveSlowTick = resolve; })
      );
      const slowTick = component.loadPortfolio();
      expect(component.isRefreshing()).toBe(true);

      // Switch to B; its first load owns the full-screen loader…
      mockWalletService.address.and.returnValue('0xBBB');
      let resolveB!: (value: (typeof ethBalance)[]) => void;
      mockLifiService.getPortfolioBalancesOrThrow.and.returnValue(
        new Promise(resolve => { resolveB = resolve; })
      );
      const firstLoadB = component.loadPortfolio();
      expect(component.isLoading()).toBe(true);

      // …so A's stale tick finishing late must not kill B's spinner.
      resolveSlowTick([ethBalance]);
      await slowTick;
      expect(component.isLoading()).toBe(true);

      resolveB([ethBalance]);
      await firstLoadB;
      expect(component.isLoading()).toBe(false);
      expect(component.isRefreshing()).toBe(false);
    });

    it('shows the full loading state for the new account\'s first load after the previous account failed', async () => {
      // Account A's first load fails — loadError is set.
      mockWalletService.address.and.returnValue('0xAAA');
      mockLifiService.getPortfolioBalancesOrThrow.and.callFake(() =>
        Promise.reject(new Error('proxy 502'))
      );
      await component.loadPortfolio();
      expect(component.loadError()).toBe(true);

      // Switch to B: its FIRST load must be a full load, not a background
      // tick piggybacking on A's account-agnostic loadError.
      mockWalletService.address.and.returnValue('0xBBB');
      let resolveB!: (value: (typeof ethBalance)[]) => void;
      mockLifiService.getPortfolioBalancesOrThrow.and.returnValue(
        new Promise(resolve => { resolveB = resolve; })
      );
      const firstLoadB = component.loadPortfolio();

      expect(component.isLoading()).toBe(true);
      expect(component.isRefreshing()).toBe(false);

      resolveB([ethBalance]);
      await firstLoadB;
      expect(component.isLoading()).toBe(false);
      expect(component.loadError()).toBe(false);
    });

    it('should not leak loadError when a request fails after the wallet disconnected', async () => {
      let rejectFetch!: (reason: Error) => void;
      mockLifiService.getPortfolioBalancesOrThrow.and.returnValue(
        new Promise((_resolve, reject) => { rejectFetch = reject; })
      );
      const inFlight = component.loadPortfolio();

      // Wallet disconnects while the request is in flight…
      mockWalletService.address.and.returnValue(null);
      rejectFetch(new Error('boom'));
      await inFlight;

      // …so the failure belongs to nobody — no error UI for the blank state.
      expect(component.loadError()).toBe(false);
      expect(component.refreshFailed()).toBe(false);
    });
  });

  describe('first-load error rendering', () => {
    it('should hide the zero-total network summary and allocation ring while the error block shows', async () => {
      mockWalletService.isConnectedInPrivy.and.returnValue(true);
      mockWalletService.isConnected.and.returnValue(true);
      mockWalletService.address.and.returnValue('0x123');
      mockLifiService.getPortfolioBalancesOrThrow.and.callFake(() =>
        Promise.reject(new Error('proxy 502'))
      );

      await component.refresh();
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      // No misleading "$0.00 / 0 tokens" chrome above the error block…
      expect(el.querySelector('.network-cards')).toBeNull();
      expect(el.querySelector('app-orion-asset-ring')).toBeNull();
      // …just the placeholder and the retry-able error state.
      expect(el.querySelector('.alloc-unavailable')).toBeTruthy();
      expect(el.querySelector('.error-icon')).toBeTruthy();
    });

    it('hides the zero-value summary chrome during wallet provisioning and the first load', async () => {
      mockWalletService.isConnectedInPrivy.and.returnValue(true);
      mockWalletService.isConnected.and.returnValue(false);
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      // Provisioning: "Setting up your wallet…" without $0.00 chrome above.
      expect(el.querySelector('.wallet-setup')).toBeTruthy();
      expect(el.querySelector('.network-cards')).toBeNull();
      expect(el.querySelector('app-orion-asset-ring')).toBeNull();
      expect(el.querySelector('.alloc-unavailable')).toBeTruthy();

      // Wallet attaches; first load in flight → still no zero chrome.
      mockWalletService.isConnected.and.returnValue(true);
      mockWalletService.address.and.returnValue('0x123');
      let resolveFetch!: (value: []) => void;
      mockLifiService.getPortfolioBalancesOrThrow.and.returnValue(
        new Promise(resolve => { resolveFetch = resolve; })
      );
      const inFlight = component.loadPortfolio();
      fixture.detectChanges();
      expect(el.querySelector('.loading-state')).toBeTruthy();
      expect(el.querySelector('.network-cards')).toBeNull();
      expect(el.querySelector('app-orion-asset-ring')).toBeNull();

      // Data lands (even a genuinely empty wallet) → real chrome renders.
      resolveFetch([]);
      await inFlight;
      fixture.detectChanges();
      expect(el.querySelector('.network-cards')).toBeTruthy();
      expect(el.querySelector('app-orion-asset-ring')).toBeTruthy();
    });
  });

  describe('background refresh (no table flash)', () => {
    const ethBalance = {
      symbol: 'ETH',
      name: 'Ethereum',
      address: '0x0000000000000000000000000000000000000000',
      logoURI: '',
      balance: 1,
      balanceUSD: 3000,
      priceUSD: 3000,
      chainId: 1,
      decimals: 18
    };

    beforeEach(() => {
      mockWalletService.isConnected.and.returnValue(true);
      mockWalletService.address.and.returnValue('0x123');
      mockWalletService.isConnectedInPrivy.and.returnValue(true);
    });

    it('keeps the asset table rendered during a background tick', async () => {
      mockLifiService.getPortfolioBalancesOrThrow.and.resolveTo([ethBalance]);
      await component.loadPortfolio();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelectorAll('.asset-row').length).toBe(1);

      // Simulate the 30 s auto-refresh tick (outside the debounce window)
      // with a fetch that stays in flight.
      (component as unknown as { lastFetchTime: number }).lastFetchTime = 0;
      let resolveFetch!: (value: (typeof ethBalance)[]) => void;
      mockLifiService.getPortfolioBalancesOrThrow.and.returnValue(
        new Promise(resolve => { resolveFetch = resolve; })
      );
      const inFlight = component.loadPortfolio();

      // The table must stay on screen — only the refresh icon spins.
      expect(component.isLoading()).toBe(false);
      expect(component.isRefreshing()).toBe(true);
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('.loading-state')).toBeNull();
      expect(el.querySelectorAll('.asset-row').length).toBe(1);

      resolveFetch([ethBalance]);
      await inFlight;
      expect(component.isRefreshing()).toBe(false);
    });

    it('post-transaction triggerRefresh bypasses the rate-limit debounce', async () => {
      mockLifiService.getPortfolioBalancesOrThrow.and.resolveTo([ethBalance]);
      await component.loadPortfolio();
      expect(mockLifiService.getPortfolioBalancesOrThrow).toHaveBeenCalledTimes(1);

      // ngOnInit subscribes to refresh$; its own initial loadPortfolio call
      // sits inside the debounce window and must be swallowed…
      component.ngOnInit();
      expect(mockLifiService.getPortfolioBalancesOrThrow).toHaveBeenCalledTimes(1);

      // …but an explicit balance-change event (Send/Swap completed) must
      // fetch immediately despite the recent load.
      refreshSubject.next();
      expect(mockLifiService.getPortfolioBalancesOrThrow).toHaveBeenCalledTimes(2);
    });
  });

  describe('Privy initialization states', () => {
    it('renders a skeleton while Privy state is unknown, then the guest hero after the timeout', () => {
      jasmine.clock().install();
      try {
        mockWalletService.isConnectedInPrivy.and.returnValue(null);
        const pendingFixture = TestBed.createComponent(DashboardComponent);
        pendingFixture.detectChanges();
        const el: HTMLElement = pendingFixture.nativeElement;

        expect(el.querySelector('.hero-skeleton')).toBeTruthy();
        expect(el.textContent).not.toContain('Connect Wallet');

        // Privy never resolves — past the watchdog (15s, aligned with the
        // lazy bridge's BRIDGE_READY_TIMEOUT_MS) the guest hero renders
        // anyway, with the normal Connect CTA.
        jasmine.clock().tick(15_001);
        pendingFixture.detectChanges();
        expect(el.querySelector('.hero-skeleton')).toBeNull();
        expect(el.textContent).toContain('Connect Wallet');

        pendingFixture.destroy();
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('renders the connected dashboard when connectDirect attached a wallet without Privy state', () => {
      // connectDirect fallback: isConnectedInPrivy stays null forever, but
      // the wallet itself is connected — the dashboard must render, not the
      // init skeleton or (past the watchdog) the guest hero.
      mockWalletService.isConnectedInPrivy.and.returnValue(null);
      mockWalletService.isConnected.and.returnValue(true);
      mockWalletService.address.and.returnValue('0x123');
      mockLifiService.getPortfolioBalancesOrThrow.and.resolveTo([]);
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('.hero-skeleton')).toBeNull();
      expect(el.querySelector('.dashboard-header')).toBeTruthy();

      // Past the watchdog the guest hero must still stay hidden.
      component.privyInitTimedOut.set(true);
      fixture.detectChanges();
      expect(el.textContent).not.toContain('Connect Wallet');
      expect(el.querySelector('.dashboard-header')).toBeTruthy();
    });

    it('shows wallet-setup progress instead of a dead-end Connect button while the embedded wallet is provisioning', () => {
      mockWalletService.isConnectedInPrivy.and.returnValue(true);
      mockWalletService.isConnected.and.returnValue(false);
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      const setup = el.querySelector('.wallet-setup');
      expect(setup).toBeTruthy();
      expect(setup!.textContent).toContain('Setting up your wallet');
      expect(setup!.querySelector('.spinner')).toBeTruthy();
      // No CTA: login() no-ops once authenticated, so a Connect button here
      // would spin forever.
      expect(setup!.querySelector('button')).toBeNull();
      expect(el.textContent).not.toContain('Connect your wallet to see your assets');
    });
  });

  describe('scam-token hygiene', () => {
    const REAL_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const FAKE_USDC = '0xbad0000000000000000000000000000000000bad';
    const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

    const trustedUsdc: Token = {
      address: REAL_USDC,
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      chainId: 1,
      logoURI: '',
      priceUSD: '1'
    };

    const asset = (symbol: string, address: string, chainId: number, balanceUSD: number) => ({
      symbol,
      name: symbol,
      address,
      logoURI: '',
      balance: 1,
      balanceUSD,
      priceUSD: balanceUSD,
      chainId
    });

    it('classifies natives as trusted, unlisted tokens as untrusted, and fails open without a list', () => {
      const trusted = new Map<number, Set<string>>([[1, new Set([REAL_USDC])]]);

      expect(assetTrustStatus({ address: NATIVE_ETH, chainId: 1 }, trusted)).toBe('trusted');
      expect(assetTrustStatus({ address: REAL_USDC.toUpperCase().replace('0X', '0x'), chainId: 1 }, trusted)).toBe('trusted');
      expect(assetTrustStatus({ address: FAKE_USDC, chainId: 1 }, trusted)).toBe('untrusted');
      // No list for the chain — fail open for display.
      expect(assetTrustStatus({ address: FAKE_USDC, chainId: 8453 }, trusted)).toBe('unknown');
    });

    it('hides counterfeits and excludes them from the USD total and the allocation ring', () => {
      tokensCacheSignal.set(new Map([[1, [trustedUsdc]]]));
      component.assets.set([
        asset('USDC', REAL_USDC, 1, 1000),
        asset('USDC', FAKE_USDC, 1, 5000), // fake airdrop mimicking USDC
        asset('ETH', NATIVE_ETH, 1, 3000)  // native: always shown
      ]);

      expect(component.hiddenAssets().map(a => a.address)).toEqual([FAKE_USDC]);
      expect(component.shownAssets().length).toBe(2);
      // The $5k counterfeit must not inflate the portfolio.
      expect(component.totalValueUSD()).toBe(4000);
      expect(component.filteredValueUSD()).toBe(4000);

      const segments = component.ringSegments();
      expect(segments.map(s => s.id).sort()).toEqual(['sym:ETH', 'sym:USDC']);
      expect(segments.find(s => s.id === 'sym:USDC')!.value).toBe(1000);
    });

    it('fails open without a cached list, but keeps ring keys address-based so counterfeits never merge', () => {
      tokensCacheSignal.set(new Map());
      component.assets.set([
        asset('USDC', REAL_USDC, 1, 1000),
        asset('USDC', FAKE_USDC, 1, 5000)
      ]);

      expect(component.shownAssets().length).toBe(2);
      expect(component.hiddenAssets().length).toBe(0);

      const ids = component.ringSegments().map(s => s.id);
      expect(ids.length).toBe(2);
      expect(new Set(ids).size).toBe(2);
    });

    it('renders counterfeits only inside the collapsed hidden section', async () => {
      mockWalletService.isConnectedInPrivy.and.returnValue(true);
      mockWalletService.isConnected.and.returnValue(true);
      mockWalletService.address.and.returnValue('0x123');
      tokensCacheSignal.set(new Map([[1, [trustedUsdc]]]));
      mockLifiService.getPortfolioBalancesOrThrow.and.resolveTo([
        { ...asset('USDC', REAL_USDC, 1, 1000), decimals: 6 },
        { ...asset('USDC', FAKE_USDC, 1, 5000), decimals: 18 }
      ]);

      await component.loadPortfolio();
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelectorAll('.asset-row:not(.hidden-row)').length).toBe(1);
      const toggle = el.querySelector<HTMLButtonElement>('.hidden-tokens-toggle');
      expect(toggle).toBeTruthy();
      expect(toggle!.textContent).toContain('Hidden tokens (1)');
      expect(el.querySelector('.hidden-row')).toBeNull(); // collapsed by default

      toggle!.click();
      fixture.detectChanges();
      expect(el.querySelectorAll('.asset-row.hidden-row').length).toBe(1);
    });
  });
});
