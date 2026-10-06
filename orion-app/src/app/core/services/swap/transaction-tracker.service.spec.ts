import { TestBed } from '@angular/core/testing';
import {
  TransactionTrackerService,
  PARTIAL_SUCCESS_REASON,
  AGGREGATOR_BRIDGING_PROGRESS,
  AggregatorBridgeOutcome,
  sanitizeHttpsUrl,
} from './transaction-tracker.service';
import { AggregatorService, SwapStatusResult } from './aggregator.service';
import { ChainService } from './chain.service';
import { AuthService } from '../auth.service';
import type {
  LifiStatusResponse,
  SwapBridgeStatus,
  SwapStatusResponse,
  TransactionTrackingState,
} from '../../models/swap.model';

describe('TransactionTrackerService — trackAggregatorBridge', () => {
  let service: TransactionTrackerService;
  let mockAggregatorService: jasmine.SpyObj<AggregatorService>;
  let updates: TransactionTrackingState[];

  const AXELARSCAN_URL = 'https://axelarscan.io/gmp/0xsrc';

  const ok = (overrides: Partial<SwapStatusResponse> = {}): SwapStatusResult => ({
    kind: 'ok',
    response: {
      aggregator: 'squid',
      status: 'pending',
      substatus: 'ONGOING',
      is_final: false,
      ...overrides,
    },
  });

  const unsupported: SwapStatusResult = { kind: 'unsupported' };
  const transient: SwapStatusResult = { kind: 'transient', message: 'upstream 503' };

  /**
   * Queue getSwapStatus results in order; the LAST entry repeats forever so
   * "always pending" / "always failing" scenarios don't run dry.
   */
  const queueResults = (...results: SwapStatusResult[]): void => {
    const queue = [...results];
    mockAggregatorService.getSwapStatus.and.callFake(() =>
      Promise.resolve(queue.length > 1 ? queue.shift()! : queue[0]),
    );
  };

  const track = (
    maxAttempts = 20,
    abortSignal?: AbortSignal,
    pollingInterval = 0, // default keeps specs instant
  ): Promise<AggregatorBridgeOutcome> =>
    service.trackAggregatorBridge(
      {
        aggregator: 'squid',
        txHash: '0xsrc',
        fromChain: 1,
        toChain: 8453,
        quoteId: 'qid-1',
        requestId: 'rid-1',
      },
      (state) => updates.push(state),
      pollingInterval,
      maxAttempts,
      abortSignal,
    );

  /** Macrotask-flush until `cond` holds (bounded so a regression fails fast). */
  const until = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 50 && !cond(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(cond()).toBeTrue();
  };

  beforeEach(() => {
    updates = [];
    mockAggregatorService = jasmine.createSpyObj('AggregatorService', ['getSwapStatus']);
    const mockChainService = jasmine.createSpyObj('ChainService', ['getChainName']);
    mockChainService.getChainName.and.callFake((chainId: number) => `Chain ${chainId}`);
    const mockAuthService = jasmine.createSpyObj('AuthService', ['getAccessTokenAsync']);

    TestBed.configureTestingModule({
      providers: [
        TransactionTrackerService,
        { provide: AggregatorService, useValue: mockAggregatorService },
        { provide: ChainService, useValue: mockChainService },
        { provide: AuthService, useValue: mockAuthService },
      ],
    });
    service = TestBed.inject(TransactionTrackerService);
  });

  it('passes the squid tracking ids through to /swap/status', async () => {
    queueResults(ok({ status: 'success', is_final: true }));

    await track();

    expect(mockAggregatorService.getSwapStatus).toHaveBeenCalledWith({
      aggregator: 'squid',
      transactionId: '0xsrc',
      fromChainId: 1,
      toChainId: 8453,
      quoteId: 'qid-1',
      requestId: 'rid-1',
    });
  });

  it('starts with the source step completed and the bridging step in progress', async () => {
    // The tracker is only started after the source receipt landed — showing
    // "Confirming on source" again would walk the progress backwards.
    queueResults(ok({ status: 'success', is_final: true }));

    await track();

    const initial = updates[0];
    expect(initial.isTracking).toBeTrue();
    expect(initial.steps[0].status).toBe('completed');
    expect(initial.steps[1].status).toBe('in_progress');
  });

  it('seeds and holds the bridging progress at the value the swap component paints (60)', async () => {
    // The component's execution callback paints bridging-in-progress @60
    // right before this tracker starts; an initial notify below that used
    // to walk the progress bar backwards (the old seed was 45).
    queueResults(
      ok(),
      ok({ status: 'success', is_final: true }),
    );

    await track();

    expect(AGGREGATOR_BRIDGING_PROGRESS).toBe(60);
    expect(updates[0].progress).toBe(AGGREGATOR_BRIDGING_PROGRESS);
    // Pending polls never dip below the seed either.
    const pendingUpdates = updates.filter((u) => u.isTracking);
    expect(pendingUpdates.every((u) => u.progress >= AGGREGATOR_BRIDGING_PROGRESS)).toBeTrue();
  });

  describe('status mapping', () => {
    it('success → final success outcome with a fully completed UI state', async () => {
      queueResults(
        ok(),
        ok({ status: 'success', is_final: true, tracking_url: AXELARSCAN_URL }),
      );

      const outcome = await track();

      expect(outcome.kind).toBe('success');
      const last = updates[updates.length - 1];
      expect(last.progress).toBe(100);
      expect(last.isTracking).toBeFalse();
      expect(last.steps.every((s) => s.status === 'completed')).toBeTrue();
      // The dispatcher's end-to-end tracker link is surfaced for the UI.
      expect(last.trackingUrl).toBe(AXELARSCAN_URL);
      expect(last.steps[1].explorerLink).toBe(AXELARSCAN_URL);
    });

    it('partial_success → final failure-with-explanation', async () => {
      queueResults(ok({ status: 'partial_success', substatus: 'PARTIAL_SUCCESS', is_final: true }));

      const outcome = await track();

      expect(outcome.kind).toBe('partial');
      if (outcome.kind === 'partial') {
        expect(outcome.reason).toBe(PARTIAL_SUCCESS_REASON);
      }
      const last = updates[updates.length - 1];
      expect(last.isTracking).toBeFalse();
      expect(last.error).toBe(PARTIAL_SUCCESS_REASON);
      expect(last.steps.some((s) => s.status === 'failed')).toBeTrue();
    });

    it('needs_gas → keeps polling and surfaces the stuck-needs-gas warning', async () => {
      queueResults(
        ok({ status: 'needs_gas', substatus: 'NEEDS_GAS' }),
        ok({ status: 'success', is_final: true }),
      );

      const outcome = await track();

      // Not a terminal verdict — polling continued to the real ending.
      expect(outcome.kind).toBe('success');
      expect(mockAggregatorService.getSwapStatus).toHaveBeenCalledTimes(2);
      const warned = updates.find((u) => u.steps[1].description?.includes('needs extra gas'));
      expect(warned).toBeDefined();
      expect(warned!.steps[1].status).toBe('in_progress');
      expect(warned!.isTracking).toBeTrue();
    });

    it('refunding → keeps polling with refund-in-progress copy', async () => {
      queueResults(
        ok({ status: 'refunding', substatus: 'REFUNDING' }),
        ok({ status: 'success', is_final: true }),
      );

      const outcome = await track();

      expect(outcome.kind).toBe('success');
      expect(mockAggregatorService.getSwapStatus).toHaveBeenCalledTimes(2);
      const refunding = updates.find((u) => u.steps[1].description?.includes('Refund in progress'));
      expect(refunding).toBeDefined();
      expect(refunding!.isTracking).toBeTrue();
    });

    it('needs_gas → pending recovery restores the default bridging copy and ETA', async () => {
      queueResults(
        ok({ status: 'needs_gas', substatus: 'NEEDS_GAS' }),
        ok(),
        ok({ status: 'success', is_final: true }),
      );

      const outcome = await track();

      expect(outcome.kind).toBe('success');
      const warned = updates.find((u) => u.steps[1].description?.includes('needs extra gas'));
      expect(warned).toBeDefined();
      // The warning state drops the ETA (no honest estimate exists)…
      expect(warned!.estimatedTimeRemaining).toBeUndefined();
      // …and the recovery to pending sheds the warning and brings it back.
      const recovered = updates.find(
        (u, i) =>
          i > updates.indexOf(warned!) &&
          u.steps[1].description === 'Transferring from Chain 1 to Chain 8453',
      );
      expect(recovered).toBeDefined();
      expect(recovered!.estimatedTimeRemaining).toBe(180);
    });

    it('treats an unrecognized status flagged is_final as terminal (gave_up)', async () => {
      // A newer dispatcher may grow statuses this client predates. If it
      // says the state is final, polling can't change the verdict — bail to
      // the untracked-bridge fallback instead of spinning to the cap.
      queueResults(ok({ status: 'refunded' as SwapBridgeStatus, substatus: 'REFUNDED', is_final: true }));

      const outcome = await track();

      expect(outcome).toEqual({
        kind: 'gave_up',
        lastObservedStatus: 'refunded' as SwapBridgeStatus,
      });
      expect(mockAggregatorService.getSwapStatus).toHaveBeenCalledTimes(1);
    });

    it('not_found → keeps polling (normal right after submission)', async () => {
      queueResults(
        ok({ status: 'not_found', substatus: 'NOT_FOUND' }),
        ok(),
        ok({ status: 'success', is_final: true }),
      );

      const outcome = await track();

      expect(outcome.kind).toBe('success');
      expect(mockAggregatorService.getSwapStatus).toHaveBeenCalledTimes(3);
      // not_found must never paint a failure while indexers catch up.
      expect(updates.every((u) => u.steps.every((s) => s.status !== 'failed'))).toBeTrue();
      expect(updates.every((u) => u.error === undefined)).toBeTrue();
    });
  });

  it('unsupported → stops immediately and tells the caller to fall back', async () => {
    queueResults(unsupported);

    const outcome = await track();

    expect(outcome).toEqual({ kind: 'unsupported' });
    expect(mockAggregatorService.getSwapStatus).toHaveBeenCalledTimes(1);
    // Only the initial paint happened — the caller repaints everything via
    // its untracked-bridge fallback, so no error/failed state was pushed.
    expect(updates.length).toBe(1);
    expect(updates[0].error).toBeUndefined();
  });

  it('gives up after 8 consecutive transient errors without marking the swap failed', async () => {
    // 8 strikes with exponential backoff cover a ~6-minute status-endpoint
    // outage (a routine backend deploy) before live tracking is abandoned.
    queueResults(transient);

    const outcome = await track();

    expect(outcome).toEqual({ kind: 'gave_up', lastObservedStatus: null });
    expect(mockAggregatorService.getSwapStatus).toHaveBeenCalledTimes(8);
    // Giving up means OUR status endpoint failed, not the swap: nothing
    // error-shaped may have been notified.
    expect(updates.length).toBe(1);
    expect(updates[0].error).toBeUndefined();
    expect(updates[0].steps.every((s) => s.status !== 'failed')).toBeTrue();
  });

  it('carries the last observed status into a gave_up outcome', async () => {
    // Tracking that dies mid-refund must say so — the component uses this
    // to annotate the history record so the stale-pending normalization
    // can't later present the refunded swap as delivered.
    queueResults(
      ok({ status: 'refunding', substatus: 'REFUNDING' }),
      transient,
    );

    const outcome = await track();

    expect(outcome).toEqual({ kind: 'gave_up', lastObservedStatus: 'refunding' });
  });

  it('a successful poll resets the consecutive transient-error counter', async () => {
    queueResults(
      transient, transient, transient, transient, transient, transient, transient,
      ok(),
      transient, transient, transient, transient, transient, transient, transient,
      ok({ status: 'success', is_final: true }),
    );

    const outcome = await track();

    // 7 failures + ok + 7 failures + success: neither streak hits the
    // 8-strike give-up cap.
    expect(outcome.kind).toBe('success');
    expect(mockAggregatorService.getSwapStatus).toHaveBeenCalledTimes(16);
  });

  it('returns timeout at the hard attempt cap while still pending', async () => {
    queueResults(ok());

    const outcome = await track(3);

    expect(outcome.kind).toBe('timeout');
    expect(mockAggregatorService.getSwapStatus).toHaveBeenCalledTimes(3);
    const last = updates[updates.length - 1];
    expect(last.isTracking).toBeFalse();
    // Honest banner: the transfer may still land — never claims failure.
    expect(last.error).toContain('Tracking timed out');
    expect(last.steps.every((s) => s.status !== 'failed')).toBeTrue();
  });

  it('carries the last observed status into a timeout outcome', async () => {
    queueResults(ok({ status: 'needs_gas', substatus: 'NEEDS_GAS' }));

    const outcome = await track(2);

    expect(outcome).toEqual({ kind: 'timeout', lastObservedStatus: 'needs_gas' });
  });

  describe('abort (component destroyed mid-tracking)', () => {
    it('an already-aborted signal resolves aborted before any poll or notify', async () => {
      const controller = new AbortController();
      controller.abort();
      queueResults(ok());

      const outcome = await track(20, controller.signal);

      expect(outcome).toEqual({ kind: 'aborted' });
      expect(mockAggregatorService.getSwapStatus).not.toHaveBeenCalled();
      expect(updates.length).toBe(0);
    });

    it('an abort landing while the status fetch is in flight resolves silently — no failure paint, no extra notify', async () => {
      const controller = new AbortController();
      let resolveStatus!: (result: SwapStatusResult) => void;
      mockAggregatorService.getSwapStatus.and.returnValue(
        new Promise<SwapStatusResult>((resolve) => { resolveStatus = resolve; }),
      );

      const promise = track(20, controller.signal);
      expect(updates.length).toBe(1); // synchronous initial paint
      await until(() => mockAggregatorService.getSwapStatus.calls.count() === 1);

      controller.abort();
      resolveStatus(ok());

      const outcome = await promise;
      expect(outcome).toEqual({ kind: 'aborted' });
      // The poll result arrived after the abort — a destroyed caller must
      // not receive one more repaint, and nothing error-shaped was pushed.
      expect(updates.length).toBe(1);
      expect(updates[0].error).toBeUndefined();
      expect(updates[0].steps.every((s) => s.status !== 'failed')).toBeTrue();
    });

    it('abort during the inter-poll sleep releases the loop without further polls or notifies', async () => {
      const controller = new AbortController();
      queueResults(ok());

      // 10-minute polling interval: if abort didn't cancel the sleep, this
      // spec (and the destroyed component in production) would hang.
      const promise = track(20, controller.signal, 600_000);

      await until(() => mockAggregatorService.getSwapStatus.calls.count() === 1);
      const notifiedSoFar = updates.length;
      controller.abort();

      expect(await promise).toEqual({ kind: 'aborted' });
      expect(mockAggregatorService.getSwapStatus).toHaveBeenCalledTimes(1);
      expect(updates.length).toBe(notifiedSoFar);
    });
  });
});

