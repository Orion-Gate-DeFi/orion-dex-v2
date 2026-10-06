import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { parseUnits } from 'ethers';
import {
  SwapComponent,
  computeQuoteWorsening,
  REQUOTE_MAX_WORSENING,
  assessQuoteRisk,
  sanitizeAmountInput,
  isAmbiguousGroupedAmount,
  amountsNumericallyEqual,
  percentOfRawBalance,
  gasCostLabel,
  isUserRejectionError,
  estimateNativeGasCost,
  RISK_REASON_EXTREME_IMPACT,
  RISK_REASON_HIGH_IMPACT,
  RISK_REASON_IMPACT_UNKNOWN,
  RISK_REASON_USD_UNKNOWN,
} from './swap.component';
import { WalletService } from '../../core/services/wallet.service';
import { LifiService } from '../../core/services/lifi.service';
import { ToastService } from '../../core/services/toast.service';
import { SettingsService } from '../../core/services/settings.service';
import { BalanceRefreshService } from '../../core/services/balance-refresh.service';
import { TransactionHistoryService } from '../../core/services/transaction-history.service';
import type { TransactionRecord } from '../../core/services/transaction-history.service';
import type { fetchReceiptWithFallback } from '../../core/utils/fetch-receipt';
import type { TransactionReceipt } from 'ethers';
import {
  TransactionTrackerService,
  PARTIAL_SUCCESS_REASON,
} from '../../core/services/swap/transaction-tracker.service';
import type { AggregatorBridgeOutcome } from '../../core/services/swap/transaction-tracker.service';
import { AnalyticsService } from '../../core/services/analytics.service';
import type { LifiStatusResponse, SwapQuote } from '../../core/models/swap.model';

