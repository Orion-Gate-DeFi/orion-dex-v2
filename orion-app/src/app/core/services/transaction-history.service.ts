/**
 * =============================================================================
 * TRANSACTION HISTORY SERVICE
 * =============================================================================
 *
 * Manages transaction history using localStorage.
 * Stores swap, send, and receive transactions for quick access.
 *
 * Features:
 * - Persistent storage in localStorage
 * - Per-wallet history (isolated by address)
 * - Auto-cleanup of old transactions (keeps last 100)
 * - Real-time updates via signals
 *
 * @author Orion DEX Team
 * @version 1.3.0 — bridgeAnnotation on interrupted bridge tracking; the
 *                  stale-pending normalization now honors it (refunding →
 *                  failed, needs_gas → stays pending).
 */

import { Injectable, signal, computed } from '@angular/core';

// =============================================================================
// TYPES
// =============================================================================

export type TransactionType = 'swap' | 'send' | 'receive' | 'approve';
export type TransactionStatus = 'pending' | 'success' | 'failed';

export interface TokenInfo {
  symbol: string;
  name?: string;
  address: string;
  chainId: number;
  amount: string;
  amountUSD?: number;
  logoURI?: string;
}

export interface TransactionRecord {
  /** Unique ID (timestamp + random) */
  id: string;
  /** Transaction type */
  type: TransactionType;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Current status */
  status: TransactionStatus;
  /** Source token (for swap/send) */
  fromToken?: TokenInfo;
  /** Destination token (for swap/receive) */
  toToken?: TokenInfo;
  /** Recipient address (for send) */
  toAddress?: string;
  /** Sender address (for receive) */
  fromAddress?: string;
  /** Transaction hash on blockchain */
  txHash?: string;
  /** Chain ID where tx was executed */
  chainId: number;
  /** Error message if failed */
  errorMessage?: string;
  /** LI.FI route tool used */
  tool?: string;
  /** Gas used in USD */
  gasUSD?: number;
  /**
   * Winning aggregator for swap records (e.g. 'squid'). Persisted so a
   * future rehydration pass can resume bridge tracking via the backend
   * /swap/status dispatcher. Chain ids already live on fromToken/toToken.
   */
  aggregator?: string;
  /** Aggregator tracking id (Squid) — /swap/status `quote_id`. */
  trackingQuoteId?: string;
  /** Aggregator tracking id (Squid) — /swap/status `request_id`. */
  trackingRequestId?: string;
  /**
   * Last bridge status observed before in-session tracking stopped
   * (timed out / gave up) — written only for the warning states that must
   * change how a stale `pending` is later presented. `refunding`: the
   * user's funds were on their way back to the source chain, so the
   * stale-pending normalization presents the record as failed instead of
   * delivered. `needs_gas`: the transfer was stuck awaiting destination
   * gas — its terminal state is unknowable client-side, so the record
   * stays pending. The paired `errorMessage` carries the user-facing note.
   */
  bridgeAnnotation?: 'refunding' | 'needs_gas';
}

// =============================================================================
// CONSTANTS
// =============================================================================

const STORAGE_KEY_PREFIX = 'orion_tx_history_';
const MAX_TRANSACTIONS = 100;

/**
 * Fallback cap when the browser refuses our normal MAX_TRANSACTIONS write
 * (QuotaExceededError). Halving the list usually clears the wall — once
 * fits, the next add resumes the normal sliding window.
 */
const STORAGE_QUOTA_FALLBACK_LIMIT = 50;

/**
 * Age after which a still-pending cross-chain swap is presented as
 * delivered. The backend /swap/status dispatcher now tracks supported
 * aggregators live, but a `pending` record can still be left behind on the
 * fallback paths: the dispatcher doesn't support the route, tracking gave
 * up / timed out, or the tab closed mid-bridge. Without this cutoff a swap
 * that landed 5-30 minutes after signing would read as stuck money
 * forever. One hour is far past every supported bridge's delivery window.
 */
const UNTRACKED_BRIDGE_PENDING_MAX_AGE_MS = 60 * 60 * 1000;

// =============================================================================
// SERVICE
// =============================================================================

@Injectable({
  providedIn: 'root',
})
export class TransactionHistoryService {
  /** Current wallet address */
  private currentWallet = signal<string | null>(null);