describe('TransactionTrackerService — trackTransaction abort (LI.FI loop)', () => {
  let service: TransactionTrackerService;
  let getStatusSpy: jasmine.Spy;
  let updates: TransactionTrackingState[];

  const pendingStatus = {
    transactionId: 'tid-1',
    status: 'PENDING',
    substatus: 'WAIT_SOURCE_CONFIRMATIONS',
  } as LifiStatusResponse;

  const doneStatus = {
    transactionId: 'tid-1',
    status: 'DONE',
  } as LifiStatusResponse;

  /** Macrotask-flush until `cond` holds (bounded so a regression fails fast). */
  const until = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 50 && !cond(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(cond()).toBeTrue();
  };

  const track = (
    abortSignal?: AbortSignal,
    pollingInterval = 0,
  ): Promise<LifiStatusResponse | null> =>
    service.trackTransaction(
      '0xsrc',
      1,
      1,
      (state) => updates.push(state),
      pollingInterval,
      100,
      undefined,
      abortSignal,
    );

  beforeEach(() => {
    updates = [];
    const mockChainService = jasmine.createSpyObj('ChainService', ['getChainName']);
    mockChainService.getChainName.and.callFake((chainId: number) => `Chain ${chainId}`);

    TestBed.configureTestingModule({
      providers: [
        TransactionTrackerService,
        { provide: AggregatorService, useValue: jasmine.createSpyObj('AggregatorService', ['getSwapStatus']) },
        { provide: ChainService, useValue: mockChainService },
        { provide: AuthService, useValue: jasmine.createSpyObj('AuthService', ['getAccessTokenAsync']) },
      ],
    });
    service = TestBed.inject(TransactionTrackerService);
    getStatusSpy = spyOn(service, 'getTransactionStatus');
  });

  it('without a signal, still resolves on DONE (regression guard)', async () => {
    getStatusSpy.and.resolveTo(doneStatus);

    const result = await track();

    expect(result).toEqual(doneStatus);
    const last = updates[updates.length - 1];
    expect(last.isTracking).toBeFalse();
    expect(last.progress).toBe(100);
  });

  it('an already-aborted signal resolves null before any poll or notify', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await track(controller.signal);

    expect(result).toBeNull();
    expect(getStatusSpy).not.toHaveBeenCalled();
    expect(updates.length).toBe(0);
  });

  it('abort during the inter-poll sleep releases the loop without further polls or notifies', async () => {
    const controller = new AbortController();
    getStatusSpy.and.resolveTo(pendingStatus);

    // 10-minute polling interval: if abort didn't cancel the sleep, this
    // spec (and the destroyed component in production) would hang.
    const promise = track(controller.signal, 600_000);

    await until(() => updates.some((u) => u.lifiStatus === pendingStatus));
    const notifiedSoFar = updates.length;
    controller.abort();

    expect(await promise).toBeNull();
    expect(getStatusSpy).toHaveBeenCalledTimes(1);
    expect(updates.length).toBe(notifiedSoFar);
  });

  it('an abort landing while the status fetch is in flight suppresses the notify', async () => {
    const controller = new AbortController();
    let resolveStatus!: (status: LifiStatusResponse | null) => void;
    getStatusSpy.and.returnValue(new Promise((resolve) => { resolveStatus = resolve; }));

    const promise = track(controller.signal);
    await until(() => getStatusSpy.calls.count() === 1);
    expect(updates.length).toBe(1); // initial paint only

    controller.abort();
    resolveStatus(pendingStatus);

    expect(await promise).toBeNull();
    // The poll result arrived after the abort — a destroyed caller must not
    // receive one more repaint.
    expect(updates.length).toBe(1);
  });
});

