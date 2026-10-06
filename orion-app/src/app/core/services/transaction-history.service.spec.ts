/**
 * =============================================================================
 * TRANSACTION HISTORY SERVICE TESTS
 * =============================================================================
 *
 * Unit tests for TransactionHistoryService that manages transaction history
 * using localStorage for persistent storage.
 *
 * Test categories:
 * - Wallet management: setWallet, getWallet
 * - Transaction CRUD: addTransaction, updateTransaction, deleteTransaction
 * - Helper methods: createSwapTransaction, createSendTransaction, markSuccess, markFailed
 * - Query methods: getTransaction, getByType, getByChain
 * - Formatting helpers: formatRelativeTime, getTypeIcon, getTypeLabel, getStatusColor
 * - Storage: localStorage persistence, per-wallet isolation
 */

import { TestBed } from '@angular/core/testing';
import {
  TransactionHistoryService,
  TransactionRecord,
  TransactionType,
  TransactionStatus,
  TokenInfo,
} from './transaction-history.service';

describe('TransactionHistoryService', () => {
  let service: TransactionHistoryService;

  const mockTokenInfo: TokenInfo = {
    symbol: 'ETH',
    name: 'Ethereum',
    address: '0x0000000000000000000000000000000000000000',
    chainId: 1,
    amount: '1.5',
    amountUSD: 3000,
    logoURI: 'https://example.com/eth.png',
  };

  const mockToTokenInfo: TokenInfo = {
    symbol: 'USDC',
    name: 'USD Coin',
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    chainId: 1,
    amount: '3000',
    amountUSD: 3000,
    logoURI: 'https://example.com/usdc.png',
  };

  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();

    TestBed.configureTestingModule({
      providers: [TransactionHistoryService],
    });
    service = TestBed.inject(TransactionHistoryService);
  });

  afterEach(() => {
    localStorage.clear();
  });

  // ===========================================================================
  // WALLET MANAGEMENT
  // ===========================================================================

  describe('Wallet Management', () => {
    it('should set and get wallet address', () => {
      expect(service.getWallet()).toBeNull();

      service.setWallet('0x1234567890123456789012345678901234567890');

      expect(service.getWallet()).toBe('0x1234567890123456789012345678901234567890');
    });

    it('should clear transactions when wallet is set to null', () => {
      service.setWallet('0x1234567890123456789012345678901234567890');
      service.createSwapTransaction({
        fromToken: mockTokenInfo,
        toToken: mockToTokenInfo,
        chainId: 1,
      });

      expect(service.transactions().length).toBe(1);

      service.setWallet(null);

      expect(service.transactions().length).toBe(0);
    });

    it('should load existing transactions when setting wallet', () => {
      const walletAddress = '0x1234567890123456789012345678901234567890';

      // Pre-populate localStorage
      const existingTx: TransactionRecord = {
        id: 'test-id',
        type: 'swap',
        timestamp: Date.now(),
        status: 'success',
        chainId: 1,
        fromToken: mockTokenInfo,
        toToken: mockToTokenInfo,
      };
      localStorage.setItem(
        `orion_tx_history_${walletAddress.toLowerCase()}`,
        JSON.stringify([existingTx])
      );

      service.setWallet(walletAddress);

      expect(service.transactions().length).toBe(1);
      expect(service.transactions()[0].id).toBe('test-id');
    });

    it('should not reload if same wallet is set', () => {
      const walletAddress = '0x1234567890123456789012345678901234567890';
      service.setWallet(walletAddress);
      service.createSwapTransaction({
        fromToken: mockTokenInfo,
        toToken: mockToTokenInfo,
        chainId: 1,
      });

      const txCount = service.transactions().length;

      // Set same wallet again
      service.setWallet(walletAddress);

      expect(service.transactions().length).toBe(txCount);
    });

    it('should isolate transactions per wallet', () => {
      const wallet1 = '0x1111111111111111111111111111111111111111';
      const wallet2 = '0x2222222222222222222222222222222222222222';

      // Add transaction for wallet1
      service.setWallet(wallet1);
      service.createSwapTransaction({
        fromToken: mockTokenInfo,
        toToken: mockToTokenInfo,
        chainId: 1,
      });
      expect(service.transactions().length).toBe(1);

      // Switch to wallet2
      service.setWallet(wallet2);
      expect(service.transactions().length).toBe(0);

      // Add transaction for wallet2
      service.createSendTransaction({
        token: mockTokenInfo,
        toAddress: '0x3333',
        chainId: 1,
      });
      expect(service.transactions().length).toBe(1);

      // Switch back to wallet1
      service.setWallet(wallet1);
      expect(service.transactions().length).toBe(1);
      expect(service.transactions()[0].type).toBe('swap');
    });
  });

  // ===========================================================================
  // TRANSACTION CRUD
  // ===========================================================================

  describe('Transaction CRUD', () => {
    beforeEach(() => {
      service.setWallet('0x1234567890123456789012345678901234567890');
    });

    it('should throw error when adding transaction without wallet', () => {
      service.setWallet(null);

      expect(() => {
        service.addTransaction({
          type: 'swap',
          status: 'pending',
          chainId: 1,
        });
      }).toThrowError('No wallet connected');
    });

    it('should add transaction with generated id and timestamp', () => {
      const tx = service.addTransaction({
        type: 'swap',
        status: 'pending',
        chainId: 1,
        fromToken: mockTokenInfo,
        toToken: mockToTokenInfo,
      });

      expect(tx.id).toBeTruthy();
      expect(tx.timestamp).toBeGreaterThan(0);
      expect(tx.type).toBe('swap');
      expect(tx.status).toBe('pending');
    });

    it('should prepend new transactions (newest first)', () => {
      service.addTransaction({ type: 'swap', status: 'success', chainId: 1 });
      service.addTransaction({ type: 'send', status: 'pending', chainId: 1 });

      expect(service.transactions()[0].type).toBe('send');
      expect(service.transactions()[1].type).toBe('swap');
    });

    it('should limit transactions to 100', () => {
      for (let i = 0; i < 110; i++) {
        service.addTransaction({ type: 'swap', status: 'success', chainId: 1 });
      }

      expect(service.transactions().length).toBe(100);
    });

    it('should update existing transaction', () => {
      const tx = service.addTransaction({
        type: 'swap',
        status: 'pending',
        chainId: 1,
      });

      const updated = service.updateTransaction(tx.id, {
        status: 'success',
        txHash: '0xabc123',
      });

      expect(updated?.status).toBe('success');
      expect(updated?.txHash).toBe('0xabc123');
    });

    it('should return null when updating non-existent transaction', () => {
      const result = service.updateTransaction('non-existent-id', {
        status: 'success',
      });

      expect(result).toBeNull();
    });

    it('should delete transaction', () => {
      const tx = service.addTransaction({
        type: 'swap',
        status: 'success',
        chainId: 1,
      });

      expect(service.transactions().length).toBe(1);

      const deleted = service.deleteTransaction(tx.id);

      expect(deleted).toBe(true);
      expect(service.transactions().length).toBe(0);
    });

    it('should return false when deleting non-existent transaction', () => {
      const result = service.deleteTransaction('non-existent-id');
      expect(result).toBe(false);
    });

    it('should clear all history', () => {
      service.addTransaction({ type: 'swap', status: 'success', chainId: 1 });
      service.addTransaction({ type: 'send', status: 'success', chainId: 1 });

      expect(service.transactions().length).toBe(2);

      service.clearHistory();

      expect(service.transactions().length).toBe(0);
    });
  });

  // ===========================================================================
  // HELPER METHODS
  // ===========================================================================

  describe('Helper Methods', () => {
    beforeEach(() => {
      service.setWallet('0x1234567890123456789012345678901234567890');
    });

    it('should create swap transaction', () => {
      const tx = service.createSwapTransaction({
        fromToken: mockTokenInfo,
        toToken: mockToTokenInfo,
        chainId: 1,
        tool: 'Uniswap',
        gasUSD: 5.5,
      });

      expect(tx.type).toBe('swap');
      expect(tx.status).toBe('pending');
      expect(tx.fromToken?.symbol).toBe('ETH');
      expect(tx.toToken?.symbol).toBe('USDC');
      expect(tx.tool).toBe('Uniswap');
      expect(tx.gasUSD).toBe(5.5);
    });

    it('persists aggregator tracking metadata on swap records across a storage round-trip', () => {
      const wallet = '0x1234567890123456789012345678901234567890';
      const tx = service.createSwapTransaction({
        fromToken: mockTokenInfo,
        toToken: mockToTokenInfo,
        chainId: 1,
        aggregator: 'squid',
        trackingQuoteId: 'qid-1',
        trackingRequestId: 'rid-1',
      });

      expect(tx.aggregator).toBe('squid');
      expect(tx.trackingQuoteId).toBe('qid-1');
      expect(tx.trackingRequestId).toBe('rid-1');

      // Reload from localStorage — a future rehydration pass needs these
      // fields to survive persistence, not just live in memory.
      service.setWallet(null);
      service.setWallet(wallet);
      const loaded = service.getTransaction(tx.id);
      expect(loaded?.aggregator).toBe('squid');
      expect(loaded?.trackingQuoteId).toBe('qid-1');
      expect(loaded?.trackingRequestId).toBe('rid-1');
    });

    it('should create send transaction', () => {
      const tx = service.createSendTransaction({
        token: mockTokenInfo,
        toAddress: '0xrecipient',
        chainId: 42161,
      });

      expect(tx.type).toBe('send');
      expect(tx.status).toBe('pending');
      expect(tx.fromToken?.symbol).toBe('ETH');
      expect(tx.toAddress).toBe('0xrecipient');
      expect(tx.chainId).toBe(42161);
    });

    it('should create approve transaction', () => {
      const tx = service.createApproveTransaction({
        token: mockTokenInfo,
        chainId: 1,
      });

      expect(tx.type).toBe('approve');
      expect(tx.status).toBe('pending');
      expect(tx.fromToken?.symbol).toBe('ETH');
    });

    it('should mark transaction as success', () => {
      const tx = service.addTransaction({
        type: 'swap',
        status: 'pending',
        chainId: 1,
      });

      const updated = service.markSuccess(tx.id, '0xtxhash123');

      expect(updated?.status).toBe('success');
      expect(updated?.txHash).toBe('0xtxhash123');
    });

    it('should mark transaction as failed', () => {
      const tx = service.addTransaction({
        type: 'swap',
        status: 'pending',
        chainId: 1,
      });

      const updated = service.markFailed(tx.id, 'User rejected');

      expect(updated?.status).toBe('failed');
      expect(updated?.errorMessage).toBe('User rejected');
    });
  });

  // ===========================================================================
  // QUERY METHODS
  // ===========================================================================

  describe('Query Methods', () => {
    beforeEach(() => {
      service.setWallet('0x1234567890123456789012345678901234567890');

      // Add various transactions
      service.addTransaction({ type: 'swap', status: 'success', chainId: 1 });
      service.addTransaction({ type: 'swap', status: 'pending', chainId: 42161 });
      service.addTransaction({ type: 'send', status: 'success', chainId: 1 });
      service.addTransaction({ type: 'approve', status: 'failed', chainId: 137 });
    });

    it('should get transaction by id', () => {
      const tx = service.addTransaction({
        type: 'swap',
        status: 'success',
        chainId: 1,
      });

      const found = service.getTransaction(tx.id);

      expect(found).toBeTruthy();
      expect(found?.id).toBe(tx.id);
    });

    it('should return undefined for non-existent transaction', () => {
      const found = service.getTransaction('non-existent');
      expect(found).toBeUndefined();
    });

    it('should get transactions by type', () => {
      const swaps = service.getByType('swap');
      const sends = service.getByType('send');

      expect(swaps.length).toBe(2);
      expect(sends.length).toBe(1);
    });

    it('should get transactions by chain', () => {
      const ethTxs = service.getByChain(1);
      const arbTxs = service.getByChain(42161);
      const polyTxs = service.getByChain(137);

      expect(ethTxs.length).toBe(2);
      expect(arbTxs.length).toBe(1);
      expect(polyTxs.length).toBe(1);
    });
  });

  // ===========================================================================
  // COMPUTED SIGNALS
  // ===========================================================================

  describe('Computed Signals', () => {
    beforeEach(() => {
      service.setWallet('0x1234567890123456789012345678901234567890');
    });

    it('should compute recent transactions (last 10)', () => {
      for (let i = 0; i < 15; i++) {
        service.addTransaction({ type: 'swap', status: 'success', chainId: 1 });
      }

      expect(service.recentTransactions().length).toBe(10);
    });

    it('should compute pending transactions', () => {
      service.addTransaction({ type: 'swap', status: 'success', chainId: 1 });
      service.addTransaction({ type: 'swap', status: 'pending', chainId: 1 });
      service.addTransaction({ type: 'send', status: 'pending', chainId: 1 });

      expect(service.pendingTransactions().length).toBe(2);
    });

    it('should compute hasPending', () => {
      expect(service.hasPending()).toBe(false);

      service.addTransaction({ type: 'swap', status: 'pending', chainId: 1 });

      expect(service.hasPending()).toBe(true);
    });

    it('should compute count', () => {
      expect(service.count()).toBe(0);

      service.addTransaction({ type: 'swap', status: 'success', chainId: 1 });
      service.addTransaction({ type: 'send', status: 'success', chainId: 1 });

      expect(service.count()).toBe(2);
    });
  });

  // ===========================================================================
  // FORMATTING HELPERS
  // ===========================================================================

  describe('Formatting Helpers', () => {
    it('should format relative time - just now', () => {
      const now = Date.now();
      expect(service.formatRelativeTime(now)).toBe('Just now');
      expect(service.formatRelativeTime(now - 30000)).toBe('Just now');
    });

    it('should format relative time - minutes ago', () => {
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      expect(service.formatRelativeTime(fiveMinutesAgo)).toBe('5m ago');
    });

    it('should format relative time - hours ago', () => {
      const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
      expect(service.formatRelativeTime(threeHoursAgo)).toBe('3h ago');
    });

    it('should format relative time - yesterday', () => {
      const yesterday = Date.now() - 24 * 60 * 60 * 1000;
      expect(service.formatRelativeTime(yesterday)).toBe('Yesterday');
    });

    it('should format relative time - days ago', () => {
      const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
      expect(service.formatRelativeTime(threeDaysAgo)).toBe('3d ago');
    });

    it('should format relative time - older than 7 days', () => {
      const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const result = service.formatRelativeTime(twoWeeksAgo);
      // Should return date string
      expect(result).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
    });

    it('should get correct type icons', () => {
      expect(service.getTypeIcon('swap')).toBe('swap_horiz');
      expect(service.getTypeIcon('send')).toBe('arrow_outward');
      expect(service.getTypeIcon('receive')).toBe('arrow_downward');
      expect(service.getTypeIcon('approve')).toBe('check_circle');
    });

    it('should get correct type labels', () => {
      expect(service.getTypeLabel('swap')).toBe('Swapped');
      expect(service.getTypeLabel('send')).toBe('Sent');
      expect(service.getTypeLabel('receive')).toBe('Received');
      expect(service.getTypeLabel('approve')).toBe('Approved');
    });

    it('should get correct status colors', () => {
      expect(service.getStatusColor('success')).toContain('emerald');
      expect(service.getStatusColor('failed')).toContain('red');
      expect(service.getStatusColor('pending')).toContain('yellow');
    });

    it('should format time', () => {
      const timestamp = new Date('2024-01-15T14:30:00').getTime();
      const result = service.formatTime(timestamp);
      // Should contain AM/PM format
      expect(result).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/i);
    });
  });

  // ===========================================================================
  // STORAGE PERSISTENCE
  // ===========================================================================

  describe('Storage Persistence', () => {
    const walletAddress = '0x1234567890123456789012345678901234567890';

    it('should persist transactions to localStorage', () => {
      service.setWallet(walletAddress);
      service.addTransaction({ type: 'swap', status: 'success', chainId: 1 });

      const storageKey = `orion_tx_history_${walletAddress.toLowerCase()}`;
      const stored = localStorage.getItem(storageKey);

      expect(stored).toBeTruthy();
      const parsed = JSON.parse(stored!);
      expect(parsed.length).toBe(1);
      expect(parsed[0].type).toBe('swap');
    });

    it('should load transactions from localStorage on wallet set', () => {
      const storageKey = `orion_tx_history_${walletAddress.toLowerCase()}`;
      const existingTxs: TransactionRecord[] = [
        {
          id: 'stored-tx-1',
          type: 'swap',
          timestamp: Date.now(),
          status: 'success',
          chainId: 1,
        },
        {
          id: 'stored-tx-2',
          type: 'send',
          timestamp: Date.now(),
          status: 'pending',
          chainId: 42161,
        },
      ];
      localStorage.setItem(storageKey, JSON.stringify(existingTxs));

      service.setWallet(walletAddress);

      expect(service.transactions().length).toBe(2);
      expect(service.transactions()[0].id).toBe('stored-tx-1');
    });

    it('should handle corrupted localStorage gracefully', () => {
      const storageKey = `orion_tx_history_${walletAddress.toLowerCase()}`;
      localStorage.setItem(storageKey, 'invalid json {{{');

      // Should not throw
      expect(() => service.setWallet(walletAddress)).not.toThrow();
      expect(service.transactions().length).toBe(0);
    });

    it('should remove localStorage entry on clearHistory', () => {
      service.setWallet(walletAddress);
      service.addTransaction({ type: 'swap', status: 'success', chainId: 1 });

      const storageKey = `orion_tx_history_${walletAddress.toLowerCase()}`;
      expect(localStorage.getItem(storageKey)).toBeTruthy();

      service.clearHistory();

      expect(localStorage.getItem(storageKey)).toBeNull();
    });

    it('should use lowercase wallet address for storage key', () => {
      const mixedCaseAddress = '0xAbCdEf1234567890123456789012345678901234';
      service.setWallet(mixedCaseAddress);
      service.addTransaction({ type: 'swap', status: 'success', chainId: 1 });

      const storageKey = `orion_tx_history_${mixedCaseAddress.toLowerCase()}`;
      expect(localStorage.getItem(storageKey)).toBeTruthy();
    });
  });

  // ===========================================================================
  // UNTRACKED BRIDGE NORMALIZATION ON LOAD
  // ===========================================================================

  describe('Untracked bridge normalization on load', () => {
    const walletAddress = '0x1234567890123456789012345678901234567890';
    const storageKey = `orion_tx_history_${walletAddress}`;
    const HOUR_MS = 60 * 60 * 1000;

    const bridgeRecord = (overrides: Partial<TransactionRecord> = {}): TransactionRecord => ({
      id: `bridge-${Math.random().toString(36).slice(2)}`,
      type: 'swap',
      timestamp: Date.now() - HOUR_MS - 60_000,
      status: 'pending',
      chainId: 1,
      fromToken: { ...mockTokenInfo, chainId: 1 },
      toToken: { ...mockToTokenInfo, chainId: 42161 },
      ...overrides,
    });

    const seedAndLoad = (records: TransactionRecord[]): void => {
      localStorage.setItem(storageKey, JSON.stringify(records));
      service.setWallet(walletAddress);
    };

    it('presents a pending cross-chain swap older than 60 minutes as delivered', () => {
      seedAndLoad([bridgeRecord()]);

      expect(service.transactions()[0].status).toBe('success');
      // It must also leave the pending set — no pending badge, and the
      // rehydrator stops polling LI.FI for a bridge it can't see.
      expect(service.hasPending()).toBeFalse();
    });

    it('does not rewrite the stored record on load (display-side mapping only)', () => {
      seedAndLoad([bridgeRecord()]);

      const stored = JSON.parse(localStorage.getItem(storageKey)!) as TransactionRecord[];
      expect(stored[0].status).toBe('pending');
    });

    it('normalizes at exactly the 60-minute cutoff', () => {
      seedAndLoad([bridgeRecord({ timestamp: Date.now() - HOUR_MS })]);

      expect(service.transactions()[0].status).toBe('success');
    });

    it('keeps a pending cross-chain swap inside the 60-minute window pending', () => {
      seedAndLoad([bridgeRecord({ timestamp: Date.now() - 59 * 60 * 1000 })]);

      expect(service.transactions()[0].status).toBe('pending');
      expect(service.hasPending()).toBeTrue();
    });

    it('leaves old same-chain pending swaps for receipt rehydration', () => {
      seedAndLoad([
        bridgeRecord({ toToken: { ...mockToTokenInfo, chainId: 1 } }),
      ]);

      expect(service.transactions()[0].status).toBe('pending');
    });

    it('does not touch pending sends or already-final cross-chain records', () => {
      seedAndLoad([
        bridgeRecord({ id: 'old-send', type: 'send', toToken: undefined }),
        bridgeRecord({ id: 'old-failed', status: 'failed' }),
      ]);

      const byId = new Map(service.transactions().map(tx => [tx.id, tx]));
      expect(byId.get('old-send')?.status).toBe('pending');
      expect(byId.get('old-failed')?.status).toBe('failed');
    });

    it('skips records missing one side of the pair (cannot prove cross-chain)', () => {
      seedAndLoad([bridgeRecord({ toToken: undefined })]);

      expect(service.transactions()[0].status).toBe('pending');
    });

    // -------------------------------------------------------------------------
    // Interrupted-tracking annotations (bridgeAnnotation) — history must never
    // claim delivery for a swap last seen refunding / waiting for gas.
    // -------------------------------------------------------------------------

    it('presents a stale pending bridge annotated as refunding as failed, never delivered', () => {
      seedAndLoad([bridgeRecord({
        bridgeAnnotation: 'refunding',
        errorMessage: 'A refund was in progress when tracking stopped — check your source-chain wallet.',
      })]);

      const tx = service.transactions()[0];
      expect(tx.status).toBe('failed');
      // The note survives normalization so the history list can render it.
      expect(tx.errorMessage).toContain('refund');
    });

    it('keeps a stale pending bridge annotated as needs_gas pending (outcome unknowable)', () => {
      seedAndLoad([bridgeRecord({ bridgeAnnotation: 'needs_gas' })]);

      // Neither delivery nor failure is provable client-side for a transfer
      // stuck on destination gas — pending is the honest presentation.
      expect(service.transactions()[0].status).toBe('pending');
    });

    it('leaves annotated records inside the 60-minute window pending', () => {
      seedAndLoad([bridgeRecord({
        bridgeAnnotation: 'refunding',
        timestamp: Date.now() - 59 * 60 * 1000,
      })]);

      // The refund may still be in flight — only past the cutoff do we
      // commit to the failed presentation.
      expect(service.transactions()[0].status).toBe('pending');
    });

    it('round-trips a bridgeAnnotation written via updateTransaction without touching status', () => {
      service.setWallet(walletAddress);
      const tx = service.addTransaction({
        type: 'swap',
        status: 'pending',
        chainId: 1,
        fromToken: { ...mockTokenInfo, chainId: 1 },
        toToken: { ...mockToTokenInfo, chainId: 42161 },
        txHash: '0xsrc',
      });

      service.updateTransaction(tx.id, {
        bridgeAnnotation: 'refunding',
        errorMessage: 'A refund was in progress when tracking stopped — check your source-chain wallet.',
      });

      const stored = JSON.parse(localStorage.getItem(storageKey)!) as TransactionRecord[];
      expect(stored[0].bridgeAnnotation).toBe('refunding');
      expect(stored[0].status).toBe('pending');
    });
  });

  // ===========================================================================
  // EDGE CASES
  // ===========================================================================

  describe('Edge Cases', () => {
    beforeEach(() => {
      service.setWallet('0x1234567890123456789012345678901234567890');
    });

    it('should handle empty wallet address gracefully', () => {
      service.setWallet('');
      // Empty string is falsy, so should behave like null
      expect(service.transactions().length).toBe(0);
    });

    it('should handle updating without wallet', () => {
      service.setWallet(null);
      const result = service.updateTransaction('any-id', { status: 'success' });
      expect(result).toBeNull();
    });

    it('should handle deleting without wallet', () => {
      service.setWallet(null);
      const result = service.deleteTransaction('any-id');
      expect(result).toBe(false);
    });

    it('should handle clearHistory without wallet', () => {
      service.setWallet(null);
      // Should not throw
      expect(() => service.clearHistory()).not.toThrow();
    });

    it('should generate unique transaction IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const tx = service.addTransaction({ type: 'swap', status: 'success', chainId: 1 });
        ids.add(tx.id);
      }
      expect(ids.size).toBe(100);
    });
  });
});