  /** All transactions for current wallet */
  private _transactions = signal<TransactionRecord[]>([]);

  /** Public readonly transactions */
  readonly transactions = this._transactions.asReadonly();

  /** Recent transactions (last 10) */
  readonly recentTransactions = computed(() =>
    this._transactions().slice(0, 10)
  );

  /** Pending transactions */
  readonly pendingTransactions = computed(() =>
    this._transactions().filter(tx => tx.status === 'pending')
  );

  /** Has pending transactions */
  readonly hasPending = computed(() =>
    this.pendingTransactions().length > 0
  );

  /** Transaction count */
  readonly count = computed(() => this._transactions().length);

  // ---------------------------------------------------------------------------
  // Wallet Management
  // ---------------------------------------------------------------------------

  /**
   * Set current wallet and load its history
   */
  setWallet(address: string | null): void {
    if (address === this.currentWallet()) return;

    this.currentWallet.set(address);

    if (address) {
      this.loadFromStorage(address);
    } else {
      this._transactions.set([]);
    }
  }

  /**
   * Get current wallet address
   */
  getWallet(): string | null {
    return this.currentWallet();
  }

  // ---------------------------------------------------------------------------
  // Transaction Management
  // ---------------------------------------------------------------------------

  /**
   * Add a new transaction record
   */
  addTransaction(tx: Omit<TransactionRecord, 'id' | 'timestamp'>): TransactionRecord {
    const wallet = this.currentWallet();
    if (!wallet) {
      console.warn('[TxHistory] No wallet set, cannot add transaction');
      throw new Error('No wallet connected');
    }

    const record: TransactionRecord = {
      ...tx,
      id: this.generateId(),
      timestamp: Date.now(),
    };

    const current = this._transactions();
    const updated = [record, ...current].slice(0, MAX_TRANSACTIONS);

    this._transactions.set(updated);
    this.saveToStorage(wallet, updated);

    return record;
  }

  /**
   * Update an existing transaction (e.g., pending -> success)
   */
  updateTransaction(
    id: string,
    updates: Partial<Pick<TransactionRecord, 'status' | 'txHash' | 'errorMessage' | 'bridgeAnnotation'>>
  ): TransactionRecord | null {
    const wallet = this.currentWallet();
    if (!wallet) return null;

    const current = this._transactions();
    const index = current.findIndex(tx => tx.id === id);

    if (index === -1) {
      console.warn('[TxHistory] Transaction not found:', id);
      return null;
    }

    const updated = [...current];
    updated[index] = { ...updated[index], ...updates };

    this._transactions.set(updated);
    this.saveToStorage(wallet, updated);

    return updated[index];
  }

  /**
   * Mark transaction as successful
   */
  markSuccess(id: string, txHash?: string): TransactionRecord | null {
    return this.updateTransaction(id, { status: 'success', txHash });
  }

  /**
   * Mark transaction as failed
   */
  markFailed(id: string, errorMessage?: string): TransactionRecord | null {
    return this.updateTransaction(id, { status: 'failed', errorMessage });
  }

  /**
   * Get transaction by ID
   */
  getTransaction(id: string): TransactionRecord | undefined {
    return this._transactions().find(tx => tx.id === id);
  }

  /**
   * Get transactions by type
   */
  getByType(type: TransactionType): TransactionRecord[] {
    return this._transactions().filter(tx => tx.type === type);
  }

  /**
   * Get transactions for a specific chain
   */
  getByChain(chainId: number): TransactionRecord[] {
    return this._transactions().filter(tx => tx.chainId === chainId);
  }

  /**
   * Clear all history for current wallet
   */
  clearHistory(): void {
    const wallet = this.currentWallet();
    if (!wallet) return;

    this._transactions.set([]);
    localStorage.removeItem(this.getStorageKey(wallet));
  }