describe('sanitizeHttpsUrl', () => {
  it('passes https URLs on the allowlisted tracker host through', () => {
    expect(sanitizeHttpsUrl('https://axelarscan.io/gmp/0xabc')).toBe('https://axelarscan.io/gmp/0xabc');
  });

  it('accepts subdomains of an allowlisted host', () => {
    expect(sanitizeHttpsUrl('https://testnet.axelarscan.io/gmp/0xabc')).toBe('https://testnet.axelarscan.io/gmp/0xabc');
  });

  it('rejects non-https schemes an upstream could smuggle into a link', () => {
    // eslint-disable-next-line no-script-url
    expect(sanitizeHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeHttpsUrl('data:text/html,<script>1</script>')).toBeNull();
    expect(sanitizeHttpsUrl('http://axelarscan.io/gmp/0xabc')).toBeNull();
  });

  it('rejects https URLs on hosts outside the tracker allowlist (phishing guard)', () => {
    // A compromised upstream returning a perfectly valid https link must
    // still not be able to send the user to an arbitrary "explorer".
    expect(sanitizeHttpsUrl('https://evil.example/gmp/0xabc')).toBeNull();
  });

  it('rejects lookalike hosts that only contain the allowlisted domain as a suffix or label', () => {
    // String-suffix trick: notaxelarscan.io ends with "axelarscan.io" but
    // is a different registrable domain.
    expect(sanitizeHttpsUrl('https://notaxelarscan.io/gmp/0xabc')).toBeNull();
    // Subdomain-of-attacker trick: axelarscan.io.evil.com.
    expect(sanitizeHttpsUrl('https://axelarscan.io.evil.com/gmp/0xabc')).toBeNull();
    // Userinfo trick: the real host is evil.com, not axelarscan.io.
    expect(sanitizeHttpsUrl('https://axelarscan.io@evil.com/gmp/0xabc')).toBeNull();
  });

  it('rejects unparseable or empty values', () => {
    expect(sanitizeHttpsUrl('not a url')).toBeNull();
    expect(sanitizeHttpsUrl('')).toBeNull();
    expect(sanitizeHttpsUrl(undefined)).toBeNull();
    expect(sanitizeHttpsUrl(null)).toBeNull();
  });
});
