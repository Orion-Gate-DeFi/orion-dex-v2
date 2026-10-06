/**
 * =============================================================================
 * TRANSACTION HISTORY COMPONENT
 * =============================================================================
 *
 * Displays user's transaction history with filtering and status tracking.
 * Used in Dashboard and can be embedded anywhere.
 *
 * Features:
 * - Shows recent swaps, sends, and approves
 * - Real-time status updates
 * - Links to block explorers
 * - Empty state for new users
 *
 * @author Orion DEX Team
 * @version 2.3.0 — re-check pending records when the panel becomes visible
 *                  (throttled rehydration pass) with a subtle header hint;
 *                  previously they only re-checked on app start / wallet
 *                  switch, so a record that missed its live tracking window
 *                  stayed "pending" until a full reload.
 */

import { Component, inject, computed, Input, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  TransactionHistoryService,
  TransactionRecord,
  TransactionType,
  TransactionStatus,
} from '../../../core/services/transaction-history.service';
import { TransactionRehydrationService } from '../../../core/services/transaction-rehydration.service';
import { FocusTrapDirective } from '../../directives/focus-trap.directive';
import { getExplorerTxUrl, getNetworkLogo, getNetworkName } from '../../../core/constants';

@Component({
    selector: 'app-transaction-history',
    standalone: true,
    imports: [CommonModule, FocusTrapDirective],
    template: `
    <div class="transaction-history orion-card">
      <!-- Header -->
      <div class="history-header">
        <div class="history-title-group">
          <h3 class="history-title">Activity</h3>
          <!-- Only meaningful while there is something pending to re-check;
               without the pendingCount gate it would flash on every visit. -->
          @if (isRechecking() && pendingCount() > 0) {
            <span class="checking-hint">Checking pending…</span>
          }
        </div>
        @if (hasTransactions()) {
          <button
            class="orion-btn-icon clear-btn"
            (click)="clearHistory()"
            title="Clear history"
            aria-label="Clear history">
            <span class="material-symbols-outlined" aria-hidden="true">delete_sweep</span>
          </button>
        }
      </div>

      <!-- Transaction List -->
      @if (displayTransactions().length > 0) {
        <div class="transaction-list" [class.expanded]="showAll()" [class.has-scroll]="showAll() && displayTransactions().length > 5">
          @for (tx of displayTransactions(); track tx.id) {
            <div class="transaction-item" [class]="tx.status">
              <!-- Left: Icon & Info -->
              <div class="tx-left">
                <!-- Type Icon -->
                <div class="tx-icon" [class]="tx.type">
                  <span class="material-symbols-outlined" aria-hidden="true">{{ getTypeIcon(tx.type) }}</span>
                  <!-- Status indicator -->
                  @if (tx.status === 'pending') {
                    <div class="status-dot pending"></div>
                  } @else if (tx.status === 'failed') {
                    <div class="status-dot failed"></div>
                  }
                </div>

                <!-- Transaction Info -->
                <div class="tx-info">
                  <div class="tx-title">
                    @if (tx.type === 'swap' && tx.fromToken && tx.toToken) {
                      {{ tx.fromToken.symbol }} → {{ tx.toToken.symbol }}
                    } @else if (tx.type === 'send' && tx.fromToken) {
                      Send {{ tx.fromToken.symbol }}
                    } @else if (tx.type === 'approve' && tx.fromToken) {
                      Approve {{ tx.fromToken.symbol }}
                    } @else {
                      {{ getTypeLabel(tx.type) }}
                    }
                  </div>
                  <div class="tx-meta">
                    <img [src]="getNetworkLogo(tx.chainId)" [alt]="getNetworkName(tx.chainId)" class="chain-icon">
                    <span class="tx-time">{{ formatTime(tx.timestamp) }}</span>
                    @if (tx.status === 'pending') {
                      <span class="tx-status pending">Pending</span>
                    } @else if (tx.status === 'failed') {
                      <span class="tx-status failed">Failed</span>
                    }
                  </div>
                  <!-- Why it failed / what to check. Covers failed records
                       and pending bridges annotated by interrupted tracking
                       (refunding / needs_gas) — a bare badge hides the one
                       line the user actually needs. -->
                  @if (tx.errorMessage && tx.status !== 'success') {
                    <div class="tx-note">{{ tx.errorMessage }}</div>
                  }
                </div>
              </div>

              <!-- Right: Amount & Link -->
              <div class="tx-right">
                @if (tx.type === 'swap' && tx.fromToken && tx.toToken) {
                  <div class="tx-amounts orion-tabular">
                    <span class="amount-out">-{{ formatAmount(tx.fromToken.amount) }}</span>
                    <span class="amount-in">+{{ formatAmount(tx.toToken.amount) }}</span>
                  </div>
                } @else if (tx.type === 'send' && tx.fromToken) {
                  <div class="tx-amounts orion-tabular">
                    <span class="amount-out">-{{ formatAmount(tx.fromToken.amount) }}</span>
                  </div>
                } @else if (tx.type === 'approve' && tx.fromToken) {
                  <div class="tx-amounts">
                    <span class="amount-approve">Approved</span>
                  </div>
                }

                @if (tx.txHash) {
                  <a
                    [href]="getExplorerUrl(tx.chainId, tx.txHash)"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="orion-btn-icon explorer-link"
                    title="View on explorer"
                    aria-label="View transaction on block explorer">
                    <span class="material-symbols-outlined" aria-hidden="true">open_in_new</span>
                  </a>
                }
              </div>
            </div>
          }
        </div>

        @if (transactions().length > limit) {
          <button class="view-all-btn" (click)="toggleShowAll()">
            @if (showAll()) {
              Show less
            } @else {
              View all ({{ transactions().length }})
            }
          </button>
        }
      } @else {
        <!-- Empty State -->
        <div class="empty-state">
          <span class="material-symbols-outlined empty-icon" aria-hidden="true">receipt_long</span>
          <p>No transactions yet</p>
          <span class="empty-hint">Your swap and send history will appear here</span>
        </div>
      }
    </div>

    <!-- Clear-history confirmation modal (design-system idiom — never the
         native confirm()). Pending records are deleted along with the rest,
         so the copy calls that out explicitly instead of dropping them
         silently. -->
    @if (showClearConfirm()) {
      <div class="orion-backdrop" (click)="cancelClearHistory()"></div>
      <div class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4 pointer-events-none">
        <div
          class="orion-modal orion-scale-in w-full max-w-[420px] pointer-events-auto overflow-y-auto"
          style="max-height: 85vh; max-height: 85dvh;"
          role="dialog"
          aria-modal="true"
          aria-labelledby="clear-history-title"
          orionFocusTrap
          (keydown.escape)="cancelClearHistory()"
        >
          <header class="flex items-center gap-3 px-5 py-4 border-b border-[var(--orion-border)]">
            <span class="material-symbols-outlined text-[20px]" style="color: var(--orion-danger);" aria-hidden="true">delete_sweep</span>
            <h2 id="clear-history-title" class="text-[15px] font-semibold flex-1 m-0" style="color: var(--orion-text);">Clear activity history?</h2>
          </header>

          <div class="p-5 space-y-4">
            <p class="text-[13px] leading-relaxed m-0" style="color: var(--orion-muted);">
              This removes all {{ transactions().length }} records from this device. Your on-chain transactions are not affected.
            </p>

            @if (pendingCount() > 0) {
              <div class="flex items-start gap-2 rounded-[14px] p-3" style="background: var(--orion-warning-tint);">
                <span class="material-symbols-outlined text-[16px] mt-0.5" style="color: var(--orion-warning);" aria-hidden="true">warning</span>
                <p class="text-[12px] leading-relaxed m-0" style="color: var(--orion-warning);">
                  {{ pendingCount() === 1 ? '1 pending transaction' : pendingCount() + ' pending transactions' }} will disappear from this list too — they keep processing on-chain, but you won't see status updates here.
                </p>
              </div>
            }

            <div class="flex gap-3 pt-1">
              <button
                type="button"
                class="orion-btn-ghost flex-1"
                (click)="cancelClearHistory()"
              >
                Cancel
              </button>
              <button
                type="button"
                class="orion-btn-primary flex-1"
                style="background: var(--orion-danger);"
                (click)="confirmClearHistory()"
              >
                Clear history
              </button>
            </div>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .transaction-history {
      padding: 20px;
    }

    .history-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.75rem;
    }

    .history-title-group {
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
      min-width: 0;
    }

    .history-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--orion-text);
      margin: 0;
    }

    /* On-demand re-check hint — informational, so keep it at whisper level */
    .checking-hint {
      font-size: 11px;
      color: var(--orion-subtle);
      white-space: nowrap;
    }

    /* Destructive action: hover flips the shared icon-button to danger tint */
    .clear-btn:hover {
      background: var(--orion-danger-tint);
      color: var(--orion-danger);
    }

    .clear-btn .material-symbols-outlined {
      font-size: 18px;
    }

    .transaction-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin-top: 16px;
    }

    .transaction-list.expanded.has-scroll {
      max-height: 320px;
      overflow-y: auto;
      padding-right: 4px;
    }

    .transaction-list.expanded.has-scroll::-webkit-scrollbar {
      width: 4px;
    }

    .transaction-list.expanded.has-scroll::-webkit-scrollbar-track {
      background: var(--orion-surface-2);
      border-radius: 2px;
    }

    .transaction-list.expanded.has-scroll::-webkit-scrollbar-thumb {
      background: var(--orion-border-strong);
      border-radius: 2px;
    }

    .transaction-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem;
      background: var(--orion-surface-2);
      border: 1px solid transparent;
      border-radius: 14px;
      transition: background 160ms ease;
    }

    .transaction-item:hover {
      background: var(--orion-surface-3);
    }

    .transaction-item.failed {
      background: var(--orion-danger-tint);
    }

    .transaction-item.pending {
      background: var(--orion-warning-tint);
    }

    .tx-left {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-width: 0;
      flex: 1;
    }

    .tx-icon {
      position: relative;
      width: 32px;
      height: 32px;
      min-width: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background: var(--orion-surface-3);
      color: var(--orion-muted);
    }

    .tx-icon.swap,
    .tx-icon.send {
      background: var(--orion-accent-tint);
      color: var(--orion-accent-text);
    }

    .tx-icon.receive {
      background: var(--orion-success-tint);
      color: var(--orion-success);
    }

    .tx-icon.approve {
      background: var(--orion-warning-tint);
      color: var(--orion-warning);
    }

    .tx-icon .material-symbols-outlined {
      font-size: 16px;
    }

    .status-dot {
      position: absolute;
      bottom: -2px;
      right: -2px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 2px solid var(--orion-surface);
    }

    .status-dot.pending {
      background: var(--orion-warning);
      animation: pulse 1.5s ease-in-out infinite;
    }

    .status-dot.failed {
      background: var(--orion-danger);
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .tx-info {
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
      min-width: 0;
    }

    .tx-title {
      font-size: 13px;
      font-weight: 500;
      color: var(--orion-text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .tx-meta {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      font-size: 11px;
      color: var(--orion-subtle);
    }

    .chain-icon {
      width: 12px;
      height: 12px;
      border-radius: 50%;
    }

    .tx-status {
      padding: 0.125rem 0.375rem;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .tx-status.pending {
      background: var(--orion-warning-tint);
      color: var(--orion-warning);
    }

    .tx-status.failed {
      background: var(--orion-danger-tint);
      color: var(--orion-danger);
    }

    /* Secondary explanation line (TransactionRecord.errorMessage) */
    .tx-note {
      font-size: 11px;
      color: var(--orion-muted);
      line-height: 1.4;
      overflow-wrap: anywhere;
    }

    .tx-right {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-shrink: 0;
    }

    .tx-amounts {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 0;
    }

    .amount-out {
      font-size: 12px;
      font-weight: 500;
      color: var(--orion-muted);
    }

    .amount-in {
      font-size: 12px;
      font-weight: 500;
      color: var(--orion-success);
    }

    .amount-approve {
      font-size: 12px;
      font-weight: 500;
      color: var(--orion-warning);
    }

    /* Shared icon button shrunk to fit the row height */
    .explorer-link {
      width: 28px;
      height: 28px;
      background: var(--orion-surface-3);
      text-decoration: none;
    }

    .explorer-link:hover {
      background: var(--orion-accent-tint);
      color: var(--orion-accent-text);
    }

    .explorer-link .material-symbols-outlined {
      font-size: 14px;
    }

    .view-all-btn {
      width: 100%;
      margin-top: 0.75rem;
      padding: 0.625rem;
      background: var(--orion-surface-2);
      border: 1px solid var(--orion-border);
      border-radius: 14px;
      color: var(--orion-muted);
      font-size: 13px;
      cursor: pointer;
      transition: background 160ms ease, color 160ms ease;
    }

    .view-all-btn:hover {
      background: var(--orion-surface-3);
      color: var(--orion-text);
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 1.5rem 0.75rem;
      text-align: center;
    }

    .empty-icon {
      font-size: 36px;
      color: var(--orion-subtle);
      margin-bottom: 0.5rem;
    }

    .empty-state p {
      margin: 0;
      font-size: 13px;
      color: var(--orion-muted);
      font-weight: 500;
    }

    .empty-hint {
      margin-top: 0.25rem;
      font-size: 11px;
      color: var(--orion-subtle);
    }
  `]
})
export class TransactionHistoryComponent implements OnInit {
  private txHistoryService = inject(TransactionHistoryService);
  private rehydration = inject(TransactionRehydrationService);

