import { TestBed } from '@angular/core/testing';
import { TransactionRehydrationService } from './transaction-rehydration.service';
import { TransactionHistoryService, TransactionRecord } from './transaction-history.service';
import { TransactionTrackerService, PARTIAL_SUCCESS_REASON } from './swap/transaction-tracker.service';
import { AggregatorService, SwapStatusResult } from './swap/aggregator.service';
import type { LifiStatusResponse, SwapBridgeStatus, SwapStatusResponse } from '../models/swap.model';

/**
 * Focus: the cross-chain routing fix. Before it, every cross-chain record was
 * sent to LI.FI's Status API regardless of which aggregator bridged it, so a
 * Squid swap (unknown to LI.FI) read NOT_FOUND forever and silently aged into
 * a "delivered" verdict. These specs pin the per-aggregator dispatch and the
 * status→record mapping.
 */
describe('TransactionRehydrationService — cross-chain dispatch', () => {
  let service: TransactionRehydrationService;
  let history: jasmine.SpyObj<TransactionHistoryService>;
  let tracker: jasmine.SpyObj<TransactionTrackerService>;
  let aggregator: jasmine.SpyObj<AggregatorService>;

  let pending: TransactionRecord[];

  const crossChainRecord = (overrides: Partial<TransactionRecord> = {}): TransactionRecord => ({
    id: overrides.id ?? 'rec-1',
    type: 'swap',
    timestamp: 0,
    status: 'pending',
    txHash: '0xsrc',
    chainId: 1,
    fromToken: { symbol: 'USDC', address: '0xusdc', chainId: 1, amount: '100' },
    toToken: { symbol: 'USDC', address: '0xusdc2', chainId: 42161, amount: '100' },
    ...overrides,
  });

  const backendOk = (status: SwapBridgeStatus): SwapStatusResult => ({
    kind: 'ok',
    response: {
      aggregator: 'squid',
      status,
      substatus: 'X',
      is_final: status === 'success' || status === 'partial_success',
    } as SwapStatusResponse,
  });

  beforeEach(() => {
    pending = [];

    history = jasmine.createSpyObj<TransactionHistoryService>(
      'TransactionHistoryService',
      ['markSuccess', 'markFailed', 'updateTransaction'],
    );
    // `pendingTransactions` is a computed signal — provide a plain getter
    // (the service only ever calls it, never reads the SIGNAL brand).
    (history as unknown as { pendingTransactions: () => TransactionRecord[] }).pendingTransactions =
      () => pending;

    tracker = jasmine.createSpyObj<TransactionTrackerService>('TransactionTrackerService', [
      'getTransactionStatus',
    ]);
    aggregator = jasmine.createSpyObj<AggregatorService>('AggregatorService', ['getSwapStatus']);

    TestBed.configureTestingModule({
      providers: [
        TransactionRehydrationService,
        { provide: TransactionHistoryService, useValue: history },
        { provide: TransactionTrackerService, useValue: tracker },
        { provide: AggregatorService, useValue: aggregator },
      ],
    });
    service = TestBed.inject(TransactionRehydrationService);
  });

  // ---------------------------------------------------------------------------
  // Routing: which API gets the lookup
  // ---------------------------------------------------------------------------

  it('routes a Squid-tagged cross-chain record to the backend, not LI.FI', async () => {
    pending = [crossChainRecord({ aggregator: 'squid', trackingQuoteId: 'q1', trackingRequestId: 'r1' })];
    aggregator.getSwapStatus.and.resolveTo(backendOk('pending'));

    await service.rehydratePendingForCurrentWallet();

    expect(tracker.getTransactionStatus).not.toHaveBeenCalled();
    expect(aggregator.getSwapStatus).toHaveBeenCalledTimes(1);
    expect(aggregator.getSwapStatus).toHaveBeenCalledWith({
      aggregator: 'squid',
      transactionId: '0xsrc',
      fromChainId: 1,
      toChainId: 42161,
      quoteId: 'q1',
      requestId: 'r1',
    });
  });

  it('routes a LI.FI-tagged cross-chain record to the LI.FI tracker, not the backend', async () => {
    pending = [crossChainRecord({ aggregator: 'lifi' })];
    tracker.getTransactionStatus.and.resolveTo({ status: 'PENDING' } as LifiStatusResponse);

    await service.rehydratePendingForCurrentWallet();

    expect(aggregator.getSwapStatus).not.toHaveBeenCalled();
    expect(tracker.getTransactionStatus).toHaveBeenCalledWith('0xsrc', 1);
  });

  it('routes a legacy/untagged cross-chain record to the LI.FI tracker', async () => {
    pending = [crossChainRecord({ aggregator: undefined })];
    tracker.getTransactionStatus.and.resolveTo({ status: 'PENDING' } as LifiStatusResponse);

    await service.rehydratePendingForCurrentWallet();

    expect(aggregator.getSwapStatus).not.toHaveBeenCalled();
    expect(tracker.getTransactionStatus).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Backend status → record mapping
  // ---------------------------------------------------------------------------

  it('marks success on backend success', async () => {
    pending = [crossChainRecord({ aggregator: 'squid' })];
    aggregator.getSwapStatus.and.resolveTo(backendOk('success'));

    await service.rehydratePendingForCurrentWallet();

    expect(history.markSuccess).toHaveBeenCalledWith('rec-1', '0xsrc');
    expect(history.markFailed).not.toHaveBeenCalled();
  });

  it('marks FAILED with the partial-success reason on partial_success (a fallback token, not the quoted one)', async () => {
    pending = [crossChainRecord({ aggregator: 'squid' })];
    aggregator.getSwapStatus.and.resolveTo(backendOk('partial_success'));

    await service.rehydratePendingForCurrentWallet();

    expect(history.markFailed).toHaveBeenCalledWith('rec-1', PARTIAL_SUCCESS_REASON);
    expect(history.markSuccess).not.toHaveBeenCalled();
  });

  it('annotates refunding and keeps the record pending (no markSuccess)', async () => {
    pending = [crossChainRecord({ aggregator: 'squid' })];
    aggregator.getSwapStatus.and.resolveTo(backendOk('refunding'));

    await service.rehydratePendingForCurrentWallet();

    expect(history.updateTransaction).toHaveBeenCalledTimes(1);
    const [id, updates] = history.updateTransaction.calls.mostRecent().args;
    expect(id).toBe('rec-1');
    expect(updates.bridgeAnnotation).toBe('refunding');
    expect(updates.errorMessage).toBeTruthy();
    expect(history.markSuccess).not.toHaveBeenCalled();
    expect(history.markFailed).not.toHaveBeenCalled();
  });

  it('annotates needs_gas and keeps the record pending', async () => {
    pending = [crossChainRecord({ aggregator: 'squid' })];
    aggregator.getSwapStatus.and.resolveTo(backendOk('needs_gas'));

    await service.rehydratePendingForCurrentWallet();

    const [, updates] = history.updateTransaction.calls.mostRecent().args;
    expect(updates.bridgeAnnotation).toBe('needs_gas');
    expect(history.markSuccess).not.toHaveBeenCalled();
  });

  it('leaves the record untouched on backend pending / not_found', async () => {
    for (const status of ['pending', 'not_found'] as SwapBridgeStatus[]) {
      history.markSuccess.calls.reset();
      history.markFailed.calls.reset();
      history.updateTransaction.calls.reset();
      pending = [crossChainRecord({ aggregator: 'squid', id: `rec-${status}` })];
      aggregator.getSwapStatus.and.resolveTo(backendOk(status));

      await service.rehydratePendingForCurrentWallet();

      expect(history.markSuccess).not.toHaveBeenCalled();
      expect(history.markFailed).not.toHaveBeenCalled();
      expect(history.updateTransaction).not.toHaveBeenCalled();
    }
  });

  it('leaves the record untouched on unsupported / transient results', async () => {
    for (const result of [{ kind: 'unsupported' }, { kind: 'transient', message: 'x' }] as SwapStatusResult[]) {
      history.markSuccess.calls.reset();
      history.updateTransaction.calls.reset();
      pending = [crossChainRecord({ aggregator: 'squid', id: 'rec-x' })];
      aggregator.getSwapStatus.and.resolveTo(result);

      await service.rehydratePendingForCurrentWallet();

      expect(history.markSuccess).not.toHaveBeenCalled();
      expect(history.markFailed).not.toHaveBeenCalled();
      expect(history.updateTransaction).not.toHaveBeenCalled();
    }
  });

  it('skips records without a txHash', async () => {
    pending = [crossChainRecord({ aggregator: 'squid', txHash: undefined })];

    await service.rehydratePendingForCurrentWallet();

    expect(aggregator.getSwapStatus).not.toHaveBeenCalled();
    expect(tracker.getTransactionStatus).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // rehydratePendingNow — on-demand throttle (history panel entry point)
  // ---------------------------------------------------------------------------

  describe('rehydratePendingNow — throttle', () => {
    beforeEach(() => {
      // Mocked wall clock so the 30s cooldown can be crossed with tick().
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(2026, 0, 1));
    });

    afterEach(() => {
      jasmine.clock().uninstall();
    });

    it('runs the same resolve-pending pass and reports via isRechecking', async () => {
      pending = [crossChainRecord({ aggregator: 'squid' })];
      aggregator.getSwapStatus.and.resolveTo(backendOk('success'));

      expect(service.isRechecking()).toBeFalse();
      const pass = service.rehydratePendingNow();
      expect(service.isRechecking()).toBeTrue();

      await pass;

      expect(service.isRechecking()).toBeFalse();
      expect(history.markSuccess).toHaveBeenCalledWith('rec-1', '0xsrc');
    });

    it('collapses concurrent calls onto the single running pass', async () => {
      pending = [crossChainRecord({ aggregator: 'squid' })];
      let release!: (result: SwapStatusResult) => void;
      aggregator.getSwapStatus.and.returnValue(
        new Promise<SwapStatusResult>((resolve) => (release = resolve)),
      );

      const first = service.rehydratePendingNow();
      const second = service.rehydratePendingNow();

      // Same promise object → the second caller joined the running pass.
      expect(second).toBe(first);
      expect(aggregator.getSwapStatus).toHaveBeenCalledTimes(1);

      release(backendOk('pending'));
      await Promise.all([first, second]);
      expect(service.isRechecking()).toBeFalse();
    });

    it('skips a call inside the 30s cooldown, runs again once it elapses', async () => {
      pending = [crossChainRecord({ aggregator: 'squid' })];
      aggregator.getSwapStatus.and.resolveTo(backendOk('pending'));

      await service.rehydratePendingNow();
      expect(aggregator.getSwapStatus).toHaveBeenCalledTimes(1);

      // Immediately re-opening the panel must NOT trigger a second pass.
      await service.rehydratePendingNow();
      expect(aggregator.getSwapStatus).toHaveBeenCalledTimes(1);
      expect(service.isRechecking()).toBeFalse();

      jasmine.clock().tick(30_001);
      await service.rehydratePendingNow();
      expect(aggregator.getSwapStatus).toHaveBeenCalledTimes(2);
    });

    it('does not throttle the startup pass (rehydratePendingForCurrentWallet)', async () => {
      pending = [crossChainRecord({ aggregator: 'squid' })];
      aggregator.getSwapStatus.and.resolveTo(backendOk('pending'));

      await service.rehydratePendingNow();
      // Wallet switch inside the cooldown window must still resolve pendings.
      await service.rehydratePendingForCurrentWallet();

      expect(aggregator.getSwapStatus).toHaveBeenCalledTimes(2);
    });
  });
});
