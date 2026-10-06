import { TestBed } from '@angular/core/testing';
import { signal, WritableSignal } from '@angular/core';
import { ActiveSwapHubService, isSwapSettled } from './active-swap-hub.service';
import {
  TransactionTrackerService,
  PARTIAL_SUCCESS_REASON,
} from './transaction-tracker.service';
import type { AggregatorBridgeOutcome } from './transaction-tracker.service';
import { TransactionHistoryService } from '../transaction-history.service';
import { ToastService } from '../toast.service';
import { AnalyticsService } from '../analytics.service';
import { AuthService } from '../auth.service';
import type { LifiStatusResponse, SwapQuote, TransactionTrackingState } from '../../models/swap.model';

describe('ActiveSwapHubService', () => {
  let hub: ActiveSwapHubService;
  let mockTracker: jasmine.SpyObj<TransactionTrackerService>;
  let mockToast: jasmine.SpyObj<ToastService>;
  let isAuthenticated: WritableSignal<boolean>;

  /** Lets a mocked tracker's .then() outcome handler run. */
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

  const baseQuote = (): SwapQuote => ({
    id: 'hub-quote',
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
  });

  const makeLifiQuote = (): SwapQuote => ({ ...baseQuote(), aggregator: 'lifi' });

  const makeSquidQuote = (): SwapQuote => ({
    ...baseQuote(),
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

  const start = (quote: SwapQuote, historyRecordId?: string): void => {
    hub.startCrossChainTracking({
      quote,
      txHash: '0xsrchash',
      explorerUrl: 'https://etherscan.io/tx/0xsrchash',
      historyRecordId,
      analyticsProps: { from_chain: 1, to_chain: 8453, cross_chain: true },
    });
  };

  beforeEach(() => {
    mockTracker = jasmine.createSpyObj('TransactionTrackerService', [
      'trackTransaction',
      'trackAggregatorBridge',
    ]);
    mockToast = jasmine.createSpyObj('ToastService', ['success', 'error', 'warning', 'info']);
    isAuthenticated = signal(true);

    TestBed.configureTestingModule({
      providers: [
        { provide: TransactionTrackerService, useValue: mockTracker },
        { provide: ToastService, useValue: mockToast },
        { provide: AuthService, useValue: { isAuthenticated } },
      ],
    });
    hub = TestBed.inject(ActiveSwapHubService);
  });

  it('registers the swap and seeds the bridging timeline for a LI.FI route', () => {
    mockTracker.trackTransaction.and.returnValue(new Promise<never>(() => {}));

    start(makeLifiQuote());

    const summary = hub.activeSwap()!;
    expect(summary.phase).toBe('bridging');
    expect(summary.txHash).toBe('0xsrchash');
    expect(summary.fromSymbol).toBe('ETH');
    expect(summary.toSymbol).toBe('USDC');
    expect(summary.fromAmount).toBe('1');
    expect(summary.toAmount).toBe('2000');

    // Seed forward of the execution callback's paint — never backwards.
    const state = hub.trackingState()!;
    expect(state.progress).toBe(60);
    expect(state.steps[0]).toEqual(jasmine.objectContaining({ id: 'source-confirm', status: 'completed' }));
    expect(state.steps[1]).toEqual(jasmine.objectContaining({ id: 'bridging', status: 'in_progress' }));

    expect(hub.activeQuote()).not.toBeNull();
  });

  it('tracking is hub-owned: the abort signal is not tied to any component and progress lands with no UI attached', () => {
    mockTracker.trackTransaction.and.returnValue(new Promise<never>(() => {}));
    start(makeLifiQuote());

    const abortSignal = mockTracker.trackTransaction.calls.mostRecent().args[7]!;
    expect(abortSignal.aborted).toBeFalse();

    // No component alive — a progress notify still updates hub state.
    const onUpdate = mockTracker.trackTransaction.calls.mostRecent().args[3];
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
    expect(hub.trackingState()!.progress).toBe(70);
    expect(abortSignal.aborted).toBeFalse();
  });

  it('drops regressed non-terminal repaints behind the seed (LI.FI initial notify)', () => {
    mockTracker.trackTransaction.and.returnValue(new Promise<never>(() => {}));
    start(makeLifiQuote());

    const onUpdate = mockTracker.trackTransaction.calls.mostRecent().args[3];
    onUpdate({ progress: 0, currentStep: 0, steps: [], isTracking: true });
    onUpdate({ progress: 5, currentStep: 0, steps: [], isTracking: true });
    expect(hub.trackingState()!.progress).toBe(60);

    // A FAILED repaint always passes, whatever its progress says.
    onUpdate({
      progress: 20,
      currentStep: 1,
      steps: [{ id: 'bridging', title: 'Bridging tokens', status: 'failed' }],
      isTracking: false,
      error: 'Bridge failed',
    });
    expect(hub.trackingState()!.error).toBe('Bridge failed');
  });

  it('LI.FI DONE: history success + phase success + toast + analytics', async () => {
    const history = TestBed.inject(TransactionHistoryService);
    const markSuccessSpy = spyOn(history, 'markSuccess');
    const analyticsSpy = spyOn(TestBed.inject(AnalyticsService), 'track');
    mockTracker.trackTransaction.and.resolveTo({ transactionId: 't1', status: 'DONE' } as LifiStatusResponse);

    start(makeLifiQuote(), 'record-1');
    await flush();

    expect(hub.activeSwap()!.phase).toBe('success');
    expect(markSuccessSpy).toHaveBeenCalledWith('record-1', '0xsrchash');
    expect(analyticsSpy).toHaveBeenCalledWith('swap_completed', jasmine.objectContaining({ cross_chain: true }));
    expect(mockToast.success).toHaveBeenCalled();
  });

  it('LI.FI DONE: the status API explorer link is host-checked before it becomes a toast action', async () => {
    // lifiExplorerLink is as upstream-controlled as the dispatcher's
    // tracking_url — an arbitrary https host must not ride into the toast.
    mockTracker.trackTransaction.and.resolveTo({
      transactionId: 't1',
      status: 'DONE',
      lifiExplorerLink: 'https://scan.li.fi.evil.com/tx/0x1',
    } as LifiStatusResponse);

    start(makeLifiQuote());
    await flush();

    expect(mockToast.success.calls.mostRecent().args[2]).toBeUndefined();

    mockToast.success.calls.reset();
    mockTracker.trackTransaction.and.resolveTo({
      transactionId: 't2',
      status: 'DONE',
      lifiExplorerLink: 'https://scan.li.fi/tx/0x1',
    } as LifiStatusResponse);

    start(makeLifiQuote());
    await flush();

    expect(mockToast.success.calls.mostRecent().args[2]).toEqual({
      text: 'View on LI.FI',
      url: 'https://scan.li.fi/tx/0x1',
    });
  });

  it('LI.FI FAILED: history failed with the raw reason, phase failed with calm copy', async () => {
    const history = TestBed.inject(TransactionHistoryService);
    const markFailedSpy = spyOn(history, 'markFailed');
    mockTracker.trackTransaction.and.resolveTo({
      transactionId: 't1',
      status: 'FAILED',
      substatusMessage: 'Slippage exceeded',
    } as LifiStatusResponse);

    start(makeLifiQuote(), 'record-2');
    await flush();

    const summary = hub.activeSwap()!;
    expect(summary.phase).toBe('failed');
    expect(summary.errorMessage).toBeTruthy();
    expect(markFailedSpy).toHaveBeenCalledWith('record-2', 'Slippage exceeded');
    expect(mockToast.error).toHaveBeenCalled();
  });

  it('LI.FI null resolution: genuine timeout warns and flips phase to timeout, history untouched', async () => {
    const history = TestBed.inject(TransactionHistoryService);
    const updateSpy = spyOn(history, 'updateTransaction');
    mockTracker.trackTransaction.and.resolveTo(null);

    start(makeLifiQuote(), 'record-t');
    await flush();

    expect(hub.activeSwap()!.phase).toBe('timeout');
    expect(mockToast.warning).toHaveBeenCalledWith(
      'Bridge tracking timed out',
      jasmine.stringContaining('1 ETH → 2000 USDC'),
    );
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('dispatches a squid quote to the aggregator loop with its tracking ids', () => {
    mockTracker.trackAggregatorBridge.and.returnValue(new Promise<never>(() => {}));

    start(makeSquidQuote());

    expect(mockTracker.trackTransaction).not.toHaveBeenCalled();
    const [params] = mockTracker.trackAggregatorBridge.calls.mostRecent().args;
    expect(params).toEqual({
      aggregator: 'squid',
      txHash: '0xsrchash',
      fromChain: 1,
      toChain: 8453,
      quoteId: 'qid-1',
      requestId: 'rid-1',
    });
  });

  it('aggregator success: phase success + tracker link + history + toast', async () => {
    const history = TestBed.inject(TransactionHistoryService);
    const markSuccessSpy = spyOn(history, 'markSuccess');
    mockTracker.trackAggregatorBridge.and.resolveTo({
      kind: 'success',
      response: {
        aggregator: 'squid',
        status: 'success',
        substatus: 'DESTINATION_EXECUTED',
        tracking_url: 'https://axelarscan.io/gmp/0xsrchash',
        is_final: true,
      },
    });

    start(makeSquidQuote(), 'record-1');
    await flush();

    const summary = hub.activeSwap()!;
    expect(summary.phase).toBe('success');
    expect(summary.trackingUrl).toBe('https://axelarscan.io/gmp/0xsrchash');
    expect(markSuccessSpy).toHaveBeenCalledWith('record-1', '0xsrchash');
    expect(mockToast.success).toHaveBeenCalled();
  });

  describe('dispatcher tracking_url is sanitized before it becomes a link', () => {
    /** Resolve the aggregator loop with a success carrying `url` as tracking_url. */
    const succeedWithTrackingUrl = async (url: string): Promise<void> => {
      mockTracker.trackAggregatorBridge.and.resolveTo({
        kind: 'success',
        response: {
          aggregator: 'squid',
          status: 'success',
          substatus: 'DESTINATION_EXECUTED',
          tracking_url: url,
          is_final: true,
        },
      });
      start(makeSquidQuote(), 'record-hostile');
      await flush();
    };

    /** The toast's optional action argument (3rd), whatever the call shape. */
    const successToastAction = (): { text: string; url: string } | undefined =>
      mockToast.success.calls.mostRecent().args[2] as { text: string; url: string } | undefined;

    it('drops a lookalike host (axelarscan.io.evil.com) — no summary link, no toast action', async () => {
      // A compromised / MITM'd backend answers with a perfectly valid https
      // URL on a host that merely READS like the tracker. Rendering it as an
      // in-app "View transfer" link launders a phishing page through our own
      // trust surface.
      await succeedWithTrackingUrl('https://axelarscan.io.evil.com/x');

      expect(hub.activeSwap()!.phase).toBe('success');
      expect(hub.activeSwap()!.trackingUrl ?? null).toBeNull();
      expect(successToastAction()).toBeUndefined();
    });

    it('drops a javascript: URL — never a broken or unsanitized href', async () => {
      // eslint-disable-next-line no-script-url
      await succeedWithTrackingUrl('javascript:alert(1)');

      expect(hub.activeSwap()!.trackingUrl ?? null).toBeNull();
      expect(successToastAction()).toBeUndefined();
    });

    it('still surfaces a genuine allowlisted tracker link', async () => {
      await succeedWithTrackingUrl('https://axelarscan.io/gmp/0xsrchash');

      expect(hub.activeSwap()!.trackingUrl).toBe('https://axelarscan.io/gmp/0xsrchash');
      expect(successToastAction()).toEqual({
        text: 'View transfer',
        url: 'https://axelarscan.io/gmp/0xsrchash',
      });
    });
  });

  it('aggregator partial: phase partial with the explanation + history failed', async () => {
    const history = TestBed.inject(TransactionHistoryService);
    const markFailedSpy = spyOn(history, 'markFailed');
    mockTracker.trackAggregatorBridge.and.resolveTo({
      kind: 'partial',
      response: { aggregator: 'squid', status: 'partial_success', substatus: 'PARTIAL_SUCCESS', is_final: true },
      reason: PARTIAL_SUCCESS_REASON,
    });

    start(makeSquidQuote(), 'record-2');
    await flush();

    const summary = hub.activeSwap()!;
    expect(summary.phase).toBe('partial');
    expect(summary.errorMessage).toBe(PARTIAL_SUCCESS_REASON);
    expect(markFailedSpy).toHaveBeenCalledWith('record-2', PARTIAL_SUCCESS_REASON);
    expect(mockToast.error).toHaveBeenCalled();
  });

  it('unsupported: honest untracked presentation with the Axelarscan fallback and a pending bridging step', async () => {
    mockTracker.trackAggregatorBridge.and.resolveTo({ kind: 'unsupported' });

    start(makeSquidQuote());
    await flush();

    const summary = hub.activeSwap()!;
    expect(summary.phase).toBe('untracked');
    expect(summary.trackingUrl).toBe('https://axelarscan.io/gmp/0xsrchash');
    const state = hub.trackingState()!;
    const bridging = state.steps.find((s) => s.id === 'bridging')!;
    expect(bridging.description).toContain("isn't tracked for this route yet");
    // 'pending', not an eternal in-progress spinner (nothing is watching).
    expect(bridging.status).toBe('pending');
    expect(state.isTracking).toBeFalse();
    expect(mockToast.info).toHaveBeenCalledWith(
      'Bridge in progress',
      jasmine.stringContaining('5–30 minutes'),
      jasmine.anything(),
    );
  });

  it('gave_up mid-refund: annotates the record (status stays pending) and falls back untracked', async () => {
    const history = TestBed.inject(TransactionHistoryService);
    const updateSpy = spyOn(history, 'updateTransaction');
    mockTracker.trackAggregatorBridge.and.resolveTo({
      kind: 'gave_up',
      lastObservedStatus: 'refunding',
    });

    start(makeSquidQuote(), 'record-r');
    await flush();

    expect(hub.activeSwap()!.phase).toBe('untracked');
    expect(updateSpy).toHaveBeenCalledWith('record-r', jasmine.objectContaining({
      bridgeAnnotation: 'refunding',
      errorMessage: jasmine.stringContaining('refund'),
    }));
    const updates = updateSpy.calls.mostRecent().args[1];
    expect('status' in updates).toBeFalse();
  });

  it('timeout while needs_gas: annotation + phase timeout + warning toast', async () => {
    const history = TestBed.inject(TransactionHistoryService);
    const updateSpy = spyOn(history, 'updateTransaction');
    mockTracker.trackAggregatorBridge.and.resolveTo({
      kind: 'timeout',
      lastObservedStatus: 'needs_gas',
    });

    start(makeSquidQuote(), 'record-g');
    await flush();

    expect(hub.activeSwap()!.phase).toBe('timeout');
    expect(updateSpy).toHaveBeenCalledWith('record-g', jasmine.objectContaining({
      bridgeAnnotation: 'needs_gas',
    }));
    expect(mockToast.warning).toHaveBeenCalled();
  });

  it('a route with no tracking data at all gets the untracked presentation immediately', () => {
    start({ ...baseQuote(), aggregator: 'zerox' });

    const summary = hub.activeSwap()!;
    expect(summary.phase).toBe('untracked');
    // Non-Squid untrackable routes get no Axelarscan link — explicitly null.
    expect(summary.trackingUrl).toBeNull();
    expect(mockTracker.trackTransaction).not.toHaveBeenCalled();
    expect(mockTracker.trackAggregatorBridge).not.toHaveBeenCalled();
  });

  it('a new swap replaces the active one: old loop aborted, its late outcome cannot repaint hub state', async () => {
    let resolveFirst!: (outcome: AggregatorBridgeOutcome) => void;
    mockTracker.trackAggregatorBridge.and.returnValue(
      new Promise<AggregatorBridgeOutcome>((resolve) => { resolveFirst = resolve; }),
    );
    start(makeSquidQuote(), 'record-old');
    const firstAbort = mockTracker.trackAggregatorBridge.calls.mostRecent().args[4]!;

    mockTracker.trackTransaction.and.returnValue(new Promise<never>(() => {}));
    hub.startCrossChainTracking({
      quote: makeLifiQuote(),
      txHash: '0xnewhash',
      explorerUrl: 'https://etherscan.io/tx/0xnewhash',
    });

    expect(firstAbort.aborted).toBeTrue();
    expect(hub.activeSwap()!.txHash).toBe('0xnewhash');

    // The replaced loop resolves 'aborted' — fully silent by contract.
    resolveFirst({ kind: 'aborted' });
    await flush();
    expect(hub.activeSwap()!.txHash).toBe('0xnewhash');
    expect(hub.activeSwap()!.phase).toBe('bridging');
    expect(mockToast.error).not.toHaveBeenCalled();
    expect(mockToast.warning).not.toHaveBeenCalled();
  });

  it('dismiss() clears a settled swap but never a live one', async () => {
    mockTracker.trackAggregatorBridge.and.resolveTo({ kind: 'unsupported' });
    start(makeSquidQuote());

    // Live (bridging) — dismiss is a no-op; the loop is never killed here.
    expect(hub.activeSwap()!.phase).toBe('bridging');
    hub.dismiss();
    expect(hub.activeSwap()).not.toBeNull();

    await flush();
    expect(hub.activeSwap()!.phase).toBe('untracked');
    hub.dismiss();
    expect(hub.activeSwap()).toBeNull();
    expect(hub.trackingState()).toBeNull();
    expect(hub.activeQuote()).toBeNull();
  });

  it('logout aborts the live loop and clears the hub', () => {
    mockTracker.trackTransaction.and.returnValue(new Promise<never>(() => {}));
    start(makeLifiQuote());
    const abortSignal = mockTracker.trackTransaction.calls.mostRecent().args[7]!;

    isAuthenticated.set(false);
    TestBed.flushEffects();

    expect(abortSignal.aborted).toBeTrue();
    expect(hub.activeSwap()).toBeNull();
    expect(hub.trackingState()).toBeNull();
  });

  it('a DONE verdict racing a logout abort is fully silent — no history write, no toast', async () => {
    const history = TestBed.inject(TransactionHistoryService);
    const markSuccessSpy = spyOn(history, 'markSuccess');
    const analyticsSpy = spyOn(TestBed.inject(AnalyticsService), 'track');
    let resolveTracking!: (value: LifiStatusResponse | null) => void;
    mockTracker.trackTransaction.and.returnValue(
      new Promise<LifiStatusResponse | null>((resolve) => { resolveTracking = resolve; }),
    );

    start(makeLifiQuote(), 'record-race');
    isAuthenticated.set(false);
    TestBed.flushEffects();

    // The loop was aborted mid-flight, but LI.FI already had the DONE
    // response on the wire — the late verdict must not write history, toast
    // or track analytics for a session that no longer exists.
    resolveTracking({ transactionId: 't1', status: 'DONE' } as LifiStatusResponse);
    await flush();

    expect(markSuccessSpy).not.toHaveBeenCalled();
    expect(analyticsSpy).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(hub.activeSwap()).toBeNull();
  });

  it('isSwapSettled: live phases are not settled, everything else is', () => {
    expect(isSwapSettled('bridging')).toBeFalse();
    expect(isSwapSettled('confirming')).toBeFalse();
    expect(isSwapSettled('untracked')).toBeTrue();
    expect(isSwapSettled('timeout')).toBeTrue();
    expect(isSwapSettled('success')).toBeTrue();
    expect(isSwapSettled('partial')).toBeTrue();
    expect(isSwapSettled('failed')).toBeTrue();
  });
});