describe('SwapComponent', () => {
  let component: SwapComponent;
  let fixture: ComponentFixture<SwapComponent>;
  let mockWalletService: jasmine.SpyObj<WalletService>;
  let mockLifiService: jasmine.SpyObj<LifiService>;
  let mockToastService: jasmine.SpyObj<ToastService>;
  let mockSettingsService: jasmine.SpyObj<SettingsService>;
  let mockBalanceRefreshService: jasmine.SpyObj<BalanceRefreshService>;
  let mockTrackerService: jasmine.SpyObj<TransactionTrackerService>;

  beforeEach(async () => {
    mockWalletService = jasmine.createSpyObj('WalletService', [
      'connect',
      'disconnect',
      'getTokenBalance',
      'getNativeBalanceStrict',
      'updateBalance'
    ], {
      isConnected: jasmine.createSpy().and.returnValue(false),
      chainId: jasmine.createSpy().and.returnValue(1),
      // Read synchronously by the balance effect — must exist for specs
      // that flush component effects via detectChanges.
      address: jasmine.createSpy().and.returnValue(null)
    });

    mockLifiService = jasmine.createSpyObj('LifiService', [
      'getSwapQuote',
      'executeSwap',
      'approveToken',
      'checkApproval',
      'isNativeToken',
      'refreshQuoteBeforeExecute',
      'simulateSwap'
    ]);

    mockToastService = jasmine.createSpyObj('ToastService', [
      'success',
      'error',
      'warning',
      'info'
    ]);

    mockSettingsService = jasmine.createSpyObj('SettingsService', ['toggleSmartTips', 'getSlippageForSwap'], {
      smartTips: jasmine.createSpy().and.returnValue(true)
    });
    mockSettingsService.getSlippageForSwap.and.returnValue(0.5);

    mockBalanceRefreshService = jasmine.createSpyObj('BalanceRefreshService', [
      'triggerRefresh'
    ]);

    // Both tracking loops are exercised through the ActiveSwapHubService
    // (real, root-provided), which calls TransactionTrackerService directly.
    mockTrackerService = jasmine.createSpyObj('TransactionTrackerService', [
      'trackTransaction',
      'trackAggregatorBridge'
    ]);

    await TestBed.configureTestingModule({
      imports: [SwapComponent],
      providers: [
        // AuthService injects HttpClient (backend signup POST /my); the
        // testing provider (registered AFTER the real one) routes requests
        // to the mock backend so specs stay hermetic.
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: WalletService, useValue: mockWalletService },
        { provide: LifiService, useValue: mockLifiService },
        { provide: ToastService, useValue: mockToastService },
        { provide: SettingsService, useValue: mockSettingsService },
        { provide: BalanceRefreshService, useValue: mockBalanceRefreshService },
        { provide: TransactionTrackerService, useValue: mockTrackerService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(SwapComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should initialize with no pre-selected tokens', () => {
    // Product decision (see SwapComponent constructor): tokens are NOT
    // pre-selected — the user must pick both sides explicitly. Pre-filling
    // defaults confused users into quoting pairs they never chose.
    expect(component.fromToken()).toBeNull();
    expect(component.toToken()).toBeNull();
  });

  it('should start on swap step', () => {
    expect(component.currentStep()).toBe('swap');
  });

  it('should calculate cross-chain correctly', () => {
    component.fromToken.set({
      address: '0x0',
      symbol: 'ETH',
      name: 'Ethereum',
      decimals: 18,
      chainId: 1,
      logoURI: ''
    });

    component.toToken.set({
      address: '0x0',
      symbol: 'ETH',
      name: 'Ethereum',
      decimals: 18,
      chainId: 8453,
      logoURI: ''
    });

    expect(component.isCrossChain()).toBe(true);
  });

  it('should not be cross-chain for same network', () => {
    component.fromToken.set({
      address: '0x0',
      symbol: 'ETH',
      name: 'Ethereum',
      decimals: 18,
      chainId: 1,
      logoURI: ''
    });

    component.toToken.set({
      address: '0x1',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      chainId: 1,
      logoURI: ''
    });

    expect(component.isCrossChain()).toBe(false);
  });

  it('should swap tokens when swapTokens is called', () => {
    // Both sides must actually hold a token: with the default null/null pair
    // this only ever asserted null === null and stayed green no matter what
    // swapTokens did.
    const eth = { address: '0xa', symbol: 'ETH', name: 'Ethereum', decimals: 18, chainId: 1, logoURI: '' };
    const usdc = { address: '0xb', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: 8453, logoURI: '' };
    component.fromToken.set(eth);
    component.toToken.set(usdc);

    component.swapTokens();

    expect(component.fromToken()).toEqual(usdc);
    expect(component.toToken()).toEqual(eth);

    // Flipping back restores the original sides.
    component.swapTokens();
    expect(component.fromToken()).toEqual(eth);
    expect(component.toToken()).toEqual(usdc);
  });

  it('should calculate health percent correctly', () => {
    component.quote.set({
      id: 'test-quote',
      fromToken: { address: '', symbol: 'ETH', name: '', decimals: 18, chainId: 1, logoURI: '' },
      toToken: { address: '', symbol: 'USDC', name: '', decimals: 6, chainId: 1, logoURI: '' },
      fromAmount: '1',
      toAmount: '2000',
      fromAmountUSD: '2000',
      toAmountUSD: '2000',
      gasCost: '0.001',
      gasCostUSD: '5',
      exchangeRate: '1 ETH = 2000 USDC',
      estimatedTime: 30,
      priceImpact: '0.3',
      minimumReceived: '1990',
      slippage: 0.5,
      route: []
    });

    expect(component.getHealthPercent()).toBe(95);
  });

  it('labels gas cost on the SOURCE chain scale — mainnet vs L2', () => {
    const mainnetQuote = {
      id: 'test-quote',
      fromToken: { address: '', symbol: 'ETH', name: '', decimals: 18, chainId: 1, logoURI: '' },
      toToken: { address: '', symbol: 'USDC', name: '', decimals: 6, chainId: 1, logoURI: '' },
      fromAmount: '1',
      toAmount: '2000',
      fromAmountUSD: '2000',
      toAmountUSD: '2000',
      gasCost: '0.0001',
      gasCostUSD: '0.5',
      exchangeRate: '1 ETH = 2000 USDC',
      estimatedTime: 30,
      priceImpact: '0.3',
      minimumReceived: '1990',
      slippage: 0.5,
      route: []
    };

    component.quote.set(mainnetQuote);
    expect(component.getGasLabel()).toBe('Cheap');

    // $5 of mainnet gas is an ordinary swap — the flat L2 thresholds used
    // to call every normal mainnet swap 'Very High'.
    component.quote.set({ ...mainnetQuote, gasCostUSD: '5' });
    expect(component.getGasLabel()).toBe('Medium');

    component.quote.set({ ...mainnetQuote, gasCostUSD: '20' });
    expect(component.getGasLabel()).toBe('Very High');

    // The SAME $5 on an L2 genuinely is an outrage.
    const baseQuote = {
      ...mainnetQuote,
      fromToken: { ...mainnetQuote.fromToken, chainId: 8453 },
      toToken: { ...mainnetQuote.toToken, chainId: 8453 },
      gasCostUSD: '5'
    };
    component.quote.set(baseQuote);
    expect(component.getGasLabel()).toBe('Very High');

    component.quote.set({ ...baseQuote, gasCostUSD: '0.5' });
    expect(component.getGasLabel()).toBe('Cheap');
  });

  it('renders the network-fee cell as unknown ("—") on the \'\' gas sentinel, never "$0.00"', () => {
    const quote = {
      id: 'test-quote',
      fromToken: { address: '', symbol: 'ETH', name: '', decimals: 18, chainId: 1, logoURI: '' },
      toToken: { address: '', symbol: 'USDC', name: '', decimals: 6, chainId: 1, logoURI: '' },
      fromAmount: '1',
      toAmount: '2000',
      fromAmountUSD: '2000',
      toAmountUSD: '2000',
      gasCost: '0.001',
      gasCostUSD: '',
      exchangeRate: '1 ETH = 2000 USDC',
      estimatedTime: 30,
      priceImpact: '0.3',
      minimumReceived: '1990',
      slippage: 0.5,
      route: []
    };

    component.quote.set(quote);
    const fee = component.infoCells().find((c) => c.label === 'Network fee')!;
    expect(fee.value).toBe('—');
    expect(fee.sub).toBe('Estimate unavailable');
    expect(fee.subTone).toBe('muted');

    // A real estimate keeps the dollar figure and the chain-scale label.
    component.quote.set({ ...quote, gasCostUSD: '5' });
    const known = component.infoCells().find((c) => c.label === 'Network fee')!;
    expect(known.value).toBe('~$5.00');
    expect(known.sub).toBe('Medium');
  });

  it('formats gas for review/receipt via gasCostDisplay with an unknown fallback', () => {
    expect(component.gasCostDisplay('5')).toBe('~$5.00');
    expect(component.gasCostDisplay('5', false)).toBe('$5.00');
    expect(component.gasCostDisplay('')).toBe('—');
    expect(component.gasCostDisplay('not-a-number')).toBe('—');
    expect(component.isGasEstimateKnown('5')).toBeTrue();
    expect(component.isGasEstimateKnown('')).toBeFalse();
  });

  it('should detect zero amount correctly', () => {
    expect(component.isZeroAmount('')).toBe(true);
    expect(component.isZeroAmount('0')).toBe(true);
    expect(component.isZeroAmount('0.0')).toBe(true);
    expect(component.isZeroAmount('1.5')).toBe(false);
  });

  describe('USD input mode', () => {
    const ethToken = {
      address: '0xa', symbol: 'ETH', name: 'Ethereum', decimals: 18, chainId: 1, logoURI: '', priceUSD: '2000',
    };

    it('derives the from-token price from priceUSD, prefers the live quote', () => {
      component.fromToken.set(ethToken);
      expect(component.fromUsdPrice()).toBe(2000);
      expect(component.canToggleInputMode()).toBeTrue();

      // A live quote for the same token wins (reflects the real route).
      const liveQuote: SwapQuote = {
        id: 'test-quote',
        fromToken: ethToken,
        toToken: { address: '0xb', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: 1, logoURI: '' },
        fromAmount: '1',
        toAmount: '2100',
        fromAmountUSD: '2100',
        toAmountUSD: '2100',
        gasCost: '0.001',
        gasCostUSD: '5',
        exchangeRate: '1 ETH = 2100 USDC',
        estimatedTime: 30,
        priceImpact: '0.1',
        minimumReceived: '2090',
        slippage: 0.5,
        route: [],
      };
      component.quote.set(liveQuote);
      expect(component.fromUsdPrice()).toBe(2100);
    });

    it('hides the toggle when no price is available', () => {
      component.fromToken.set({ ...ethToken, priceUSD: undefined });
      expect(component.fromUsdPrice()).toBeNull();
      expect(component.canToggleInputMode()).toBeFalse();
    });

    it('converts a typed USD amount into the token amount that drives the quote', () => {
      component.fromToken.set(ethToken);
      component.inputMode.set('usd');
      component.onPayAmountChange('100');
      // 100 USD / 2000 = 0.05 ETH — fromAmount (the quote driver) is the token amount.
      expect(parseFloat(component.fromAmount)).toBeCloseTo(0.05, 10);
      // The field still shows the dollars the user typed.
      expect(component.usdInput()).toBe('100');
      expect(component.payInputValue).toBe('100');
      // The sub-line shows the locked token equivalent.
      expect(component.paySubLine()).toContain('ETH');
    });

    it('clears the token amount when the dollar input is emptied', () => {
      component.fromToken.set(ethToken);
      component.inputMode.set('usd');
      component.onPayAmountChange('100');
      component.onPayAmountChange('');
      expect(component.fromAmount).toBe('');
    });

    it('toggle seeds the dollar field from the current token amount and back', () => {
      component.fromToken.set(ethToken);
      component.fromAmount = '0.05';
      expect(component.inputMode()).toBe('token');

      component.toggleInputMode();
      expect(component.inputMode()).toBe('usd');
      // 0.05 ETH * 2000 = $100.00
      expect(component.usdInput()).toBe('100.00');

      component.toggleInputMode();
      expect(component.inputMode()).toBe('token');
      // The token amount the quote is for is untouched by the flip.
      expect(component.fromAmount).toBe('0.05');
    });

    it('token mode leaves the existing token-amount path untouched', () => {
      component.fromToken.set(ethToken);
      component.onPayAmountChange('2');
      expect(component.fromAmount).toBe('2');
      expect(component.payInputValue).toBe('2');
    });

    it('never lets a pathological token amount stringify to Infinity in the dollar field', () => {
      component.fromToken.set(ethToken);
      // ~1e319 overflows to Infinity; Infinity * price must NOT become "Infinity".
      component.fromAmount = '1'.repeat(320);
      component.toggleInputMode();
      expect(component.inputMode()).toBe('usd');
      expect(component.usdInput()).toBe('');
    });
  });

  it('should set percentage correctly', () => {
    mockLifiService.isNativeToken.and.returnValue(false);
    component.fromToken.set({ address: '0x1', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: 1, logoURI: '' });
    component.fromBalance.set(100);
    component.fromBalanceExact.set('100.0');

    component.setPercentage(50);
    expect(parseFloat(component.fromAmount)).toBe(50);

    component.setPercentage(100);
    expect(parseFloat(component.fromAmount)).toBe(100);
  });

  it('clears every timer it owns on destroy', () => {
    const clearIntervalSpy = spyOn(window, 'clearInterval').and.callThrough();
    const clearTimeoutSpy = spyOn(window, 'clearTimeout').and.callThrough();
    // Real handles, so the assertion pins identity — not merely "clearInterval
    // was called". A leaked quote auto-refresh keeps re-quoting (and burning
    // backend calls) for every swap screen the user ever opened.
    const debounceHandle = setTimeout(() => {}, 60_000);
    const gasHandle = setInterval(() => {}, 60_000);
    const elapsedHandle = setInterval(() => {}, 60_000);
    const refreshHandle = setInterval(() => {}, 60_000);
    const countdownHandle = setInterval(() => {}, 60_000);
    component['quoteDebounceTimer'] = debounceHandle;
    component['gasUpdateInterval'] = gasHandle;
    component['txElapsedTimer'] = elapsedHandle;
    component['quoteRefreshInterval'] = refreshHandle;
    component['quoteCountdownInterval'] = countdownHandle;

    component.ngOnDestroy();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(debounceHandle);
    expect(clearIntervalSpy).toHaveBeenCalledWith(gasHandle);
    expect(clearIntervalSpy).toHaveBeenCalledWith(elapsedHandle);
    expect(clearIntervalSpy).toHaveBeenCalledWith(refreshHandle);
    expect(clearIntervalSpy).toHaveBeenCalledWith(countdownHandle);
    expect(component['txElapsedTimer']).toBeNull();
    expect(component['quoteRefreshInterval']).toBeNull();
    expect(component['quoteCountdownInterval']).toBeNull();
  });

  it('aborts execution and returns to review when the silent re-quote worsens beyond the threshold', async () => {
    const baseQuote = {
      id: 'q-1',
      fromToken: { address: '0xa', symbol: 'ETH', name: 'Ethereum', decimals: 18, chainId: 1, logoURI: '' },
      toToken: { address: '0xb', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: 1, logoURI: '' },
      fromAmount: '1',
      toAmount: '2000',
      fromAmountUSD: '2000',
      toAmountUSD: '2000',
      gasCost: '0.001',
      gasCostUSD: '5',
      exchangeRate: '1 ETH = 2000 USDC',
      estimatedTime: 30,
      priceImpact: '0.3',
      minimumReceived: '1990',
      slippage: 0.5,
      route: [],
      createdAt: Date.now()
    };
    component.quote.set(baseQuote);
    // Pre-tick the per-quote acks: the abort must wipe them so the forced
    // re-confirm re-asks against the fresh quote actually on screen.
    component.acknowledgedQuoteRisk.set(true);
    component.acknowledgedHighValue.set(true);

    // Re-quote returns 1% less than the reviewed 2000 — above the 0.5% gate.
    mockLifiService.refreshQuoteBeforeExecute.and.resolveTo({
      quote: { ...baseQuote, toAmount: '1980' },
      approvalAddressChanged: false,
      priceChanged: true,
      refreshed: true,
      networkError: false
    });

    await component.executeSwap();

    // Never signed: execution aborted before any state transition.
    expect(mockLifiService.executeSwap).not.toHaveBeenCalled();
    expect(component.transactionStatus()).toBe('idle');
    // Back on review with the FRESH quote applied and the notice visible.
    expect(component.currentStep()).toBe('review');
    expect(component.quote()!.toAmount).toBe('1980');
    expect(component.requotePriceNotice()).toEqual({
      previousToAmount: '2000',
      newToAmount: '1980',
      toSymbol: 'USDC'
    });
    // Stale acks must not survive the abort.
    expect(component.acknowledgedQuoteRisk()).toBeFalse();
    expect(component.acknowledgedHighValue()).toBeFalse();

    // The gate restarted the auto-refresh interval — clean it up.
    component.ngOnDestroy();
  });

  describe('quote expiry wall (45 s TTL)', () => {
    const agedQuote = (ageMs: number): SwapQuote => ({
      id: 'q-age',
      fromToken: { address: '0xa', symbol: 'ETH', name: 'Ethereum', decimals: 18, chainId: 1, logoURI: '' },
      toToken: { address: '0xb', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: 1, logoURI: '' },
      fromAmount: '1',
      toAmount: '2000',
      fromAmountUSD: '2000',
      toAmountUSD: '2000',
      gasCost: '0.001',
      gasCostUSD: '5',
      exchangeRate: '1 ETH = 2000 USDC',
      estimatedTime: 30,
      priceImpact: '0.3',
      minimumReceived: '1990',
      slippage: 0.5,
      route: [],
      createdAt: Date.now() - ageMs,
    });

    /** Mirrors SwapExecutionService.validateQuoteAge — private by design. */
    const isTooOld = (q: SwapQuote): boolean =>
      (component as unknown as { isQuoteTooOld(q: SwapQuote): boolean }).isQuoteTooOld(q);

    it('treats a 46 s-old quote as expired', () => {
      expect(isTooOld(agedQuote(46_000))).toBeTrue();
    });

    it('still accepts a 44 s-old quote', () => {
      expect(isTooOld(agedQuote(44_000))).toBeFalse();
    });

    it('bounces the user back to review instead of signing an expired quote', async () => {
      // On the LI.FI fallback path (refreshed=false) the execution service
      // throws on quotes >45 s old — letting that happen painted a "Swap
      // failed" screen and wrote a phantom failed record into history.
      const q = agedQuote(46_000);
      component.quote.set(q);
      component.currentStep.set('review');
      mockLifiService.refreshQuoteBeforeExecute.and.resolveTo({
        quote: q,
        approvalAddressChanged: false,
        priceChanged: false,
        refreshed: false,
        networkError: false,
      });

      await component.executeSwap();

      expect(mockLifiService.executeSwap).not.toHaveBeenCalled();
      expect(component.currentStep()).toBe('review');
      expect(component.transactionStatus()).toBe('idle');
      expect(mockToastService.warning).toHaveBeenCalledWith(
        'Quote expired',
        jasmine.stringContaining('Refresh the quote'),
      );

      component.ngOnDestroy();
    });
  });

  it('a silent re-quote whose approvalAddress changed bounces to the SWAP step and never signs', async () => {
    // The allowance the user just granted points at the old spender: signing
    // now burns gas on a guaranteed revert. The Approve button only renders
    // on the 'swap' step, so bouncing to 'review' would strand the user with
    // a "please approve again" toast and no Approve button.
    const baseQuote: SwapQuote = {
      id: 'q-spender',
      fromToken: { address: '0xa', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: 1, logoURI: '' },
      toToken: { address: '0xb', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, chainId: 1, logoURI: '' },
      fromAmount: '100',
      toAmount: '0.05',
      fromAmountUSD: '100',
      toAmountUSD: '100',
      gasCost: '0.001',
      gasCostUSD: '5',
      exchangeRate: '1 USDC = 0.0005 WETH',
      estimatedTime: 30,
      priceImpact: '0.3',
      minimumReceived: '0.0497',
      slippage: 0.5,
      route: [],
      createdAt: Date.now(),
    };
    const refreshedQuote: SwapQuote = { ...baseQuote, id: 'q-spender-fresh', toAmount: '0.0501' };
    component.quote.set(baseQuote);
    component.currentStep.set('review');
    component.needsApproval.set(false);
    component.acknowledgedQuoteRisk.set(true);
    component.acknowledgedHighValue.set(true);
    component.acknowledgedSimulationFailure.set(true);

    mockLifiService.refreshQuoteBeforeExecute.and.resolveTo({
      quote: refreshedQuote,
      approvalAddressChanged: true,
      priceChanged: false,
      refreshed: true,
      networkError: false,
    });

    await component.executeSwap();

    // Never signed, no status transition.
    expect(mockLifiService.executeSwap).not.toHaveBeenCalled();
    expect(component.transactionStatus()).toBe('idle');
    // Back on the swap step — NOT review — with a fresh approve required.
    expect(component.currentStep()).toBe('swap');
    expect(component.needsApproval()).toBeTrue();
    expect(component.quote()!.id).toBe('q-spender-fresh');
    expect(mockToastService.error).toHaveBeenCalledWith(
      'Route changed',
      jasmine.stringContaining('needs a new approval'),
    );

    // Leaving review drops the simulation ack (the (step, quote) effect)…
    fixture.detectChanges();
    expect(component.acknowledgedSimulationFailure()).toBeFalse();

    // …and re-entering review re-asks for the per-quote acks, so the stale
    // ticks from the pre-bounce quote can never authorize the new one.
    component.fromToken.set(refreshedQuote.fromToken);
    component.toToken.set(refreshedQuote.toToken);
    component.fromAmount = '100';
    component.goToReview();
    expect(component.currentStep()).toBe('review');
    expect(component.acknowledgedQuoteRisk()).toBeFalse();
    expect(component.acknowledgedHighValue()).toBeFalse();

    component.ngOnDestroy();
  });

  describe('minimum received is read from the FROZEN quote, never live settings', () => {
    const quoteWith = (overrides: Partial<SwapQuote> = {}): SwapQuote => ({
      id: 'q-min',
      fromToken: { address: '0xa', symbol: 'ETH', name: 'Ethereum', decimals: 18, chainId: 1, logoURI: '' },
      toToken: { address: '0xb', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: 1, logoURI: '' },
      fromAmount: '1',
      toAmount: '1000',
      fromAmountUSD: '1000',
      toAmountUSD: '1000',
      gasCost: '0.001',
      gasCostUSD: '5',
      exchangeRate: '1 ETH = 1000 USDC',
      estimatedTime: 30,
      priceImpact: '0.3',
      minimumReceived: '995.000000',
      slippage: 0.5,
      route: [],
      createdAt: Date.now(),
      ...overrides,
    });

    const minCell = () => component.infoCells().find((c) => c.label === 'Minimum received')!;

    it('shows the quote\'s frozen floor and slippage even after the live setting moves', () => {
      component.quote.set(quoteWith());
      // The user opens settings mid-review and drags slippage to 3%. The
      // aggregator's calldata was encoded with the quote's 0.5% — showing
      // the live value would lie about the floor enforced on-chain.
      mockSettingsService.getSlippageForSwap.and.returnValue(3);
      expect(component.slippage).toBe(3);

      expect(minCell().value).toBe('995.0000 USDC');
      expect(minCell().sub).toBe('0.5% slippage');
    });

    it('tracks a re-quote\'s frozen numbers, not the settings signal', () => {
      component.quote.set(quoteWith());
      component.quote.set(quoteWith({ minimumReceived: '985.000000', slippage: 1.5 }));

      expect(minCell().value).toBe('985.0000 USDC');
      expect(minCell().sub).toBe('1.5% slippage');
    });

    it('does NOT promise the on-chain guarantee for an ESTIMATED floor', () => {
      // ODOS reports no enforced floor: to_amount_min absent → the number is
      // a client-side toAmount×(1−slippage) estimate. The "swap cancels
      // itself" copy would be a lie.
      component.quote.set(quoteWith({
        aggregator: 'odos',
        _aggregatorData: {
          aggregator: 'odos',
          to_amount: '1000000000',
          approval_address: '0xspender',
          tx_request: { to: '0xrouter', data: '0x', value: '0' },
          quoted_at: Date.now(),
        },
      }));

      expect(component.minimumReceivedIsEnforced()).toBeFalse();
      expect(minCell().tooltipText).toContain('treat it as a guide, not a guarantee');
      expect(minCell().tooltipText).not.toContain('it cancels');
    });

    it('does promise it when the aggregator reported an enforced floor', () => {
      component.quote.set(quoteWith({
        aggregator: 'zerox',
        _aggregatorData: {
          aggregator: 'zerox',
          to_amount: '1000000000',
          to_amount_min: '995000000',
          approval_address: '0xspender',
          tx_request: { to: '0xrouter', data: '0x', value: '0' },
          quoted_at: Date.now(),
        },
      }));

      expect(component.minimumReceivedIsEnforced()).toBeTrue();
      expect(minCell().tooltipText).toContain('it cancels');
    });
  });

  it('re-simulates the refreshed calldata and bounces to review when it now reverts', async () => {
    const baseQuote = {
      id: 'q-resim-1',
      fromToken: { address: '0xa', symbol: 'ETH', name: 'Ethereum', decimals: 18, chainId: 1, logoURI: '' },
      toToken: { address: '0xb', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: 1, logoURI: '' },
      fromAmount: '1',
      toAmount: '2000',
      fromAmountUSD: '2000',
      toAmountUSD: '2000',
      gasCost: '0.001',
      gasCostUSD: '5',
      exchangeRate: '1 ETH = 2000 USDC',
      estimatedTime: 30,
      priceImpact: '0.3',
      minimumReceived: '1990',
      slippage: 0.5,
      route: [],
      createdAt: Date.now(),
    };
    component.quote.set(baseQuote);
    // Same spender, same numbers — every other gate passes; the ONLY thing
    // that should stop the signature is the fresh calldata reverting.
    mockLifiService.refreshQuoteBeforeExecute.and.resolveTo({
      quote: baseQuote,
      approvalAddressChanged: false,
      priceChanged: false,
      refreshed: true,
      networkError: false,
    });
    mockLifiService.simulateSwap.and.resolveTo({ ok: false, reason: 'execution reverted', kind: 'unknown' });

    await component.executeSwap();

    // Never signed: the reverting bytes were caught before signing.
    expect(mockLifiService.simulateSwap).toHaveBeenCalled();
    expect(mockLifiService.executeSwap).not.toHaveBeenCalled();
    expect(component.transactionStatus()).toBe('idle');
    expect(component.currentStep()).toBe('review');
    expect(mockToastService.warning).toHaveBeenCalled();

    component.ngOnDestroy();
  });

  it('signs the refreshed calldata when its re-simulation passes (fail-open kept for non-reverts)', async () => {
    const baseQuote = {
      id: 'q-resim-2',
      fromToken: { address: '0xa', symbol: 'ETH', name: 'Ethereum', decimals: 18, chainId: 1, logoURI: '' },
      toToken: { address: '0xb', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: 1, logoURI: '' },
      fromAmount: '1',
      toAmount: '2000',
      fromAmountUSD: '2000',
      toAmountUSD: '2000',
      gasCost: '0.001',
      gasCostUSD: '5',
      exchangeRate: '1 ETH = 2000 USDC',
      estimatedTime: 30,
      priceImpact: '0.3',
      minimumReceived: '1990',
      slippage: 0.5,
      route: [],
      createdAt: Date.now(),
    };
    component.quote.set(baseQuote);
    mockLifiService.refreshQuoteBeforeExecute.and.resolveTo({
      quote: baseQuote,
      approvalAddressChanged: false,
      priceChanged: false,
      refreshed: true,
      networkError: false,
    });
    mockLifiService.simulateSwap.and.resolveTo({ ok: true });
    mockLifiService.executeSwap.and.resolveTo({
      hash: '0xhash',
      explorerUrl: 'https://etherscan.io/tx/0xhash',
    });

    await component.executeSwap();

    expect(mockLifiService.simulateSwap).toHaveBeenCalled();
    expect(mockLifiService.executeSwap).toHaveBeenCalledTimes(1);
    expect(component.currentStep()).toBe('status');

    component.ngOnDestroy();
  });

  it('clears the re-quote price notice when the user cancels review', () => {
    component.requotePriceNotice.set({
      previousToAmount: '2000',
      newToAmount: '1980',
      toSymbol: 'USDC'
    });
    component.currentStep.set('review');

    component.cancelReview();

    expect(component.requotePriceNotice()).toBeNull();
    expect(component.currentStep()).toBe('swap');
  });

  describe('requotePriceDropLabel', () => {
    it('spells out the relative drop even when formatting collapses the amounts', () => {
      // formatTokenAmount renders both of these as "0.0005" — the percent
      // suffix is the only thing that keeps the banner from showing
      // "0.0005 instead of 0.0005".
      component.requotePriceNotice.set({
        previousToAmount: '0.0005',
        newToAmount: '0.0004971',
        toSymbol: 'ETH'
      });

      expect(component.requotePriceDropLabel()).toBe('~0.6% less');
    });

    it('floors the displayed drop at 0.1%', () => {
      component.requotePriceNotice.set({
        previousToAmount: '10000',
        newToAmount: '9999.999',
        toSymbol: 'USDC'
      });

      expect(component.requotePriceDropLabel()).toBe('~0.1% less');
    });

    it('is empty without a notice or for a non-worsening notice', () => {
      expect(component.requotePriceDropLabel()).toBe('');

      component.requotePriceNotice.set({
        previousToAmount: '2000',
        newToAmount: '2020',
        toSymbol: 'USDC'
      });
      expect(component.requotePriceDropLabel()).toBe('');
    });
  });

  describe('fetchQuote failure while on review', () => {
    it('bounces back to the swap step so a failed refresh cannot strand the user on a blank review', async () => {
      (mockWalletService.isConnected as unknown as jasmine.Spy).and.returnValue(true);
      component.fromToken.set({ address: '0xa', symbol: 'ETH', name: 'Ethereum', decimals: 18, chainId: 1, logoURI: '' });
      component.toToken.set({ address: '0xb', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: 1, logoURI: '' });
      component.fromAmount = '1';
      component.currentStep.set('review');
      mockLifiService.getSwapQuote.and.rejectWith(new Error('NO_LIQUIDITY'));

      await component.fetchQuote(true);

      // The review template renders only with a quote — staying on review
      // with quote=null was the blank-page dead-end.
      expect(component.quote()).toBeNull();
      expect(component.currentStep()).toBe('swap');
      expect(component.error()).toBe('No liquidity available for this pair');
      expect(mockToastService.error).toHaveBeenCalledWith(
        'Quote refresh failed',
        'No liquidity available for this pair'
      );
    });

    it('stays on the swap step without a bounce toast when a regular fetch fails there', async () => {
      (mockWalletService.isConnected as unknown as jasmine.Spy).and.returnValue(true);
      component.fromToken.set({ address: '0xa', symbol: 'ETH', name: 'Ethereum', decimals: 18, chainId: 1, logoURI: '' });
      component.toToken.set({ address: '0xb', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: 1, logoURI: '' });
      component.fromAmount = '1';
      mockLifiService.getSwapQuote.and.rejectWith(new Error('NO_LIQUIDITY'));

      await component.fetchQuote(true);

      expect(component.currentStep()).toBe('swap');
      expect(component.error()).toBe('No liquidity available for this pair');
      expect(mockToastService.error).not.toHaveBeenCalled();
    });
  });

  describe('quote risk gate (component wiring)', () => {
    const makeQuote = (overrides: Partial<{
      priceImpact: string;
      fromAmountUSD: string;
      toAmountUSD: string;
      toAmount: string;
    }> = {}) => ({
      id: 'risk-quote',
      fromToken: { address: '0xa', symbol: 'ETH', name: 'Ethereum', decimals: 18, chainId: 1, logoURI: '' },
      toToken: { address: '0xb', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: 1, logoURI: '' },
      fromAmount: '1',
      toAmount: '2000',
      fromAmountUSD: '2000',
      toAmountUSD: '2000',
      gasCost: '0.001',
      gasCostUSD: '5',
      exchangeRate: '1 ETH = 2000 USDC',
      estimatedTime: 30,
      priceImpact: '0.3',
      minimumReceived: '1990',
      slippage: 0.5,
      route: [],
      ...overrides
    });

    it('maps the USD sentinel "0" and impact sentinel "0" to one ack with both reasons', () => {
      component.quote.set(makeQuote({ priceImpact: '0', fromAmountUSD: '0', toAmountUSD: '0' }));

      const risk = component.quoteRisk();
      expect(risk.hardBlock).toBeFalse();
      expect(risk.needsAck).toBeTrue();
      expect(risk.reasons).toEqual([RISK_REASON_IMPACT_UNKNOWN, RISK_REASON_USD_UNKNOWN]);
      // The unknown-USD sentinel must never silently pass as "not high value"
      // without the ack — and must not claim high value either.
      expect(component.isHighValueSwap()).toBeFalse();
    });

    it('hard-blocks an extreme-impact quote and exposes the impact for the copy', () => {
      component.quote.set(makeQuote({ priceImpact: '17.40' }));

      expect(component.quoteRisk().hardBlock).toBeTrue();
      expect(component.quoteRiskImpact()).toBeCloseTo(17.4, 10);
    });

    it('treats zero impact as KNOWN when both USD legs are priced — no ack', () => {
      // A healthy stablecoin swap: both legs present, impact genuinely 0.
      // This must not trip the "impact couldn't be determined" ack.
      component.quote.set(makeQuote({ priceImpact: '0.00', fromAmountUSD: '100', toAmountUSD: '100' }));

      expect(component.quoteRiskImpact()).toBe(0);
      const risk = component.quoteRisk();
      expect(risk.needsAck).toBeFalse();
      expect(risk.reasons).toEqual([]);
    });

    it('clamps favorable (negative) impact to zero when both USD legs are priced — no ack', () => {
      component.quote.set(makeQuote({ priceImpact: '-0.05', fromAmountUSD: '100', toAmountUSD: '100.05' }));

      expect(component.quoteRiskImpact()).toBe(0);
      const risk = component.quoteRisk();
      expect(risk.needsAck).toBeFalse();
      expect(risk.reasons).toEqual([]);
    });

    it('still treats the impact sentinel "0" as unknown when the to-side USD leg is missing', () => {
      component.quote.set(makeQuote({ priceImpact: '0', toAmountUSD: '0' }));

      expect(component.quoteRiskImpact()).toBeNull();
      const risk = component.quoteRisk();
      expect(risk.needsAck).toBeTrue();
      expect(risk.reasons).toEqual([RISK_REASON_IMPACT_UNKNOWN]);
    });

    it('builds the plain-English ack label with the impact percentage', () => {
      component.quote.set(makeQuote({ priceImpact: '7.20' }));

      expect(component.quoteRiskAckLabel()).toBe('I understand: high price impact (7.2%)');
    });

    it('reports no risk for a benign, fully-priced quote', () => {
      component.quote.set(makeQuote());

      const risk = component.quoteRisk();
      expect(risk.hardBlock).toBeFalse();
      expect(risk.needsAck).toBeFalse();
      expect(risk.reasons).toEqual([]);
    });

    it('resets the risk acknowledgement on review entry', () => {
      const q = makeQuote({ priceImpact: '7.20' });
      component.quote.set(q);
      // goToReview refuses entry when the typed amount or the token pair
      // doesn't match the quote (stale-quote gate) — align the input and
      // the selected tokens with the fixture.
      component.fromToken.set(q.fromToken);
      component.toToken.set(q.toToken);
      component.fromAmount = '1';
      component.acknowledgedQuoteRisk.set(true);

      component.goToReview();

      expect(component.currentStep()).toBe('review');
      expect(component.acknowledgedQuoteRisk()).toBeFalse();
    });

    it('blocks handleReviewConfirm until the risk ack is ticked', () => {
      // Below the $1k high-value threshold so this spec isolates the risk
      // ack — canConfirmSwap also guards the high-value ack now.
      component.quote.set(makeQuote({ priceImpact: '7.20', fromAmountUSD: '500', toAmountUSD: '464' }));
      const executeSpy = spyOn(component, 'executeSwap').and.resolveTo();

      component.handleReviewConfirm();
      expect(executeSpy).not.toHaveBeenCalled();
      expect(component.canConfirmSwap()).toBeFalse();

      component.acknowledgedQuoteRisk.set(true);
      expect(component.canConfirmSwap()).toBeTrue();
      component.handleReviewConfirm();
      expect(executeSpy).toHaveBeenCalled();
    });

    it('blocks handleReviewConfirm until the high-value ack is ticked', () => {
      // Default fixture is $2000 — above the $1k gate, benign impact.
      component.quote.set(makeQuote());
      const executeSpy = spyOn(component, 'executeSwap').and.resolveTo();

      component.handleReviewConfirm();
      expect(executeSpy).not.toHaveBeenCalled();
      expect(component.canConfirmSwap()).toBeFalse();

      component.acknowledgedHighValue.set(true);
      component.handleReviewConfirm();
      expect(executeSpy).toHaveBeenCalled();
    });

    it('blocks handleReviewConfirm while the simulation is pending or reverted without ack', () => {
      component.quote.set(makeQuote({ fromAmountUSD: '500' }));
      const executeSpy = spyOn(component, 'executeSwap').and.resolveTo();

      component.simulationState.set({ status: 'pending' });
      component.handleReviewConfirm();
      expect(executeSpy).not.toHaveBeenCalled();

      component.simulationState.set({ status: 'revert', reason: 'would revert', kind: 'slippage' });
      component.handleReviewConfirm();
      expect(executeSpy).not.toHaveBeenCalled();

      component.acknowledgedSimulationFailure.set(true);
      component.handleReviewConfirm();
      expect(executeSpy).toHaveBeenCalled();
    });

    it('never enables Confirm for an allowance revert, even with the simulation ack ticked', () => {
      component.quote.set(makeQuote({ fromAmountUSD: '500' }));
      component.simulationState.set({ status: 'revert', reason: 'no allowance', kind: 'allowance' });
      component.acknowledgedSimulationFailure.set(true);
      const executeSpy = spyOn(component, 'executeSwap').and.resolveTo();

      expect(component.canConfirmSwap()).toBeFalse();
      component.handleReviewConfirm();
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('never lets handleReviewConfirm through a hard block, even with acks ticked', () => {
      component.quote.set(makeQuote({ priceImpact: '20' }));
      component.acknowledgedQuoteRisk.set(true);
      component.acknowledgedHighValue.set(true);
      const executeSpy = spyOn(component, 'executeSwap').and.resolveTo();

      component.handleReviewConfirm();

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('rounds the displayed receive amount but keeps the raw quote amount intact', () => {
      component.quote.set(makeQuote({ toAmount: '1234.567890123456789012' }));

      expect(component.toAmountDisplay()).toBe('1234.56789');
      // Raw value stays untouched for minimumReceived / history / execution.
      expect(component.toAmount()).toBe('1234.567890123456789012');
    });
  });

  describe('token security gate (hard block + fail-closed unknown)', () => {
    const benignQuote = () => ({
      id: 'security-gate-quote',
      fromToken: { address: '0xa', symbol: 'ETH', name: 'Ethereum', decimals: 18, chainId: 1, logoURI: '' },
      toToken: { address: '0xb', symbol: 'SCAM', name: 'Scam Token', decimals: 18, chainId: 1, logoURI: '' },
      fromAmount: '0.1',
      toAmount: '1000',
      fromAmountUSD: '200',
      toAmountUSD: '200',
      gasCost: '0.001',
      gasCostUSD: '5',
      exchangeRate: '1 ETH = 10000 SCAM',
      estimatedTime: 30,
      priceImpact: '0.3',
      minimumReceived: '995',
      slippage: 0.5,
      route: [],
    });

    it('hard-blocks Confirm for an unsellable token — no acknowledgement can bypass', () => {
      component.quote.set(benignQuote());
      component.hardBlockToken.set(true);
      // Every checkbox a determined user could tick:
      component.acknowledgedHighRisk.set(true);
      component.acknowledgedQuoteRisk.set(true);
      component.acknowledgedHighValue.set(true);
      component.acknowledgedSimulationFailure.set(true);
      const executeSpy = spyOn(component, 'executeSwap').and.resolveTo();

      expect(component.canConfirmSwap()).toBeFalse();
      component.handleReviewConfirm();
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('refuses review entry for a hard-blocked token even via a programmatic call', () => {
      const q = benignQuote();
      component.quote.set(q);
      component.fromToken.set(q.fromToken);
      component.toToken.set(q.toToken);
      component.fromAmount = '0.1';
      component.hardBlockToken.set(true);

      component.goToReview();

      expect(component.currentStep()).toBe('swap');
    });

    it('hard block suppresses the ack checkbox path (no implied bypass)', () => {
      component.safetyLevel.set('critical');
      component.hardBlockToken.set(true);

      expect(component.requiresTokenRiskAck()).toBeFalse();
    });

    it("fails closed on an 'unknown' security verdict — ack required", () => {
      component.safetyLevel.set('unknown');

      expect(component.isUnverifiedToken()).toBeTrue();
      expect(component.requiresTokenRiskAck()).toBeTrue();
    });

    it('requires the ack for high and critical verdicts, not for safe/low', () => {
      component.safetyLevel.set('critical');
      expect(component.requiresTokenRiskAck()).toBeTrue();

      component.safetyLevel.set('high');
      expect(component.requiresTokenRiskAck()).toBeTrue();

      component.safetyLevel.set('safe');
      expect(component.requiresTokenRiskAck()).toBeFalse();

      component.safetyLevel.set('low');
      expect(component.requiresTokenRiskAck()).toBeFalse();
    });

    it('does not gate while the security check is still in flight (null)', () => {
      // null = check pending / no toToken; the gate waits for a verdict.
      component.safetyLevel.set(null);

      expect(component.isUnverifiedToken()).toBeFalse();
      expect(component.requiresTokenRiskAck()).toBeFalse();
    });
  });

  describe('untracked bridge state & background exit', () => {
    const makeCrossChainQuote = (toChainId = 8453, fromChainId = 1): SwapQuote => ({
      id: 'bridge-quote',
      fromToken: { address: '0xa', symbol: 'ETH', name: 'Ethereum', decimals: 18, chainId: fromChainId, logoURI: '' },
      toToken: { address: '0xb', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: toChainId, logoURI: '' },
      fromAmount: '1',
      toAmount: '2000',
      fromAmountUSD: '2000',
      toAmountUSD: '2000',
      gasCost: '0.001',
      gasCostUSD: '5',
      exchangeRate: '1 ETH = 2000 USDC',
      estimatedTime: 300,
      priceImpact: '0.3',
      minimumReceived: '1990',
      slippage: 0.5,
      route: []
    });

    /**
     * Drive the untracked presentation the way the app does now: hand the
     * confirmed swap to the hub via startBridgeTracking (a quote with no
     * tracking data lands in the untracked fallback immediately), then
     * flush the component's hub-mirror effect.
     */
    const startUntracked = (quote: SwapQuote, explorerUrl = 'https://etherscan.io/tx/0xsrchash'): void => {
      component['startBridgeTracking'](quote, '0xsrchash', explorerUrl, undefined, {});
      fixture.detectChanges();
    };

    it('shows the honest untracked copy and an Axelarscan link for Squid routes', () => {
      startUntracked({ ...makeCrossChainQuote(), aggregator: 'squid' });

      expect(component.transactionStatus()).toBe('confirming');
      expect(component.untrackedBridgeTrackingUrl()).toBe('https://axelarscan.io/gmp/0xsrchash');

      const bridging = component.trackingState()!.steps.find(s => s.id === 'bridging')!;
      expect(bridging.description).toContain("isn't tracked for this route yet");
      // The source-chain explorer link survives alongside the tracker link.
      expect(bridging.explorerLink).toBe('https://etherscan.io/tx/0xsrchash');
    });

    it('offers no Axelarscan link for non-Squid untrackable routes', () => {
      startUntracked({ ...makeCrossChainQuote(), aggregator: 'zerox' });

      expect(component.untrackedBridgeTrackingUrl()).toBeNull();
      // The explorer link still gives the user somewhere to verify.
      const bridging = component.trackingState()!.steps.find(s => s.id === 'bridging')!;
      expect(bridging.explorerLink).toBe('https://etherscan.io/tx/0xsrchash');
    });

    it('paints the untracked bridging step as neutral pending — never an eternal in-progress spinner', () => {
      startUntracked({ ...makeCrossChainQuote(43114, 42161), aggregator: 'squid' }, 'https://arbiscan.io/tx/0xsrchash');

      const state = component.trackingState()!;
      const bridging = state.steps.find(s => s.id === 'bridging')!;
      // 'in_progress' would pulse and count elapsed time forever with
      // nothing watching the transfer — beta testers read that as a hang
      // even after funds arrived on the destination chain.
      expect(bridging.status).toBe('pending');
      expect(state.isTracking).toBeFalse();
      // The source leg stays visibly done.
      expect(state.steps.find(s => s.id === 'source-confirm')!.status).toBe('completed');
    });

    it('keeps the "Start new swap" exit reachable from the untracked state', () => {
      component.quote.set(makeCrossChainQuote());
      component.txHash.set('0xsrchash');

      startUntracked({ ...makeCrossChainQuote(), aggregator: 'squid' });

      // 'confirming' + cross-chain executing quote is exactly what the exit
      // button keys off; txHash being set means it renders enabled — the
      // untracked wait never holds the user hostage on this screen.
      expect(component.transactionStatus()).toBe('confirming');
      expect(component.canStartNewSwapWhileBridging()).toBeTrue();
    });

    it('gates "Start new swap" to cross-chain swaps in confirming', () => {
      component.quote.set(makeCrossChainQuote());

      component.transactionStatus.set('confirming');
      expect(component.canStartNewSwapWhileBridging()).toBeTrue();

      // Not during signing/pending — the source tx may not exist yet.
      component.transactionStatus.set('signing');
      expect(component.canStartNewSwapWhileBridging()).toBeFalse();

      // Same-chain confirming resolves in seconds and needs no exit.
      component.transactionStatus.set('confirming');
      component.quote.set(makeCrossChainQuote(1));
      expect(component.canStartNewSwapWhileBridging()).toBeFalse();
    });

    it('resetSwap exits the bridge wait without touching the pending history record', () => {
      const history = TestBed.inject(TransactionHistoryService);
      const updateSpy = spyOn(history, 'updateTransaction');

      component.quote.set(makeCrossChainQuote());
      component.transactionStatus.set('confirming');
      component.txHash.set('0xsrchash');
      component.untrackedBridgeTrackingUrl.set('https://axelarscan.io/gmp/0xsrchash');

      component.resetSwap();

      expect(component.currentStep()).toBe('swap');
      expect(component.transactionStatus()).toBe('idle');
      expect(component.untrackedBridgeTrackingUrl()).toBeNull();
      // markSuccess / markFailed both route through updateTransaction — the
      // record must stay pending: the transfer continues on-chain.
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('detaches an in-flight tracker from the UI on reset but still finalizes history', async () => {
      const history = TestBed.inject(TransactionHistoryService);
      const markSuccessSpy = spyOn(history, 'markSuccess');
      let resolveTracking!: (value: LifiStatusResponse | null) => void;
      mockTrackerService.trackTransaction.and.returnValue(
        new Promise<LifiStatusResponse | null>(resolve => { resolveTracking = resolve; })
      );

      component['startBridgeTracking'](
        { ...makeCrossChainQuote(), aggregator: 'lifi' }, '0xhash', '', 'record-1', {},
      );
      const onUpdate = mockTrackerService.trackTransaction.calls.mostRecent().args[3];

      component.resetSwap();

      // A stale progress poll must not repaint the fresh swap screen (it
      // lands in the hub, but the mirror is detached after reset).
      onUpdate({ progress: 80, currentStep: 2, steps: [], isTracking: true });
      fixture.detectChanges();
      expect(component.trackingState()).toBeNull();

      resolveTracking({ transactionId: 't1', status: 'DONE' });
      await new Promise<void>(resolve => setTimeout(resolve));
      fixture.detectChanges();

      // The history verdict and the completion toast still land…
      expect(markSuccessSpy).toHaveBeenCalledWith('record-1', '0xhash');
      expect(mockToastService.success).toHaveBeenCalled();
      // …but the screen the user already left stays on the new swap.
      expect(component.transactionStatus()).toBe('idle');
    });
  });

  describe('LI.FI tracker null resolution: timeout toast vs abort', () => {
    const makeLifiBridgeQuote = (): SwapQuote => makeExecQuote({
      toToken: { address: '0xb', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: 8453, logoURI: '' },
      aggregator: 'lifi',
    });
    const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve));

    it('still warns on a live tracker timeout (regression guard)', async () => {
      mockTrackerService.trackTransaction.and.resolveTo(null);

      component['startBridgeTracking'](makeLifiBridgeQuote(), '0xhash', '', 'record-t', {});
      await flush();
      fixture.detectChanges();

      expect(mockToastService.warning).toHaveBeenCalledWith(
        'Bridge tracking timed out',
        jasmine.stringContaining('still being processed'),
      );
      expect(component.transactionStatus()).toBe('confirming');
    });

    it('destroy no longer aborts tracking — the hub keeps polling and a real timeout still warns', async () => {
      let resolveTracking!: (value: LifiStatusResponse | null) => void;
      mockTrackerService.trackTransaction.and.returnValue(
        new Promise<LifiStatusResponse | null>(resolve => { resolveTracking = resolve; }),
      );

      component['startBridgeTracking'](makeLifiBridgeQuote(), '0xhash', '', 'record-d', {});
      component.transactionStatus.set('confirming');

      // Navigation away from a healthy in-flight bridge: tracking is
      // hub-owned now, so destroying the component must NOT abort it —
      // that abort-on-destroy was exactly the beta-tester pain.
      component.ngOnDestroy();
      const abortSignal = mockTrackerService.trackTransaction.calls.mostRecent().args[7]!;
      expect(abortSignal.aborted).toBeFalse();

      // A genuine timeout later still lands its warning — screen or no screen.
      resolveTracking(null);
      await flush();
      expect(mockToastService.warning).toHaveBeenCalledWith(
        'Bridge tracking timed out',
        jasmine.stringContaining('still being processed'),
      );
    });
  });

  describe('aggregator bridge tracking (squid)', () => {
    const makeSquidQuote = (): SwapQuote => ({
      id: 'squid-quote',
      fromToken: { address: '0xa', symbol: 'ETH', name: 'Ethereum', decimals: 18, chainId: 1, logoURI: '' },
      toToken: { address: '0xb', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: 8453, logoURI: '' },
      fromAmount: '1',
      toAmount: '2000',
      fromAmountUSD: '2000',
      toAmountUSD: '2000',
      gasCost: '0.001',
      gasCostUSD: '5',
      exchangeRate: '1 ETH = 2000 USDC',
      estimatedTime: 300,
      priceImpact: '0.3',
      minimumReceived: '1990',
      slippage: 0.5,
      route: [],
      createdAt: Date.now(),
      aggregator: 'squid',
      _aggregatorData: {
        aggregator: 'squid',
        to_amount: '2000000000',
        approval_address: '0xspender',
        tx_request: { to: '0xrouter', data: '0x', value: '0' },
        quoted_at: Date.now(),
        tracking_quote_id: 'qid-1',
        tracking_request_id: 'rid-1',
      },
    });

    /** Let the trackAggregatorBridge .then() handler run. */
    const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve));

    /**
     * Hand a confirmed squid swap to the hub the way executeSwap does, then
     * flush the component's hub-mirror effect so the screen assertions see
     * the repaint.
     */
    const startSquidTracking = (
      quote: SwapQuote = makeSquidQuote(),
      recordId?: string,
      explorerUrl = '',
    ): void => {
      component['startBridgeTracking'](quote, '0xsrchash', explorerUrl, recordId, {
        from_chain: 1, to_chain: 8453, cross_chain: true, aggregator: 'squid',
      });
    };

    it('routes a squid cross-chain swap to the backend status tracker after execution', async () => {
      const q = makeSquidQuote();
      component.quote.set(q);
      mockLifiService.refreshQuoteBeforeExecute.and.resolveTo({
        quote: q,
        refreshed: true,
        networkError: false,
        priceChanged: false,
        approvalAddressChanged: false,
      });
      // The execution service emits 'completed' only after a status-1
      // SOURCE receipt — and only then may a bridge tracker start.
      mockLifiService.executeSwap.and.callFake(async (_quote, onStatusChange) => {
        onStatusChange?.('signing');
        onStatusChange?.('pending', '0xsrchash');
        onStatusChange?.('completed', '0xsrchash');
        return {
          hash: '0xsrchash',
          explorerUrl: 'https://etherscan.io/tx/0xsrchash',
        };
      });
      mockTrackerService.trackAggregatorBridge.and.returnValue(new Promise<never>(() => {}));

      await component.executeSwap();

      expect(mockTrackerService.trackAggregatorBridge).toHaveBeenCalledTimes(1);
      const [params] = mockTrackerService.trackAggregatorBridge.calls.mostRecent().args;
      expect(params).toEqual({
        aggregator: 'squid',
        txHash: '0xsrchash',
        fromChain: 1,
        toChain: 8453,
        quoteId: 'qid-1',
        requestId: 'rid-1',
      });
      // The LI.FI tracker must NOT poll a transfer it can't see.
      expect(mockTrackerService.trackTransaction).not.toHaveBeenCalled();
    });

    it('falls back to the untracked-bridge state when the dispatcher reports unsupported', async () => {
      mockTrackerService.trackAggregatorBridge.and.resolveTo({ kind: 'unsupported' });

      startSquidTracking(makeSquidQuote(), undefined, 'https://etherscan.io/tx/0xsrchash');
      await flush();
      fixture.detectChanges();

      // Mirrors the untrackable-state specs: honest copy + Axelarscan link,
      // status stays 'confirming' — never 'failed'.
      expect(component.transactionStatus()).toBe('confirming');
      expect(component.untrackedBridgeTrackingUrl()).toBe('https://axelarscan.io/gmp/0xsrchash');
      const bridging = component.trackingState()!.steps.find(s => s.id === 'bridging')!;
      expect(bridging.description).toContain("isn't tracked for this route yet");
      expect(bridging.explorerLink).toBe('https://etherscan.io/tx/0xsrchash');
    });

    it('falls back to the untracked-bridge state when the tracker gives up on transient errors', async () => {
      mockTrackerService.trackAggregatorBridge.and.resolveTo({ kind: 'gave_up', lastObservedStatus: null });

      startSquidTracking();
      await flush();
      fixture.detectChanges();

      expect(component.transactionStatus()).toBe('confirming');
      expect(component.untrackedBridgeTrackingUrl()).toBe('https://axelarscan.io/gmp/0xsrchash');
    });

    it('annotates the history record when tracking gives up mid-refund, keeping it pending', async () => {
      const history = TestBed.inject(TransactionHistoryService);
      const updateSpy = spyOn(history, 'updateTransaction');
      mockTrackerService.trackAggregatorBridge.and.resolveTo({
        kind: 'gave_up',
        lastObservedStatus: 'refunding',
      });

      startSquidTracking(makeSquidQuote(), 'record-r');
      await flush();

      expect(updateSpy).toHaveBeenCalledWith('record-r', jasmine.objectContaining({
        bridgeAnnotation: 'refunding',
        errorMessage: jasmine.stringContaining('refund'),
      }));
      // Status is deliberately NOT part of the update — the outcome is
      // unresolved; only the stale-pending normalization may finalize it.
      const updates = updateSpy.calls.mostRecent().args[1];
      expect('status' in updates).toBeFalse();
    });

    it('annotates the history record when tracking times out while needs_gas', async () => {
      const history = TestBed.inject(TransactionHistoryService);
      const updateSpy = spyOn(history, 'updateTransaction');
      mockTrackerService.trackAggregatorBridge.and.resolveTo({
        kind: 'timeout',
        lastObservedStatus: 'needs_gas',
      });

      startSquidTracking(makeSquidQuote(), 'record-g');
      await flush();
      fixture.detectChanges();

      expect(component.transactionStatus()).toBe('confirming');
      expect(updateSpy).toHaveBeenCalledWith('record-g', jasmine.objectContaining({
        bridgeAnnotation: 'needs_gas',
      }));
    });

    it('does not annotate a timeout from a plain pending status', async () => {
      const history = TestBed.inject(TransactionHistoryService);
      const updateSpy = spyOn(history, 'updateTransaction');
      mockTrackerService.trackAggregatorBridge.and.resolveTo({
        kind: 'timeout',
        lastObservedStatus: 'pending',
      });

      startSquidTracking(makeSquidQuote(), 'record-p');
      await flush();

      // A plain pending timeout is the normal indeterminate case — the
      // 60-min normalization may present it as delivered, so no annotation.
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('completes the swap on a success verdict: history, analytics, toast, tracker link', async () => {
      const history = TestBed.inject(TransactionHistoryService);
      const markSuccessSpy = spyOn(history, 'markSuccess');
      const analyticsSpy = spyOn(TestBed.inject(AnalyticsService), 'track');
      mockTrackerService.trackAggregatorBridge.and.resolveTo({
        kind: 'success',
        response: {
          aggregator: 'squid',
          status: 'success',
          substatus: 'DESTINATION_EXECUTED',
          tracking_url: 'https://axelarscan.io/gmp/0xsrchash',
          is_final: true,
        },
      });

      startSquidTracking(makeSquidQuote(), 'record-1');
      await flush();
      fixture.detectChanges();

      expect(component.transactionStatus()).toBe('completed');
      expect(component.untrackedBridgeTrackingUrl()).toBe('https://axelarscan.io/gmp/0xsrchash');
      expect(markSuccessSpy).toHaveBeenCalledWith('record-1', '0xsrchash');
      expect(analyticsSpy).toHaveBeenCalledWith(
        'swap_completed',
        jasmine.objectContaining({ aggregator: 'squid' }),
      );
      expect(mockToastService.success).toHaveBeenCalled();
    });

    it('fails the swap with the partial-delivery explanation on a partial verdict', async () => {
      const history = TestBed.inject(TransactionHistoryService);
      const markFailedSpy = spyOn(history, 'markFailed');
      const analyticsSpy = spyOn(TestBed.inject(AnalyticsService), 'track');
      mockTrackerService.trackAggregatorBridge.and.resolveTo({
        kind: 'partial',
        response: { aggregator: 'squid', status: 'partial_success', substatus: 'PARTIAL_SUCCESS', is_final: true },
        reason: PARTIAL_SUCCESS_REASON,
      });

      startSquidTracking(makeSquidQuote(), 'record-2');
      await flush();
      fixture.detectChanges();

      expect(component.transactionStatus()).toBe('failed');
      expect(component.txError()).toBe(PARTIAL_SUCCESS_REASON);
      expect(markFailedSpy).toHaveBeenCalledWith('record-2', PARTIAL_SUCCESS_REASON);
      expect(analyticsSpy).toHaveBeenCalledWith(
        'swap_failed',
        jasmine.objectContaining({ reason: 'failed' }),
      );
      expect(mockToastService.error).toHaveBeenCalled();
    });

    it('mirrors tracker progress and surfaces the tracking URL while polling', () => {
      mockTrackerService.trackAggregatorBridge.and.returnValue(new Promise<never>(() => {}));
      startSquidTracking();
      const onUpdate = mockTrackerService.trackAggregatorBridge.calls.mostRecent().args[1];

      onUpdate({
        progress: 45,
        currentStep: 1,
        steps: [],
        isTracking: true,
        trackingUrl: 'https://axelarscan.io/gmp/0xsrchash',
      });
      fixture.detectChanges();

      expect(component.trackingState()!.progress).toBe(45);
      expect(component.untrackedBridgeTrackingUrl()).toBe('https://axelarscan.io/gmp/0xsrchash');
    });

    it('ignores stale tracker callbacks after the user starts a new swap', () => {
      mockTrackerService.trackAggregatorBridge.and.returnValue(new Promise<never>(() => {}));
      startSquidTracking();
      const onUpdate = mockTrackerService.trackAggregatorBridge.calls.mostRecent().args[1];

      component.resetSwap();
      onUpdate({ progress: 80, currentStep: 2, steps: [], isTracking: true });
      fixture.detectChanges();

      expect(component.trackingState()).toBeNull();
      expect(component.untrackedBridgeTrackingUrl()).toBeNull();
    });

    it('drops a regressed poll behind the bridging seed but still surfaces the tracker link', () => {
      mockTrackerService.trackAggregatorBridge.and.returnValue(new Promise<never>(() => {}));
      component.transactionStatus.set('confirming');
      startSquidTracking();
      const onUpdate = mockTrackerService.trackAggregatorBridge.calls.mostRecent().args[1];

      // The tracker's own initial push after the source receipt: bridging
      // in progress @60 (it fires synchronously in the real loop).
      onUpdate({
        progress: 60,
        currentStep: 1,
        steps: [
          { id: 'source-confirm', title: 'Confirmed', status: 'completed' },
          { id: 'bridging', title: 'Bridging tokens', status: 'in_progress' },
        ],
        isTracking: true,
      });
      // A lagging poll reporting 45 must not walk the bar backwards — but
      // its tracking URL is still news.
      onUpdate({
        progress: 45,
        currentStep: 1,
        steps: [],
        isTracking: true,
        trackingUrl: 'https://axelarscan.io/gmp/0xsrchash',
      });
      fixture.detectChanges();

      expect(component.trackingState()!.progress).toBe(60);
      expect(component.untrackedBridgeTrackingUrl()).toBe('https://axelarscan.io/gmp/0xsrchash');
    });

    it('still lands the history verdict after reset, without repainting the screen', async () => {
      const history = TestBed.inject(TransactionHistoryService);
      const markSuccessSpy = spyOn(history, 'markSuccess');
      let resolveTracking!: (outcome: AggregatorBridgeOutcome) => void;
      mockTrackerService.trackAggregatorBridge.and.returnValue(
        new Promise<AggregatorBridgeOutcome>(resolve => { resolveTracking = resolve; }),
      );

      startSquidTracking(makeSquidQuote(), 'record-3');
      component.resetSwap();

      resolveTracking({
        kind: 'success',
        response: { aggregator: 'squid', status: 'success', substatus: 'OK', is_final: true },
      });
      await flush();
      fixture.detectChanges();

      // The bridge genuinely delivered — history must say so…
      expect(markSuccessSpy).toHaveBeenCalledWith('record-3', '0xsrchash');
      // …but the screen the user already left stays on the new swap.
      expect(component.transactionStatus()).toBe('idle');
      expect(component.untrackedBridgeTrackingUrl()).toBeNull();
    });

    it('destroy does NOT abort the hub-owned polling loop — tracking survives navigation', () => {
      mockTrackerService.trackAggregatorBridge.and.returnValue(new Promise<never>(() => {}));

      startSquidTracking();

      const abortSignal = mockTrackerService.trackAggregatorBridge.calls.mostRecent().args[4];
      expect(abortSignal).toBeInstanceOf(AbortSignal);
      expect(abortSignal!.aborted).toBeFalse();
      component.ngOnDestroy();
      // The whole point of the hub: leaving the swap screen keeps the loop
      // (and its eventual history verdict + toast) alive.
      expect(abortSignal!.aborted).toBeFalse();
    });

    it('an aborted outcome (loop replaced by a newer swap) paints no failure and fires no toasts', async () => {
      const history = TestBed.inject(TransactionHistoryService);
      const updateSpy = spyOn(history, 'updateTransaction');
      let resolveFirst!: (outcome: AggregatorBridgeOutcome) => void;
      mockTrackerService.trackAggregatorBridge.and.returnValues(
        new Promise<AggregatorBridgeOutcome>(resolve => { resolveFirst = resolve; }),
        new Promise<never>(() => {}),
      );

      startSquidTracking(makeSquidQuote(), 'record-a');
      component.transactionStatus.set('confirming');

      // A second swap replaces the first (single active swap in MVP): the
      // hub aborts the old loop, which resolves 'aborted'.
      startSquidTracking(makeSquidQuote(), 'record-b');
      const firstAbort = mockTrackerService.trackAggregatorBridge.calls.first().args[4]!;
      expect(firstAbort.aborted).toBeTrue();

      resolveFirst({ kind: 'aborted' });
      await flush();

      // Aborted is fully silent: no failure paint, no untracked-fallback
      // repaint, no toast, no history writes — the record stays pending and
      // rehydration owns the final verdict.
      expect(component.transactionStatus()).toBe('confirming');
      expect(mockToastService.warning).not.toHaveBeenCalled();
      expect(mockToastService.error).not.toHaveBeenCalled();
      expect(mockToastService.info).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    });
  });

  describe('trackingLinkLabel', () => {
    it('names Axelarscan only for axelarscan.io hosts', () => {
      expect(component.trackingLinkLabel('https://axelarscan.io/gmp/0x1')).toBe('Track on Axelarscan');
      expect(component.trackingLinkLabel('https://testnet.axelarscan.io/gmp/0x1')).toBe('Track on Axelarscan');
      // Lookalike host must not borrow the brand name.
      expect(component.trackingLinkLabel('https://axelarscan.io.evil.example/gmp/0x1')).toBe('Track transfer');
      expect(component.trackingLinkLabel('https://layerzeroscan.com/tx/0x1')).toBe('Track transfer');
    });

    it('falls back to the generic label on an unparseable URL', () => {
      expect(component.trackingLinkLabel('not a url')).toBe('Track transfer');
    });
  });

  // ---------------------------------------------------------------------------
  // Input handling (audit 2026-06-11, stage 4)
  // ---------------------------------------------------------------------------

  const ethToken = { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'Ethereum', decimals: 18, chainId: 1, logoURI: '' };
  const usdcToken = { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: 1, logoURI: '' };
  const daiToken = { address: '0x6b175474e89094c44da98b954eedeac495271d0f', symbol: 'DAI', name: 'Dai', decimals: 18, chainId: 1, logoURI: '' };

  const makeQuote = (
    fromAmount: string,
    toAmount: string = '2000',
    fromToken: SwapQuote['fromToken'] = ethToken,
    toToken: SwapQuote['toToken'] = usdcToken,
  ): SwapQuote => ({
    id: 'q-input',
    fromToken,
    toToken,
    fromAmount,
    toAmount,
    fromAmountUSD: '2000',
    toAmountUSD: '2000',
    gasCost: '0.001',
    gasCostUSD: '5',
    exchangeRate: '1 ETH = 2000 USDC',
    estimatedTime: 30,
    priceImpact: '0.3',
    minimumReceived: '1990',
    slippage: 0.5,
    route: [],
    createdAt: Date.now(),
  });

  describe('setPercentage (raw-balance bigint math)', () => {
    it('MAX never rounds up past the real balance', () => {
      // The old float path ((usable * percent / 100).toFixed(p)) rounded
      // 1.999999995 half-up to '2.00000000' — more than the wallet holds,
      // i.e. an instant false 'Not enough DAI' right after pressing MAX.
      mockLifiService.isNativeToken.and.returnValue(false);
      component.fromToken.set(daiToken);
      component.fromBalance.set(1.999999995);
      component.fromBalanceExact.set('1.999999995');

      component.setPercentage(100);

      expect(component.fromAmount).toBe('1.99999999');
      expect(parseFloat(component.fromAmount)).toBeLessThanOrEqual(1.999999995);
      expect(() => parseUnits(component.fromAmount, 18)).not.toThrow();
      expect(parseUnits(component.fromAmount, 18) <= parseUnits('1.999999995', 18)).toBeTrue();
      expect(component.isInsufficientBalance()).toBeFalse();
      expect(component.activePercent()).toBe(100);
    });

    it('partial percents truncate instead of rounding', () => {
      mockLifiService.isNativeToken.and.returnValue(false);
      component.fromToken.set(daiToken);
      component.fromBalance.set(1.000000015);
      component.fromBalanceExact.set('1.000000015');

      component.setPercentage(50);

      // Exact half is 0.5000000075 — toFixed(8) rounded it to '0.50000001'.
      expect(component.fromAmount).toBe('0.50000000');
      expect(component.activePercent()).toBe(50);
    });

    it('native MAX keeps the gas reserve and truncates', () => {
      mockLifiService.isNativeToken.and.returnValue(true);
      component.fromToken.set(ethToken);
      component.fromBalance.set(1);
      component.fromBalanceExact.set('1.0');

      component.setPercentage(100);

      // 1 ETH minus the mainnet reserve of 0.005.
      expect(component.fromAmount).toBe('0.995');
    });

    it('native MAX below the gas reserve warns and bails', () => {
      mockLifiService.isNativeToken.and.returnValue(true);
      component.fromToken.set(ethToken);
      component.fromBalance.set(0.004);
      component.fromBalanceExact.set('0.004');

      component.setPercentage(100);

      expect(component.fromAmount).toBe('');
      expect(component.activePercent()).toBeNull();
      expect(mockToastService.warning).toHaveBeenCalled();
    });
  });

  describe('comma decimal input', () => {
    it('normalizes a pasted comma decimal instead of corrupting it 10x', () => {
      component.onFromAmountChange('1,5');
      expect(component.fromAmount).toBe('1.5');
    });

    it('typing a comma is allowed at the keydown stage and lands as a dot', () => {
      const input = document.createElement('input');
      input.value = '1';
      const event = new KeyboardEvent('keydown', { key: ',', cancelable: true });
      Object.defineProperty(event, 'target', { value: input });

      component.onAmountKeydown(event);
      expect(event.defaultPrevented).toBeFalse();

      // The browser inserts the ',' and fires input — the handler normalizes.
      component.onFromAmountChange('1,');
      expect(component.fromAmount).toBe('1.');
    });

    it('blocks a second decimal separator at the keydown stage', () => {
      for (const existing of ['1.5', '1,']) {
        for (const key of [',', '.']) {
          const input = document.createElement('input');
          input.value = existing;
          const event = new KeyboardEvent('keydown', { key, cancelable: true });
          Object.defineProperty(event, 'target', { value: input });

          component.onAmountKeydown(event);
          expect(event.defaultPrevented).withContext(`'${key}' on '${existing}'`).toBeTrue();
        }
      }
    });

    it('refuses the ambiguous grouped paste — value unchanged, warning shown once', () => {
      // '1,000' is 1000 in US grouping but 1.0 to the comma-decimal
      // sanitizer; '1,500' is even worse (1500 vs 1.5). Neither reading can
      // be defended, so the handler keeps the previous value and warns.
      component.onFromAmountChange('2');
      expect(component.fromAmount).toBe('2');

      component.onFromAmountChange('1,000');
      expect(component.fromAmount).toBe('2');
      expect(mockToastService.warning).toHaveBeenCalledTimes(1);

      component.onFromAmountChange('1,500');
      expect(component.fromAmount).toBe('2');
      // One-time warning: the second refusal doesn't re-toast.
      expect(mockToastService.warning).toHaveBeenCalledTimes(1);
    });

    it('still accepts the unambiguous comma shapes', () => {
      // Single comma with a short fraction = EU decimal, as before.
      component.onFromAmountChange('1,5');
      expect(component.fromAmount).toBe('1.5');

      // Comma AND dot = grouping + decimal, as before.
      component.onFromAmountChange('1,000.5');
      expect(component.fromAmount).toBe('1000.5');
      expect(mockToastService.warning).not.toHaveBeenCalled();
    });
  });

  describe('stale-quote gate (quoteMatchesInput)', () => {
    beforeEach(() => {
      // quoteMatchesInput also checks token identity — keep the selected
      // pair aligned with makeQuote's default ETH→USDC fixture.
      component.fromToken.set(ethToken);
      component.toToken.set(usdcToken);
    });

    it('a typed amount that differs from the quote marks it stale', () => {
      component.quote.set(makeQuote('1'));
      component.onFromAmountChange('5');
      expect(component.quoteMatchesInput()).toBeFalse();
    });

    it('trailing zeros are not a mismatch', () => {
      component.quote.set(makeQuote('1'));
      component.fromAmount = '1.000';
      expect(component.quoteMatchesInput()).toBeTrue();
    });

    it('never matches while no quote exists', () => {
      component.fromAmount = '1';
      expect(component.quoteMatchesInput()).toBeFalse();
    });

    it('goToReview refuses a quote fetched for a different amount', () => {
      spyOn(TestBed.inject(AnalyticsService), 'track');
      component.quote.set(makeQuote('1'));
      component.fromAmount = '5';

      component.goToReview();
      expect(component.currentStep()).toBe('swap');

      component.fromAmount = '1.0';
      component.goToReview();
      expect(component.currentStep()).toBe('review');
    });

    it('percent presets leave no false-stale state once their quote lands', () => {
      mockLifiService.isNativeToken.and.returnValue(false);
      component.fromToken.set(usdcToken);
      component.toToken.set(daiToken);
      component.fromBalance.set(100);
      component.fromBalanceExact.set('100.0');

      component.setPercentage(50);
      // The debounced fetch echoes the requested amount back on the quote.
      component.quote.set(makeQuote(component.fromAmount, '2000', usdcToken, daiToken));
      expect(component.quoteMatchesInput()).toBeTrue();
    });

    it('equal amounts never match a quote for a different pair (defense-in-depth)', () => {
      component.quote.set(makeQuote('1')); // ETH→USDC
      component.fromAmount = '1';
      expect(component.quoteMatchesInput()).toBeTrue();

      // The pair flips out from under a (hypothetically resurrected) quote —
      // the amount-only comparison alone would still report a match.
      component.fromToken.set(usdcToken);
      component.toToken.set(ethToken);
      expect(component.quoteMatchesInput()).toBeFalse();
    });
  });

  describe('flip (swapTokens) rate handling', () => {
    beforeEach(() => {
      mockWalletService.getTokenBalance.and.resolveTo('0');
    });

    it('resets the old direction\'s exchange rate on flip', () => {
      // Keep the re-prime fetch pending so the reset itself is observable.
      mockLifiService.getSwapQuote.and.returnValue(new Promise<SwapQuote | null>(() => undefined));
      component.fromToken.set(ethToken);
      component.toToken.set(usdcToken);
      component.lastExchangeRate.set(2500);

      component.swapTokens();

      expect(component.lastExchangeRate()).toBe(0);
      expect(component.fromToken()).toEqual(usdcToken);
      expect(component.toToken()).toEqual(ethToken);
    });

    it('primes the initial rate for the new direction after a flip', async () => {
      mockLifiService.getSwapQuote.and.resolveTo(makeQuote('1', '0.0004'));
      component.fromToken.set(ethToken);
      component.toToken.set(usdcToken);
      component.lastExchangeRate.set(2500);

      component.swapTokens();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockLifiService.getSwapQuote).toHaveBeenCalled();
      expect(component.lastExchangeRate()).toBeCloseTo(0.0004, 10);
    });

    it('a stale 1-unit rate response cannot clobber a fresher rate', async () => {
      let resolveQuote!: (value: SwapQuote | null) => void;
      mockLifiService.getSwapQuote.and.returnValue(
        new Promise<SwapQuote | null>((resolve) => { resolveQuote = resolve; })
      );
      component.fromToken.set(ethToken);
      component.toToken.set(usdcToken);

      const pending = component['fetchInitialRate']();
      // A real quote lands while the test quote is still in flight.
      component.lastExchangeRate.set(3000);
      resolveQuote(makeQuote('1', '2'));
      await pending;

      expect(component.lastExchangeRate()).toBe(3000);
    });

    it('drops a rate response that belongs to the pre-flip direction', async () => {
      const resolvers: Array<(value: SwapQuote | null) => void> = [];
      mockLifiService.getSwapQuote.and.callFake(
        () => new Promise<SwapQuote | null>((resolve) => { resolvers.push(resolve); })
      );
      component.fromToken.set(ethToken);
      component.toToken.set(usdcToken);

      const pending = component['fetchInitialRate']();
      component.swapTokens(); // direction changed while the fetch is in flight

      resolvers[0](makeQuote('1', '2500')); // the old ETH→USDC response, late
      await pending;

      expect(component.lastExchangeRate()).toBe(0);
    });

    it('a flip disowns the in-flight quote fetch — the late old-direction response is dropped', async () => {
      (mockWalletService.isConnected as unknown as jasmine.Spy).and.returnValue(true);
      const resolvers: Array<(value: SwapQuote | null) => void> = [];
      mockLifiService.getSwapQuote.and.callFake(
        () => new Promise<SwapQuote | null>((resolve) => { resolvers.push(resolve); })
      );
      mockLifiService.isNativeToken.and.returnValue(true);
      component.fromToken.set(ethToken);
      component.toToken.set(usdcToken);
      component.fromAmount = '1';

      const pending = component.fetchQuote();
      component.swapTokens(); // user flips while the ETH→USDC fetch is in flight

      // The OLD-direction response lands after the flip cleared everything.
      // Without the seq bump in swapTokens it passed the staleness gate,
      // resurrected the pre-flip quote and repainted lastExchangeRate —
      // after which the correct fetchInitialRate early-returns on rate>0.
      resolvers[0](makeQuote('1', '2500'));
      await pending;

      expect(component.quote()).toBeNull();
      expect(component.lastExchangeRate()).toBe(0);
      expect(component.isLoading()).toBeFalse();
    });
  });

  describe('null quote resolution (no throw)', () => {
    it('surfaces the retryable error CTA instead of an eternal "Getting quote…"', async () => {
      (mockWalletService.isConnected as unknown as jasmine.Spy).and.returnValue(true);
      component.fromToken.set(ethToken);
      component.toToken.set(usdcToken);
      component.fromAmount = '1';
      mockLifiService.getSwapQuote.and.resolveTo(null);

      await component.fetchQuote(true);

      // quote=null + error=null used to park the CTA in its loading branch
      // forever; the explicit error routes it to the clickable retry CTA.
      expect(component.quote()).toBeNull();
      expect(component.error()).toBe('Failed to get quote');
      expect(component.isLoading()).toBeFalse();
      expect(component.hasValidQuoteInputs()).toBeTrue();
      expect(component.quoteErrorCta()).toContain('Tap to retry');
    });
  });

  describe('stale balance fetch (token switched mid-flight)', () => {
    it('drops a from-side balance that lands after the token changed', async () => {
      let resolveBalance!: (value: string) => void;
      mockWalletService.getTokenBalance.and.returnValue(
        new Promise<string>((resolve) => { resolveBalance = resolve; })
      );
      component.fromToken.set(ethToken);

      const pending = component.updateFromBalance();
      component.fromToken.set(daiToken); // switch while the ETH fetch is in flight
      resolveBalance('5');
      await pending;

      // The stale '5' belongs to ETH — writing it under DAI hands MAX the
      // wrong balance (money-path).
      expect(component.fromBalance()).toBe(0);
      expect(component.fromBalanceExact()).toBe('0');
    });

    it('drops a to-side balance the same way', async () => {
      let resolveBalance!: (value: string) => void;
      mockWalletService.getTokenBalance.and.returnValue(
        new Promise<string>((resolve) => { resolveBalance = resolve; })
      );
      component.toToken.set(ethToken);

      const pending = component.updateToBalance();
      component.toToken.set(daiToken);
      resolveBalance('5');
      await pending;

      expect(component.toBalance()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Hidden-tab polling (audit 2026-06-11, stage 6)
  // ---------------------------------------------------------------------------

  describe('hidden-tab polling', () => {
    let hiddenSpy: jasmine.Spy;

    beforeEach(() => {
      jasmine.clock().install();
      // document.hidden is a configurable accessor on Document.prototype —
      // spying there is the cheap way to simulate tab visibility.
      hiddenSpy = spyOnProperty(Document.prototype, 'hidden', 'get').and.returnValue(false);
    });

    afterEach(() => {
      jasmine.clock().uninstall();
    });

    it('skips the 30s quote auto-refresh while the tab is hidden and resumes when visible', async () => {
      spyOn(TestBed.inject(AnalyticsService), 'track');
      (mockWalletService.isConnected as unknown as jasmine.Spy).and.returnValue(true);
      component.fromToken.set(ethToken);
      component.toToken.set(usdcToken);
      component.fromAmount = '1';
      mockLifiService.getSwapQuote.and.resolveTo(makeQuote('1'));
      mockLifiService.isNativeToken.and.returnValue(true);

      await component.fetchQuote(); // success → auto-refresh armed
      expect(mockLifiService.getSwapQuote).toHaveBeenCalledTimes(1);

      hiddenSpy.and.returnValue(true);
      jasmine.clock().tick(30_000);
      // Nobody is looking — no /best-quote fan-out from a background tab.
      expect(mockLifiService.getSwapQuote).toHaveBeenCalledTimes(1);

      hiddenSpy.and.returnValue(false);
      jasmine.clock().tick(30_000);
      expect(mockLifiService.getSwapQuote).toHaveBeenCalledTimes(2);
    });

    it('runs one immediate refresh (quote + gas) on return to a visible swap step with a quote', () => {
      const fetchSpy = spyOn(component, 'fetchQuote').and.resolveTo();
      const gasSpy = spyOn(
        component as unknown as { updateGasPrice(): Promise<void> },
        'updateGasPrice',
      ).and.resolveTo();

      // No quote yet — returning to an empty form has nothing to refresh.
      document.dispatchEvent(new Event('visibilitychange'));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(gasSpy).not.toHaveBeenCalled();

      component.quote.set(makeQuote('1'));
      document.dispatchEvent(new Event('visibilitychange'));
      expect(fetchSpy).toHaveBeenCalledOnceWith(true);
      expect(gasSpy).toHaveBeenCalledTimes(1);

      // The event also fires when GOING hidden — that must not refetch…
      hiddenSpy.and.returnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // …and neither must a return on review (its quote is deliberately
      // frozen — the freshness chip and manual refresh own staleness there).
      hiddenSpy.and.returnValue(false);
      component.currentStep.set('review');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(gasSpy).toHaveBeenCalledTimes(1);
    });

    it('skips the 30s gas tick while the tab is hidden', () => {
      hiddenSpy.and.returnValue(true);
      // Fresh instance AFTER the mock clock is installed, so the gas interval
      // registered in the constructor is clock-driven.
      const freshFixture = TestBed.createComponent(SwapComponent);
      const fresh = freshFixture.componentInstance;
      const gasSpy = spyOn(
        fresh as unknown as { updateGasPrice(): Promise<void> },
        'updateGasPrice',
      ).and.resolveTo();

      jasmine.clock().tick(30_000);
      expect(gasSpy).not.toHaveBeenCalled();

      hiddenSpy.and.returnValue(false);
      jasmine.clock().tick(30_000);
      expect(gasSpy).toHaveBeenCalledTimes(1);
      fresh.ngOnDestroy();
    });

    it('defers the 30s auto-refresh after a RECENT edit, not on mere focus', async () => {
      spyOn(TestBed.inject(AnalyticsService), 'track');
      (mockWalletService.isConnected as unknown as jasmine.Spy).and.returnValue(true);
      component.fromToken.set(ethToken);
      component.toToken.set(usdcToken);
      component.fromAmount = '1';
      mockLifiService.getSwapQuote.and.resolveTo(makeQuote('1'));
      mockLifiService.isNativeToken.and.returnValue(true);

      await component.fetchQuote(); // success → auto-refresh armed
      expect(mockLifiService.getSwapQuote).toHaveBeenCalledTimes(1);

      // Edit moments ago (real-time clock — jasmine.clock doesn't mock
      // Date.now unless mockDate is used): the tick must skip and re-arm.
      component['lastAmountEditAt'] = Date.now();
      jasmine.clock().tick(30_000);
      expect(mockLifiService.getSwapQuote).toHaveBeenCalledTimes(1);

      // Edit aged past the 2s window: a focused-but-idle amount field no
      // longer blocks the refresh forever (the old behaviour deferred on
      // document.activeElement alone).
      component['lastAmountEditAt'] = Date.now() - 5_000;
      jasmine.clock().tick(30_000);
      expect(mockLifiService.getSwapQuote).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Stage-4 execution-UX: error retry, gas preflight, unconfirmed broadcast,
  // wallet rejection, cross-chain tracker seed
  // ---------------------------------------------------------------------------

  const makeExecQuote = (overrides: Partial<SwapQuote> = {}): SwapQuote => ({
    id: 'exec-quote',
    fromToken: { address: '0xa', symbol: 'ETH', name: 'Ethereum', decimals: 18, chainId: 1, logoURI: '' },
    toToken: { address: '0xb', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: 1, logoURI: '' },
    fromAmount: '1',
    toAmount: '2000',
    fromAmountUSD: '500',
    toAmountUSD: '500',
    gasCost: '0.001',
    gasCostUSD: '5',
    exchangeRate: '1 ETH = 2000 USDC',
    estimatedTime: 30,
    priceImpact: '0.3',
    minimumReceived: '1990',
    slippage: 0.5,
    route: [],
    createdAt: Date.now(),
    ...overrides,
  });

  describe('quote-error retry', () => {
    beforeEach(() => {
      component.fromToken.set({ address: '0xa', symbol: 'ETH', name: 'Ethereum', decimals: 18, chainId: 1, logoURI: '' });
      component.toToken.set({ address: '0xb', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: 1, logoURI: '' });
      component.fromAmount = '1';
      component.error.set('Something exploded');
    });

    it('offers and performs a retry when tokens and a valid amount exist', () => {
      expect(component.hasValidQuoteInputs()).toBeTrue();
      expect(component.quoteErrorCta()).toContain('Tap to retry');

      const fetchSpy = spyOn(component, 'fetchQuote').and.resolveTo();
      component.retryQuote();
      expect(fetchSpy).toHaveBeenCalledWith(true);
    });

    it('stays inert without a complete input set', () => {
      component.toToken.set(null);

      expect(component.hasValidQuoteInputs()).toBeFalse();
      expect(component.quoteErrorCta()).not.toContain('Tap to retry');

      const fetchSpy = spyOn(component, 'fetchQuote').and.resolveTo();
      component.retryQuote();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('replaces a multiline technical dump with calm single-line copy in the CTA', () => {
      component.error.set('first line\nsecond line ' + 'x'.repeat(200));

      const cta = component.quoteErrorCta();
      expect(cta).not.toContain('\n');
      // The raw dump never reaches the button; the calm copy already names
      // the next step, so no extra "Tap to retry" suffix is appended.
      expect(cta).not.toContain('xxxx');
      expect(cta).toContain('refresh the quote and try again');
      expect(cta).not.toContain('Tap to retry');
    });

    it('keeps the retry suffix for short human-readable errors', () => {
      component.error.set('Something exploded');
      expect(component.quoteErrorCta()).toBe('Something exploded — Tap to retry');
    });
  });

  describe('native-gas preflight gate', () => {
    it('blocks Confirm while a shortfall is detected and unblocks when it clears', () => {
      component.quote.set(makeExecQuote());
      component.simulationState.set({ status: 'success' });
      expect(component.canConfirmSwap()).toBeTrue();

      component.nativeGasShortfall.set({ nativeSymbol: 'ETH', requiredDisplay: '0.004' });
      expect(component.canConfirmSwap()).toBeFalse();

      const executeSpy = spyOn(component, 'executeSwap').and.resolveTo();
      component.handleReviewConfirm();
      expect(executeSpy).not.toHaveBeenCalled();

      component.nativeGasShortfall.set(null);
      expect(component.canConfirmSwap()).toBeTrue();
    });

    // Backend aggregator quote carrying gas UNITS — the estimate needs the
    // cached gas price (gwei) for the SAME chain to become a native cost.
    const gasUnitsAggregatorData = (estimatedGas: string): SwapQuote['_aggregatorData'] => ({
      aggregator: 'zerox',
      to_amount: '2000000000',
      approval_address: '0xspender',
      tx_request: { to: '0xrouter', data: '0x', value: '0' },
      quoted_at: Date.now(),
      estimated_gas: estimatedGas,
    });

    const runPreflight = (q: SwapQuote): Promise<void> =>
      (component as unknown as { checkNativeGasFunds(quote: SwapQuote): Promise<void> })
        .checkNativeGasFunds(q);

    it('fails OPEN when the strict balance read reports "unknown" (all RPCs down)', async () => {
      mockLifiService.isNativeToken.and.returnValue(false);
      // getTokenBalance would have returned the silent '0' here and
      // hard-blocked Confirm on pure infrastructure noise.
      mockWalletService.getNativeBalanceStrict.and.resolveTo(null);
      component.currentGasPrice.set({ chainId: 1, gwei: 20, level: 'normal', usd: '1.50' });

      await runPreflight(makeExecQuote({ _aggregatorData: gasUnitsAggregatorData('150000') }));

      expect(component.nativeGasShortfall()).toBeNull();
    });

    it('a genuine zero balance still blocks — that wallet cannot pay for gas', async () => {
      mockLifiService.isNativeToken.and.returnValue(false);
      mockWalletService.getNativeBalanceStrict.and.resolveTo('0');
      component.currentGasPrice.set({ chainId: 1, gwei: 20, level: 'normal', usd: '1.50' });

      await runPreflight(makeExecQuote({ _aggregatorData: gasUnitsAggregatorData('150000') }));

      expect(component.nativeGasShortfall()).not.toBeNull();
      expect(component.nativeGasShortfall()!.nativeSymbol).toBe('ETH');
    });

    it('never converts gas units with a gas price cached for a DIFFERENT chain', async () => {
      mockLifiService.isNativeToken.and.returnValue(false);
      mockWalletService.getNativeBalanceStrict.and.resolveTo('0');
      const q = makeExecQuote({ _aggregatorData: gasUnitsAggregatorData('150000') });

      // Polygon gwei against an Ethereum quote: with no USD fallback
      // available the preflight must fail open rather than do cross-chain
      // gwei math.
      component.currentGasPrice.set({ chainId: 137, gwei: 200, level: 'high', usd: '0.02' });
      await runPreflight(q);
      expect(component.nativeGasShortfall()).toBeNull();

      // Positive control: the SAME price tagged with the matching chain
      // makes the zero-balance shortfall detectable again.
      component.currentGasPrice.set({ chainId: 1, gwei: 200, level: 'high', usd: '0.02' });
      await runPreflight(q);
      expect(component.nativeGasShortfall()).not.toBeNull();
    });
  });

  describe('review preflight effect — dependency hygiene', () => {
    let cleanFixture: ComponentFixture<SwapComponent>;
    let cleanComponent: SwapComponent;

    beforeEach(async () => {
      // A template-free instance: fixture.detectChanges() must flush the
      // component effects without rendering the full swap page (child
      // components would drag in unmocked dependencies).
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [SwapComponent],
        providers: [
          // Same rationale as the main TestBed: AuthService needs HttpClient.
          provideHttpClient(),
          provideHttpClientTesting(),
          { provide: WalletService, useValue: mockWalletService },
          { provide: LifiService, useValue: mockLifiService },
          { provide: ToastService, useValue: mockToastService },
          { provide: SettingsService, useValue: mockSettingsService },
          { provide: BalanceRefreshService, useValue: mockBalanceRefreshService },
          { provide: TransactionTrackerService, useValue: mockTrackerService },
        ],
      });
      TestBed.overrideComponent(SwapComponent, { set: { template: '' } });
      await TestBed.compileComponents();
      cleanFixture = TestBed.createComponent(SwapComponent);
      cleanComponent = cleanFixture.componentInstance;
    });

    afterEach(() => {
      cleanComponent.ngOnDestroy();
    });

    it('a 30s gas-price tick does not re-run the review preflight (no sim re-churn, acks survive)', () => {
      const preflightSpy = spyOn(
        cleanComponent as unknown as { checkNativeGasFunds(q: SwapQuote): Promise<void> },
        'checkNativeGasFunds',
      ).and.resolveTo();
      const simulationSpy = spyOn(
        cleanComponent as unknown as { runSimulation(q: SwapQuote): Promise<void> },
        'runSimulation',
      ).and.resolveTo();

      cleanFixture.detectChanges(); // step 'swap' — preflight not engaged
      expect(preflightSpy).not.toHaveBeenCalled();

      cleanComponent.quote.set(makeExecQuote());
      cleanComponent.currentStep.set('review');
      cleanFixture.detectChanges();
      expect(preflightSpy).toHaveBeenCalledTimes(1);
      expect(simulationSpy).toHaveBeenCalledTimes(1);

      // The user ticks an ack, then the 30s gas refresh lands. Before the
      // untracked() fence this re-ran the effect: the simulation re-churned
      // to 'pending' and Confirm re-locked under the user's cursor.
      cleanComponent.acknowledgedQuoteRisk.set(true);
      cleanComponent.currentGasPrice.set({ chainId: 1, gwei: 42, level: 'high', usd: '3.10' });
      cleanFixture.detectChanges();

      expect(preflightSpy).toHaveBeenCalledTimes(1);
      expect(simulationSpy).toHaveBeenCalledTimes(1);
      expect(cleanComponent.acknowledgedQuoteRisk()).toBeTrue();

      // Sanity: a genuinely new quote still re-runs both preflights.
      cleanComponent.quote.set(makeExecQuote());
      cleanFixture.detectChanges();
      expect(preflightSpy).toHaveBeenCalledTimes(2);
      expect(simulationSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('unconfirmed broadcast (null receipt)', () => {
    it('never declares completed or marks history success without a receipt', async () => {
      const q = makeExecQuote();
      component.quote.set(q);

      const history = TestBed.inject(TransactionHistoryService);
      spyOn(history, 'createSwapTransaction').and.returnValue({ id: 'rec-1' } as unknown as TransactionRecord);
      const markSuccessSpy = spyOn(history, 'markSuccess');
      const markFailedSpy = spyOn(history, 'markFailed');

      mockLifiService.refreshQuoteBeforeExecute.and.resolveTo({
        quote: q,
        approvalAddressChanged: false,
        priceChanged: false,
        refreshed: true,
        networkError: false,
      });
      // The service emits 'confirming' (NOT 'completed') for a null receipt.
      mockLifiService.executeSwap.and.callFake(async (_quote, onStatusChange) => {
        onStatusChange?.('signing');
        onStatusChange?.('pending', '0xabc');
        onStatusChange?.('confirming', '0xabc');
        return { hash: '0xabc', explorerUrl: 'https://etherscan.io/tx/0xabc' };
      });
      // Neutralize the background re-poll: zero window = immediate give-up.
      component['receiptRepollWindowMs'] = 0;

      await component.executeSwap();

      expect(component.transactionStatus()).toBe('confirming');
      expect(component.transactionStatus()).not.toBe('completed');
      expect(component.awaitingReceiptConfirmation()).toBeTrue();
      expect(markSuccessSpy).not.toHaveBeenCalled();
      expect(markFailedSpy).not.toHaveBeenCalled();
      expect(mockToastService.success).not.toHaveBeenCalled();
      expect(mockToastService.info).toHaveBeenCalledWith(
        'Transaction sent',
        jasmine.stringContaining('keep checking'),
        jasmine.objectContaining({ url: 'https://etherscan.io/tx/0xabc' }),
      );
      // The honest waiting copy with the explorer link, not a success step.
      const state = component.trackingState()!;
      expect(state.steps[1].title).toContain('waiting for confirmation');
      expect(state.steps[1].explorerLink).toBe('https://etherscan.io/tx/0xabc');
      // The user is not held hostage while the re-poll watches.
      expect(component.canStartNewSwapWhileBridging()).toBeTrue();

      component.ngOnDestroy();
    });
  });

  describe('cross-chain unconfirmed broadcast (null source receipt)', () => {
    const usdcOnBase = { address: '0xb', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: 8453, logoURI: '' };

    it('never claims bridging without a source receipt — no bridging toast, no tracker, re-poll engaged', async () => {
      const q = makeExecQuote({ toToken: usdcOnBase, aggregator: 'lifi' });
      component.quote.set(q);

      const history = TestBed.inject(TransactionHistoryService);
      spyOn(history, 'createSwapTransaction').and.returnValue({ id: 'rec-x' } as unknown as TransactionRecord);
      const markSuccessSpy = spyOn(history, 'markSuccess');

      const repollSpy = spyOn(
        component as unknown as {
          repollCrossChainSourceReceipt(
            hash: string, quote: SwapQuote, recordId: string | undefined,
            props: Record<string, unknown>, explorerUrl: string,
          ): Promise<void>;
        },
        'repollCrossChainSourceReceipt',
      ).and.resolveTo();

      mockLifiService.refreshQuoteBeforeExecute.and.resolveTo({
        quote: q,
        approvalAddressChanged: false,
        priceChanged: false,
        refreshed: true,
        networkError: false,
      });
      // Null receipt: the execution service emits 'confirming', never
      // 'completed' — sourceConfirmed stays false.
      mockLifiService.executeSwap.and.callFake(async (_quote, onStatusChange) => {
        onStatusChange?.('signing');
        onStatusChange?.('pending', '0xsrc');
        onStatusChange?.('confirming', '0xsrc');
        return { hash: '0xsrc', explorerUrl: 'https://etherscan.io/tx/0xsrc' };
      });

      await component.executeSwap();

      // The old branch toasted 'bridging now' and seeded the tracker off a
      // receipt that never existed.
      const infoTitles = mockToastService.info.calls.allArgs().map((args) => args[0]);
      expect(infoTitles).not.toContain('Swap sent, bridging now');
      expect(mockTrackerService.trackTransaction).not.toHaveBeenCalled();
      expect(mockTrackerService.trackAggregatorBridge).not.toHaveBeenCalled();
      expect(markSuccessSpy).not.toHaveBeenCalled();

      // Honest source-wait presentation + the background re-poll engaged.
      expect(component.transactionStatus()).toBe('confirming');
      expect(component.awaitingReceiptConfirmation()).toBeTrue();
      expect(repollSpy).toHaveBeenCalledWith('0xsrc', q, 'rec-x', jasmine.anything(), 'https://etherscan.io/tx/0xsrc');
      const sourceStep = component.trackingState()!.steps.find((s) => s.id === 'source-confirm')!;
      expect(sourceStep.status).toBe('in_progress');
      expect(sourceStep.title).toContain('waiting');
      expect(mockToastService.info).toHaveBeenCalledWith(
        'Transaction sent',
        jasmine.stringContaining('source transaction'),
        jasmine.objectContaining({ url: 'https://etherscan.io/tx/0xsrc' }),
      );

      component.ngOnDestroy();
    });

    describe('source-receipt re-poll', () => {
      const runRepoll = (q: SwapQuote): Promise<void> =>
        (component as unknown as {
          repollCrossChainSourceReceipt(
            hash: string, quote: SwapQuote, recordId: string | undefined,
            props: Record<string, unknown>, explorerUrl: string,
          ): Promise<void>;
        }).repollCrossChainSourceReceipt('0xsrc', q, 'rec-y', {}, 'https://etherscan.io/tx/0xsrc');

      beforeEach(() => {
        component['receiptRepollIntervalMs'] = 1;
        component['receiptRepollWindowMs'] = 250;
        component.transactionStatus.set('confirming');
        component.awaitingReceiptConfirmation.set(true);
      });

      it('hands over to the bridge tracker only after a status-1 source receipt', async () => {
        mockTrackerService.trackTransaction.and.returnValue(
          new Promise<LifiStatusResponse | null>(() => { /* keep polling */ }),
        );
        component['fetchReceipt'] = (async () =>
          ({ status: 1 } as unknown as TransactionReceipt)) as typeof fetchReceiptWithFallback;

        await runRepoll(makeExecQuote({ toToken: usdcOnBase, aggregator: 'lifi' }));

        expect(mockToastService.info).toHaveBeenCalledWith(
          'Swap sent, bridging now',
          jasmine.stringContaining('Source tx confirmed'),
          jasmine.anything(),
        );
        expect(mockTrackerService.trackTransaction).toHaveBeenCalled();
        expect(component.transactionStatus()).toBe('confirming');
        expect(component.awaitingReceiptConfirmation()).toBeFalse();
      });

      it('finalizes failure honestly on a status-0 source receipt — the bridge never started', async () => {
        const history = TestBed.inject(TransactionHistoryService);
        const markFailedSpy = spyOn(history, 'markFailed');
        component['fetchReceipt'] = (async () =>
          ({ status: 0 } as unknown as TransactionReceipt)) as typeof fetchReceiptWithFallback;

        await runRepoll(makeExecQuote({ toToken: usdcOnBase, aggregator: 'lifi' }));

        expect(markFailedSpy).toHaveBeenCalledWith('rec-y', jasmine.any(String));
        expect(component.transactionStatus()).toBe('failed');
        expect(mockTrackerService.trackTransaction).not.toHaveBeenCalled();
        // The failure toast identifies the swap (the user may have moved on).
        expect(mockToastService.error).toHaveBeenCalledWith(
          'Swap failed',
          jasmine.stringContaining('1 ETH → 2000 USDC'),
          jasmine.anything(),
        );
      });

      it('gives up after the window without claiming bridging — confirming stays honest', async () => {
        const history = TestBed.inject(TransactionHistoryService);
        const markSuccessSpy = spyOn(history, 'markSuccess');
        const markFailedSpy = spyOn(history, 'markFailed');
        component.trackingState.set({
          progress: 40,
          currentStep: 1,
          steps: [
            { id: 'signing', title: 'Sign Transaction', status: 'completed' },
            { id: 'source-confirm', title: 'Sent — waiting', status: 'in_progress' },
          ],
          isTracking: true,
        });
        component['fetchReceipt'] = (async () => null) as typeof fetchReceiptWithFallback;

        await runRepoll(makeExecQuote({ toToken: usdcOnBase, aggregator: 'lifi' }));

        expect(markSuccessSpy).not.toHaveBeenCalled();
        expect(markFailedSpy).not.toHaveBeenCalled();
        expect(mockTrackerService.trackTransaction).not.toHaveBeenCalled();
        expect(component.transactionStatus()).toBe('confirming');
        const state = component.trackingState()!;
        expect(state.isTracking).toBeFalse();
        expect(state.error).toContain("couldn't confirm the source transaction");
      });
    });
  });

  describe('background receipt re-poll', () => {
    const setupConfirmingState = (): void => {
      component.transactionStatus.set('confirming');
      component.awaitingReceiptConfirmation.set(true);
      component.trackingState.set({
        progress: 75,
        currentStep: 1,
        steps: [
          { id: 'signing', title: 'Sign Transaction', status: 'completed' },
          { id: 'confirming', title: 'Transaction sent — waiting for confirmation', status: 'in_progress' },
        ],
        isTracking: true,
      });
    };

    beforeEach(() => {
      component['receiptRepollIntervalMs'] = 1;
      component['receiptRepollWindowMs'] = 250;
      setupConfirmingState();
    });

    it('finalizes success when a status-1 receipt eventually lands', async () => {
      const history = TestBed.inject(TransactionHistoryService);
      const markSuccessSpy = spyOn(history, 'markSuccess');

      let attempts = 0;
      component['fetchReceipt'] = (async () => {
        attempts++;
        return attempts < 3 ? null : ({ status: 1 } as unknown as TransactionReceipt);
      }) as typeof fetchReceiptWithFallback;

      await component['repollSameChainReceipt'](
        '0xabc', makeExecQuote(), 'rec-1', {}, 'https://etherscan.io/tx/0xabc',
      );

      expect(markSuccessSpy).toHaveBeenCalledWith('rec-1', '0xabc');
      expect(component.transactionStatus()).toBe('completed');
      expect(component.awaitingReceiptConfirmation()).toBeFalse();
      expect(mockToastService.success).toHaveBeenCalled();
    });

    it('finalizes failure honestly on a status-0 receipt, identifying the swap in the toast', async () => {
      const history = TestBed.inject(TransactionHistoryService);
      const markFailedSpy = spyOn(history, 'markFailed');

      component['fetchReceipt'] = (async () =>
        ({ status: 0 } as unknown as TransactionReceipt)) as typeof fetchReceiptWithFallback;

      await component['repollSameChainReceipt'](
        '0xabc', makeExecQuote(), 'rec-1', {}, 'https://etherscan.io/tx/0xabc',
      );

      expect(markFailedSpy).toHaveBeenCalled();
      expect(component.transactionStatus()).toBe('failed');
      // The user may have moved on minutes ago — the toast must say WHICH
      // swap failed (amounts + symbols), mirroring the success copy.
      expect(mockToastService.error).toHaveBeenCalledWith(
        'Swap failed',
        jasmine.stringContaining('1 ETH → 2000 USDC'),
        jasmine.objectContaining({ url: 'https://etherscan.io/tx/0xabc' }),
      );
    });

    it('gives up after the window with confirming intact and history still pending', async () => {
      const history = TestBed.inject(TransactionHistoryService);
      const markSuccessSpy = spyOn(history, 'markSuccess');
      const markFailedSpy = spyOn(history, 'markFailed');

      component['fetchReceipt'] = (async () => null) as typeof fetchReceiptWithFallback;

      await component['repollSameChainReceipt'](
        '0xabc', makeExecQuote(), 'rec-1', {}, 'https://etherscan.io/tx/0xabc',
      );

      expect(markSuccessSpy).not.toHaveBeenCalled();
      expect(markFailedSpy).not.toHaveBeenCalled();
      expect(component.transactionStatus()).toBe('confirming');
      const state = component.trackingState()!;
      expect(state.isTracking).toBeFalse();
      expect(state.error).toContain("couldn't confirm");
    });
  });

  describe('approval rejection', () => {
    it('treats a declined approval signature as a decision, not a failure', async () => {
      component.quote.set(makeExecQuote());
      component.needsApproval.set(true);
      mockLifiService.approveToken.and.rejectWith(new Error('Transaction was rejected by user'));

      await component.approveToken();

      expect(mockToastService.error).not.toHaveBeenCalled();
      expect(mockToastService.info).toHaveBeenCalledWith(
        'Approval cancelled',
        jasmine.stringContaining('No transaction was sent'),
      );
      // The approval is still required — only the red failure UI is wrong.
      expect(component.needsApproval()).toBeTrue();
      expect(component.isApproving()).toBeFalse();
    });

    it('still surfaces a real approval failure as an error', async () => {
      component.quote.set(makeExecQuote());
      mockLifiService.approveToken.and.rejectWith(new Error('execution reverted'));

      await component.approveToken();

      expect(mockToastService.error).toHaveBeenCalledWith('Approval failed', 'execution reverted');
      expect(mockToastService.info).not.toHaveBeenCalled();
    });

    it('sanitizes a technical approval failure into calm copy', async () => {
      component.quote.set(makeExecQuote());
      mockLifiService.approveToken.and.rejectWith(
        new Error('could not coalesce error (error={ "code": -32603 }, code=UNKNOWN_ERROR, version=6.13.0)'),
      );

      await component.approveToken();

      expect(mockToastService.error).toHaveBeenCalledWith(
        'Approval failed',
        jasmine.stringContaining('no token permission was granted'),
      );
    });
  });

  describe('wallet rejection during signing', () => {
    it('returns to review with a neutral toast and no failed history record', async () => {
      const q = makeExecQuote();
      component.quote.set(q);
      component.currentStep.set('review');

      const history = TestBed.inject(TransactionHistoryService);
      spyOn(history, 'createSwapTransaction').and.returnValue({ id: 'rec-1' } as unknown as TransactionRecord);
      const deleteSpy = spyOn(history, 'deleteTransaction');
      const markFailedSpy = spyOn(history, 'markFailed');

      mockLifiService.refreshQuoteBeforeExecute.and.resolveTo({
        quote: q,
        approvalAddressChanged: false,
        priceChanged: false,
        refreshed: true,
        networkError: false,
      });
      mockLifiService.executeSwap.and.rejectWith(new Error('Transaction was rejected by user'));

      await component.executeSwap();

      // A decision, not a failure: back on review, quote intact, no red screen.
      expect(component.currentStep()).toBe('review');
      expect(component.transactionStatus()).toBe('idle');
      expect(component.trackingState()).toBeNull();
      expect(component.quote()).toBe(q);
      // The pending record created before signing must not survive as 'failed'.
      expect(deleteSpy).toHaveBeenCalledWith('rec-1');
      expect(markFailedSpy).not.toHaveBeenCalled();
      expect(mockToastService.error).not.toHaveBeenCalled();
      expect(mockToastService.info).toHaveBeenCalledWith(
        'Signature cancelled',
        jasmine.stringContaining('quote stays live'),
      );

      // The rejection path restarted quote auto-refresh — clean it up.
      component.ngOnDestroy();
    });

    it('recognizes raw provider rejection phrasings too', async () => {
      const q = makeExecQuote();
      component.quote.set(q);

      const history = TestBed.inject(TransactionHistoryService);
      spyOn(history, 'createSwapTransaction').and.returnValue({ id: 'rec-2' } as unknown as TransactionRecord);
      const deleteSpy = spyOn(history, 'deleteTransaction');
      const markFailedSpy = spyOn(history, 'markFailed');

      mockLifiService.refreshQuoteBeforeExecute.and.resolveTo({
        quote: q,
        approvalAddressChanged: false,
        priceChanged: false,
        refreshed: true,
        networkError: false,
      });
      mockLifiService.executeSwap.and.rejectWith(
        new Error('MetaMask Tx Signature: User denied transaction signature.'),
      );

      await component.executeSwap();

      expect(component.currentStep()).toBe('review');
      expect(component.transactionStatus()).toBe('idle');
      expect(deleteSpy).toHaveBeenCalledWith('rec-2');
      expect(markFailedSpy).not.toHaveBeenCalled();

      component.ngOnDestroy();
    });
  });

  describe('cross-chain tracker seed', () => {
    const arbOnArbitrum = { address: '0xb', symbol: 'ARB', name: 'Arbitrum', decimals: 18, chainId: 42161, logoURI: '' };
    const startLifiTracking = (): void => {
      component['startBridgeTracking'](
        makeExecQuote({ toToken: arbOnArbitrum, aggregator: 'lifi' }), '0xabc', '', undefined, {},
      );
      fixture.detectChanges();
    };

    it('seeds the timeline forward of the execution callback — never backwards', () => {
      // By the time the hub's tracker starts, the execution callback has
      // already painted source-confirm completed + bridging in progress @60.
      mockTrackerService.trackTransaction.and.returnValue(
        new Promise<LifiStatusResponse | null>(() => { /* keep polling */ }),
      );

      startLifiTracking();

      const state = component.trackingState()!;
      expect(state.progress).toBe(60);
      expect(state.currentStep).toBe(1);
      expect(state.steps[0]).toEqual(jasmine.objectContaining({ id: 'source-confirm', status: 'completed' }));
      expect(state.steps[1]).toEqual(jasmine.objectContaining({ id: 'bridging', status: 'in_progress' }));
    });

    it('the tracker\'s initial low-progress notify cannot overwrite the seed (dead-store fix)', () => {
      mockTrackerService.trackTransaction.and.returnValue(
        new Promise<LifiStatusResponse | null>(() => { /* keep polling */ }),
      );
      component.transactionStatus.set('confirming');
      startLifiTracking();
      expect(component.trackingState()!.progress).toBe(60);

      const onUpdate = mockTrackerService.trackTransaction.calls.mostRecent().args[3];
      // trackTransaction's own INITIAL notify (progress 0) and the early
      // NOT_FOUND poll (progress 5) used to immediately overwrite the seed
      // — the backward jump the seed was built to prevent.
      onUpdate({
        progress: 0,
        currentStep: 0,
        steps: [{ id: 'source-confirm', title: 'Confirming', status: 'pending' }],
        isTracking: true,
      });
      onUpdate({
        progress: 5,
        currentStep: 0,
        steps: [{ id: 'source-confirm', title: 'Confirming', status: 'in_progress' }],
        isTracking: true,
      });
      fixture.detectChanges();

      const state = component.trackingState()!;
      expect(state.progress).toBe(60);
      expect(state.steps[0].status).toBe('completed');

      // Forward progress still flows through.
      onUpdate({
        progress: 70,
        currentStep: 2,
        steps: [
          { id: 'source-confirm', title: 'Confirmed', status: 'completed' },
          { id: 'bridging', title: 'Bridging tokens', status: 'completed' },
          { id: 'dest-confirm', title: 'Receiving', status: 'in_progress' },
        ],
        isTracking: true,
      });
      fixture.detectChanges();
      expect(component.trackingState()!.progress).toBe(70);
    });

    it('a FAILED update always passes the regression guard, whatever its progress says', () => {
      mockTrackerService.trackTransaction.and.returnValue(
        new Promise<LifiStatusResponse | null>(() => { /* keep polling */ }),
      );
      component.transactionStatus.set('confirming');
      startLifiTracking();

      const onUpdate = mockTrackerService.trackTransaction.calls.mostRecent().args[3];
      onUpdate({
        progress: 20,
        currentStep: 1,
        steps: [
          { id: 'source-confirm', title: 'Confirmed', status: 'completed' },
          { id: 'bridging', title: 'Bridging tokens', status: 'failed' },
        ],
        isTracking: false,
        error: 'Bridge failed',
      });
      fixture.detectChanges();

      const state = component.trackingState()!;
      expect(state.error).toBe('Bridge failed');
      expect(state.steps[1].status).toBe('failed');
    });
  });
});

describe('sanitizeAmountInput', () => {
  it('reads a single comma as the decimal mark (paste path)', () => {
    expect(sanitizeAmountInput('1,5')).toBe('1.5');
    expect(sanitizeAmountInput('0,005')).toBe('0.005');
  });

  it('keeps plain dot input untouched', () => {
    expect(sanitizeAmountInput('1.5')).toBe('1.5');
    expect(sanitizeAmountInput('0.000001')).toBe('0.000001');
    expect(sanitizeAmountInput('100')).toBe('100');
  });

  it('treats the rightmost separator as decimal when both appear', () => {
    expect(sanitizeAmountInput('1,000.5')).toBe('1000.5');
    expect(sanitizeAmountInput('1.000,5')).toBe('1000.5');
  });

  it('reads repeated commas as thousands separators', () => {
    expect(sanitizeAmountInput('1,000,000')).toBe('1000000');
    expect(sanitizeAmountInput('1,2,3')).toBe('123');
  });

  it('never lets a second dot survive', () => {
    expect(sanitizeAmountInput('1.2.3')).toBe('1.23');
    expect(sanitizeAmountInput('..5')).toBe('.5');
  });

  it('strips everything that is not a digit or separator', () => {
    expect(sanitizeAmountInput('1 000,5')).toBe('1000.5');
    expect(sanitizeAmountInput('abc')).toBe('');
    expect(sanitizeAmountInput('$1.5e3')).toBe('1.53');
  });
});

describe('isAmbiguousGroupedAmount', () => {
  it('flags strictly grouped, dot-free pastes', () => {
    expect(isAmbiguousGroupedAmount('1,000')).toBeTrue();
    expect(isAmbiguousGroupedAmount('1,500')).toBeTrue();
    expect(isAmbiguousGroupedAmount('12,345')).toBeTrue();
    expect(isAmbiguousGroupedAmount('1,000,000')).toBeTrue();
    expect(isAmbiguousGroupedAmount(' 1,000 ')).toBeTrue();
  });

  it('passes everything the sanitizer handles unambiguously', () => {
    expect(isAmbiguousGroupedAmount('1,5')).toBeFalse();      // EU decimal
    expect(isAmbiguousGroupedAmount('1,000.5')).toBeFalse();  // dot disambiguates
    expect(isAmbiguousGroupedAmount('1.000,5')).toBeFalse();
    expect(isAmbiguousGroupedAmount('1000')).toBeFalse();
    expect(isAmbiguousGroupedAmount('1,2,3')).toBeFalse();    // not 3-digit groups
    expect(isAmbiguousGroupedAmount('')).toBeFalse();
  });
});

describe('amountsNumericallyEqual', () => {
  it('ignores trailing zeros and formatting differences', () => {
    expect(amountsNumericallyEqual('5', '5.000')).toBeTrue();
    expect(amountsNumericallyEqual('1.0', '1')).toBeTrue();
    expect(amountsNumericallyEqual('05', '5')).toBeTrue();
  });

  it('absorbs wei-level truncation of an echoed amount', () => {
    expect(amountsNumericallyEqual('1.0000000000000000001', '1')).toBeTrue();
  });

  it('flags genuinely different amounts', () => {
    expect(amountsNumericallyEqual('5', '1')).toBeFalse();
    expect(amountsNumericallyEqual('1.5', '15')).toBeFalse();
    expect(amountsNumericallyEqual('0.001', '0.0011')).toBeFalse();
  });

  it('never equates unparseable input', () => {
    expect(amountsNumericallyEqual('', '5')).toBeFalse();
    expect(amountsNumericallyEqual('abc', 'abc')).toBeFalse();
    expect(amountsNumericallyEqual('', '')).toBeFalse();
  });
});

describe('percentOfRawBalance', () => {
  it('MAX yields a string at or below the real balance, parseUnits-safe', () => {
    const raw = parseUnits('1.999999995', 18);
    const amount = percentOfRawBalance(raw, 18, 100, 8);

    expect(amount).toBe('1.99999999');
    // The old float path rounded this to '2.00000000' — above the balance.
    expect(parseUnits(amount, 18) <= raw).toBeTrue();
    expect(() => parseUnits(amount, 18)).not.toThrow();
  });

  it('partial percents truncate, never round', () => {
    const raw = parseUnits('1.000000015', 18);
    // Exact half is 0.5000000075 — toFixed(8) would round to 0.50000001.
    expect(percentOfRawBalance(raw, 18, 50, 8)).toBe('0.50000000');
  });

  it('keeps full precision for low-decimal tokens', () => {
    const raw = parseUnits('100.123456', 6);
    expect(percentOfRawBalance(raw, 6, 100, 6)).toBe('100.123456');
    expect(percentOfRawBalance(raw, 6, 25, 6)).toBe('25.030864');
  });

  it('returns "0" for an empty portion and clamps out-of-range percents', () => {
    expect(percentOfRawBalance(0n, 18, 100, 8)).toBe('0');
    expect(percentOfRawBalance(parseUnits('1', 18), 18, 0, 8)).toBe('0');
    expect(percentOfRawBalance(parseUnits('1', 18), 18, 250, 8)).toBe('1.0');
    expect(percentOfRawBalance(parseUnits('1', 18), 18, -5, 8)).toBe('0');
  });
});

describe('computeQuoteWorsening', () => {
  it('returns a positive fraction when the new amount is worse', () => {
    expect(computeQuoteWorsening('2000', '1980')).toBeCloseTo(0.01, 10);
  });

  it('returns a negative fraction when the price improved', () => {
    expect(computeQuoteWorsening('2000', '2020')).toBeCloseTo(-0.01, 10);
  });

  it('returns 0 for equal amounts', () => {
    expect(computeQuoteWorsening('123.456', '123.456')).toBe(0);
  });

  it('fails open (returns 0) on garbage or non-positive input', () => {
    expect(computeQuoteWorsening('not-a-number', '100')).toBe(0);
    expect(computeQuoteWorsening('100', 'not-a-number')).toBe(0);
    expect(computeQuoteWorsening('', '')).toBe(0);
    expect(computeQuoteWorsening('0', '100')).toBe(0);
    expect(computeQuoteWorsening('-5', '100')).toBe(0);
  });

  it('brackets the execution threshold', () => {
    // A 1% drop must trip the 0.5% gate; a 0.2% drop must not.
    expect(computeQuoteWorsening('1000', '990')).toBeGreaterThan(REQUOTE_MAX_WORSENING);
    expect(computeQuoteWorsening('1000', '998')).toBeLessThan(REQUOTE_MAX_WORSENING);
  });
});

describe('assessQuoteRisk', () => {
  // A benign baseline: known small impact, known USD, normal size.
  const base = {
    priceImpact: 1 as number | null,
    fromAmountUSD: 100 as number | null,
    fromAmount: 1,
    highValueThreshold: 1000
  };

  it('passes a benign quote with no flags', () => {
    expect(assessQuoteRisk(base)).toEqual({
      hardBlock: false,
      needsAck: false,
      reasons: [],
      highValue: false
    });
  });

  it('requires an ack at exactly 5% impact (boundary inclusive)', () => {
    const risk = assessQuoteRisk({ ...base, priceImpact: 5 });
    expect(risk.hardBlock).toBeFalse();
    expect(risk.needsAck).toBeTrue();
    expect(risk.reasons).toEqual([RISK_REASON_HIGH_IMPACT]);
  });

  it('does not flag impact just below 5%', () => {
    const risk = assessQuoteRisk({ ...base, priceImpact: 4.99 });
    expect(risk.needsAck).toBeFalse();
    expect(risk.reasons).toEqual([]);
  });

  it('hard-blocks at exactly 15% impact (boundary inclusive)', () => {
    const risk = assessQuoteRisk({ ...base, priceImpact: 15 });
    expect(risk.hardBlock).toBeTrue();
    // A hard block is not ack-able — the checkbox must not appear.
    expect(risk.needsAck).toBeFalse();
    expect(risk.reasons).toEqual([RISK_REASON_EXTREME_IMPACT]);
  });

  it('keeps 14.99% impact ack-able, not blocked', () => {
    const risk = assessQuoteRisk({ ...base, priceImpact: 14.99 });
    expect(risk.hardBlock).toBeFalse();
    expect(risk.needsAck).toBeTrue();
    expect(risk.reasons).toEqual([RISK_REASON_HIGH_IMPACT]);
  });

  it('requires an ack when the impact is unknown', () => {
    const risk = assessQuoteRisk({ ...base, priceImpact: null });
    expect(risk.hardBlock).toBeFalse();
    expect(risk.needsAck).toBeTrue();
    expect(risk.reasons).toEqual([RISK_REASON_IMPACT_UNKNOWN]);
  });

  it('requires an ack when the USD value is unknown and an amount is entered', () => {
    const risk = assessQuoteRisk({ ...base, fromAmountUSD: null });
    expect(risk.needsAck).toBeTrue();
    expect(risk.reasons).toEqual([RISK_REASON_USD_UNKNOWN]);
  });

  it('does not flag unknown USD when no amount is entered', () => {
    const risk = assessQuoteRisk({ ...base, fromAmountUSD: null, fromAmount: 0 });
    expect(risk.needsAck).toBeFalse();
    expect(risk.reasons).toEqual([]);
  });

  it('combines unknown impact and unknown USD into one ack with both reasons', () => {
    const risk = assessQuoteRisk({ ...base, priceImpact: null, fromAmountUSD: null });
    expect(risk.hardBlock).toBeFalse();
    expect(risk.needsAck).toBeTrue();
    expect(risk.reasons).toEqual([RISK_REASON_IMPACT_UNKNOWN, RISK_REASON_USD_UNKNOWN]);
  });

  it('still lists the USD reason alongside an extreme-impact hard block', () => {
    const risk = assessQuoteRisk({ ...base, priceImpact: 20, fromAmountUSD: null });
    expect(risk.hardBlock).toBeTrue();
    expect(risk.needsAck).toBeFalse();
    expect(risk.reasons).toEqual([RISK_REASON_EXTREME_IMPACT, RISK_REASON_USD_UNKNOWN]);
  });

  it('flags high value at exactly the $1000 threshold (boundary inclusive)', () => {
    expect(assessQuoteRisk({ ...base, fromAmountUSD: 1000 }).highValue).toBeTrue();
    expect(assessQuoteRisk({ ...base, fromAmountUSD: 999.99 }).highValue).toBeFalse();
  });

  it('never marks an unknown USD value as high value', () => {
    const risk = assessQuoteRisk({ ...base, fromAmountUSD: null });
    expect(risk.highValue).toBeFalse();
    // …but the unknown-USD ack covers the gap instead.
    expect(risk.reasons).toContain(RISK_REASON_USD_UNKNOWN);
  });
});

describe('gasCostLabel', () => {
  it('uses the mainnet scale on chain 1 (boundaries inclusive upward)', () => {
    expect(gasCostLabel(2.99, 1)).toBe('Cheap');
    expect(gasCostLabel(3, 1)).toBe('Medium');
    expect(gasCostLabel(7.99, 1)).toBe('Medium');
    expect(gasCostLabel(8, 1)).toBe('High');
    expect(gasCostLabel(14.99, 1)).toBe('High');
    expect(gasCostLabel(15, 1)).toBe('Very High');
  });

  it('keeps the tight L2/Polygon scale elsewhere', () => {
    for (const chainId of [8453, 42161, 10, 137]) {
      expect(gasCostLabel(0.99, chainId)).toBe('Cheap');
      expect(gasCostLabel(1, chainId)).toBe('Medium');
      expect(gasCostLabel(1.5, chainId)).toBe('High');
      expect(gasCostLabel(2, chainId)).toBe('Very High');
    }
  });

  it('returns Normal for an unparseable cost instead of a false alarm', () => {
    expect(gasCostLabel(NaN, 1)).toBe('Normal');
  });
});

describe('isUserRejectionError', () => {
  it('recognizes the normalized service message and raw wallet phrasings', () => {
    expect(isUserRejectionError('Transaction was rejected by user')).toBeTrue();
    expect(isUserRejectionError('MetaMask Tx Signature: User denied transaction signature.')).toBeTrue();
    expect(isUserRejectionError('User rejected the request.')).toBeTrue();
  });

  it('never classifies real failures as rejection', () => {
    expect(isUserRejectionError('insufficient funds for gas * price + value')).toBeFalse();
    expect(isUserRejectionError("Couldn't complete on the network")).toBeFalse();
    expect(isUserRejectionError('Quote expired. Please refresh and try again.')).toBeFalse();
    expect(isUserRejectionError('')).toBeFalse();
  });
});

// `truncateErrorForCta` / `presentError` specs moved with the functions to
// core/utils/error-presenter.spec.ts.

describe('estimateNativeGasCost', () => {
  const baseQuote: SwapQuote = {
    id: 'gas-quote',
    fromToken: { address: '0xa', symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId: 1, logoURI: '' },
    toToken: { address: '0xb', symbol: 'DAI', name: 'Dai', decimals: 18, chainId: 1, logoURI: '' },
    fromAmount: '100',
    toAmount: '100',
    fromAmountUSD: '100',
    toAmountUSD: '100',
    gasCost: '0.001',
    gasCostUSD: '0',
    exchangeRate: '1 USDC = 1 DAI',
    estimatedTime: 30,
    priceImpact: '0.1',
    minimumReceived: '99.5',
    slippage: 0.5,
    route: [],
  };

  it('prefers the exact LI.FI wei estimate', () => {
    const q: SwapQuote = {
      ...baseQuote,
      _lifiRoute: { estimate: { gasCosts: [{ amount: '2000000000000000', amountUSD: '5', token: null }] } },
    };
    expect(estimateNativeGasCost(q, null, null)).toBeCloseTo(0.002, 12);
  });

  it('converts backend gas UNITS with the live gwei price', () => {
    const q: SwapQuote = {
      ...baseQuote,
      _aggregatorData: { estimated_gas: '200000' } as SwapQuote['_aggregatorData'],
    };
    // 200_000 units * 10 gwei = 0.002 native
    expect(estimateNativeGasCost(q, 10, null)).toBeCloseTo(0.002, 12);
    // No gas price → this source is unusable, and nothing else is available.
    expect(estimateNativeGasCost(q, null, null)).toBeNull();
  });

  it('falls back to USD over the native price as the last resort', () => {
    const q: SwapQuote = { ...baseQuote, gasCostUSD: '5' };
    expect(estimateNativeGasCost(q, null, 2500)).toBeCloseTo(0.002, 12);
  });

  it('returns null (preflight fails open) when nothing can be derived', () => {
    expect(estimateNativeGasCost(baseQuote, null, null)).toBeNull();
  });
});