  /**
   * Delete a specific transaction
   */
  deleteTransaction(id: string): boolean {
    const wallet = this.currentWallet();
    if (!wallet) return false;

    const current = this._transactions();
    const filtered = current.filter(tx => tx.id !== id);

    if (filtered.length === current.length) {
      return false; // Not found
    }

    this._transactions.set(filtered);
    this.saveToStorage(wallet, filtered);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Helper Methods for Creating Transactions
  // ---------------------------------------------------------------------------

  /**
   * Create a swap transaction record
   */
  createSwapTransaction(params: {
    fromToken: TokenInfo;
    toToken: TokenInfo;
    chainId: number;
    tool?: string;
    gasUSD?: number;
    aggregator?: string;
    trackingQuoteId?: string;
    trackingRequestId?: string;
  }): TransactionRecord {
    return this.addTransaction({
      type: 'swap',
      status: 'pending',
      fromToken: params.fromToken,
      toToken: params.toToken,
      chainId: params.chainId,
      tool: params.tool,
      gasUSD: params.gasUSD,
      aggregator: params.aggregator,
      trackingQuoteId: params.trackingQuoteId,
      trackingRequestId: params.trackingRequestId,
    });
  }

  /**
   * Create a send transaction record
   */
  createSendTransaction(params: {
    token: TokenInfo;
    toAddress: string;
    chainId: number;
  }): TransactionRecord {
    return this.addTransaction({
      type: 'send',
      status: 'pending',
      fromToken: params.token,
      toAddress: params.toAddress,
      chainId: params.chainId,
    });
  }

  /**
   * Create an approve transaction record
   */
  createApproveTransaction(params: {
    token: TokenInfo;
    chainId: number;
  }): TransactionRecord {
    return this.addTransaction({
      type: 'approve',
      status: 'pending',
      fromToken: params.token,
      chainId: params.chainId,
    });
  }

  // ---------------------------------------------------------------------------
  // Formatting Helpers
  // ---------------------------------------------------------------------------

  /**
   * Format timestamp as relative time (e.g., "5 min ago")
   */
  formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days}d ago`;

    return new Date(timestamp).toLocaleDateString();
  }

  /**
   * Format timestamp as time (e.g., "10:45 AM")
   */
  formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }

  /**
   * Get icon for transaction type
   */
  getTypeIcon(type: TransactionType): string {
    switch (type) {
      case 'swap': return 'swap_horiz';
      case 'send': return 'arrow_outward';
      case 'receive': return 'arrow_downward';
      case 'approve': return 'check_circle';
      default: return 'receipt';
    }
  }

  /**
   * Get label for transaction type
   */
  getTypeLabel(type: TransactionType): string {
    switch (type) {
      case 'swap': return 'Swapped';
      case 'send': return 'Sent';
      case 'receive': return 'Received';
      case 'approve': return 'Approved';
      default: return 'Transaction';
    }
  }

  /**
   * Get status color class
   */
  getStatusColor(status: TransactionStatus): string {
    switch (status) {
      case 'success': return 'text-emerald-400';
      case 'failed': return 'text-red-400';
      case 'pending': return 'text-yellow-400';
      default: return 'text-slate-400';
    }
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Generate unique transaction ID
   */
  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `${timestamp}-${random}`;
  }

  /**
   * Get localStorage key for wallet
   */
  private getStorageKey(address: string): string {
    return `${STORAGE_KEY_PREFIX}${address.toLowerCase()}`;
  }

  /**
   * Load transactions from localStorage. Records are sanitised before being
   * exposed to the UI: localStorage is user-writable, so without runtime
   * validation an attacker (or a stale schema migration) could inject
   * arbitrary objects and have them rendered as legitimate history.
   */
  private loadFromStorage(address: string): void {
    try {
      const key = this.getStorageKey(address);
      const data = localStorage.getItem(key);

      if (!data) {
        this._transactions.set([]);
        return;
      }

      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) {
        this._transactions.set([]);
        return;
      }

      const valid = parsed.filter((r): r is TransactionRecord => this.isValidRecord(r));
      this._transactions.set(valid.map((r) => this.presentStalePendingBridge(r)));
    } catch (error) {
      console.error('[TxHistory] Error loading from storage:', error);
      this._transactions.set([]);
    }
  }

  /**
   * Read-time normalization for bridge records nothing finalized in-session.
   * A cross-chain swap is recorded as `pending` and only a tracker verdict
   * flips it. The backend /swap/status dispatcher provides that verdict for
   * supported aggregators, but this fallback still catches records whose
   * tracking never concluded (unsupported route, tracker gave up / timed
   * out, tab closed mid-bridge). Past the cutoff the record is presented by
   * what was last known:
   *
   * - bare pending          → 'success'. The status model has no
   *   'sent (untracked)' slot and the history UI only badges
   *   pending/failed, so the existing success presentation is the minimal
   *   honest display change (it also drops the record out of
   *   `pendingTransactions`, sparing the rehydrator pointless LI.FI
   *   NOT_FOUND polls).
   * - annotated 'refunding' → 'failed'. A refund was in progress when
   *   tracking stopped: the user got their source tokens back, so claiming
   *   delivery would be a lie. The annotation's errorMessage explains the
   *   refund in the list.
   * - annotated 'needs_gas' → stays pending. The transfer may still
   *   complete after a gas top-up or end in a refund — neither delivery
   *   nor failure is provable client-side, so pending is the honest
   *   indeterminate presentation (the annotation note tells the user what
   *   to check).
   *
   * Mapping happens on load — stored data is not rewritten here. Same-chain
   * pendings are left untouched for TransactionRehydrationService to
   * resolve against the real receipt.
   */
  private presentStalePendingBridge(
    record: TransactionRecord,
    now: number = Date.now(),
  ): TransactionRecord {
    if (record.status !== 'pending' || record.type !== 'swap') return record;
    const fromChain = record.fromToken?.chainId;
    const toChain = record.toToken?.chainId;
    if (fromChain === undefined || toChain === undefined || fromChain === toChain) {
      return record;
    }
    if (now - record.timestamp < UNTRACKED_BRIDGE_PENDING_MAX_AGE_MS) return record;
    if (record.bridgeAnnotation === 'needs_gas') return record;
    if (record.bridgeAnnotation === 'refunding') return { ...record, status: 'failed' };
    return { ...record, status: 'success' };
  }

  /**
   * Runtime guard for stored records. Tolerant on optional fields, strict on
   * the ones we render unconditionally (id, type, status, timestamp, chainId)
   * — an undefined `status` would crash `getStatusColor`, an undefined `type`
   * would crash `getTypeIcon`, etc.
   */
  private isValidRecord(value: unknown): value is TransactionRecord {
    if (!value || typeof value !== 'object') return false;
    const r = value as Record<string, unknown>;
    if (typeof r['id'] !== 'string' || r['id'].length === 0) return false;
    if (typeof r['timestamp'] !== 'number' || !Number.isFinite(r['timestamp'])) return false;
    if (typeof r['chainId'] !== 'number' || !Number.isFinite(r['chainId'])) return false;
    if (r['type'] !== 'swap' && r['type'] !== 'send' && r['type'] !== 'receive' && r['type'] !== 'approve') return false;
    if (r['status'] !== 'pending' && r['status'] !== 'success' && r['status'] !== 'failed') return false;
    return true;
  }

  /**
   * Save transactions to localStorage. Recovers from QuotaExceededError by
   * pruning the in-memory list to a smaller cap and retrying once — without
   * this, a full localStorage silently swallows every subsequent transaction
   * write and the user loses history with no signal.
   */
  private saveToStorage(address: string, transactions: TransactionRecord[]): void {
    const key = this.getStorageKey(address);
    try {
      localStorage.setItem(key, JSON.stringify(transactions));
      return;
    } catch (error) {
      if (!this.isQuotaExceeded(error)) {
        console.error('[TxHistory] Error saving to storage:', error);
        return;
      }
    }

    // Quota path: shrink list, retry, give up gracefully on second failure.
    try {
      const trimmed = transactions.slice(0, STORAGE_QUOTA_FALLBACK_LIMIT);
      this._transactions.set(trimmed);
      localStorage.setItem(key, JSON.stringify(trimmed));
      console.warn(`[TxHistory] localStorage quota exceeded; pruned history to ${trimmed.length} records`);
    } catch (error) {
      console.error('[TxHistory] localStorage still full after prune — newest record kept in memory only:', error);
    }
  }

  /** Cross-browser quota detection: name, code, and DOMException all vary. */
  private isQuotaExceeded(error: unknown): boolean {
    if (!error) return false;
    const e = error as { name?: string; code?: number };
    return (
      e.name === 'QuotaExceededError' ||
      e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      e.code === 22 ||
      e.code === 1014
    );
  }
}