  @Input() limit = 5;
  showAll = signal(false);

  /** Clear-history confirmation modal visibility. */
  showClearConfirm = signal(false);

  readonly transactions = this.txHistoryService.transactions;

  /** True while the on-demand pending re-check runs — drives the header hint. */
  readonly isRechecking = this.rehydration.isRechecking;

  ngOnInit(): void {
    // The dashboard route re-instantiates this component on every visit, so
    // init ≙ "panel became visible". Fire-and-forget: resolved records flip
    // through the history signals; on failure they simply stay pending
    // (the service throttles rapid re-visits itself).
    void this.rehydration.rehydratePendingNow();
  }

  readonly hasTransactions = computed(() => this.transactions().length > 0);

  /** Pending records that a clear would also delete — surfaced in the modal. */
  readonly pendingCount = computed(() => this.txHistoryService.pendingTransactions().length);

  readonly displayTransactions = computed(() => {
    const txs = this.transactions();
    if (this.showAll()) {
      // Show all items with scrollable container
      return txs;
    }
    return txs.slice(0, this.limit);
  });

  getTypeIcon(type: TransactionType): string {
    return this.txHistoryService.getTypeIcon(type);
  }

  getTypeLabel(type: TransactionType): string {
    return this.txHistoryService.getTypeLabel(type);
  }

  formatTime(timestamp: number): string {
    return this.txHistoryService.formatRelativeTime(timestamp);
  }

  formatAmount(amount: string): string {
    const num = parseFloat(amount);
    if (num >= 1000) {
      return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }
    if (num >= 1) {
      return num.toFixed(4);
    }
    return num.toFixed(6);
  }

  formatUSD(value: number): string {
    return `$${value.toFixed(2)}`;
  }

  getExplorerUrl(chainId: number, txHash: string): string {
    return getExplorerTxUrl(chainId, txHash);
  }

  getNetworkLogo = getNetworkLogo;
  getNetworkName = getNetworkName;

  toggleShowAll(): void {
    this.showAll.set(!this.showAll());
  }

  /** Header button — opens the design-system confirmation modal. */
  clearHistory(): void {
    this.showClearConfirm.set(true);
  }

  cancelClearHistory(): void {
    this.showClearConfirm.set(false);
  }

  confirmClearHistory(): void {
    this.txHistoryService.clearHistory();
    this.showClearConfirm.set(false);
  }
}
