/**
 * =============================================================================
 * ORION SWAP CENTER
 * =============================================================================
 *
 * Middle column of the horizontal swap card: flip-direction button,
 * current rate, refresh button, and aggregator attribution.
 *
 * Rate text uses two lines per the design:
 *   "1 ETH"
 *   "= 1,900.00 USDC"
 *
 * @author Orion DEX Team
 * @version 1.0.0
 */

import { Component, ChangeDetectionStrategy, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-orion-swap-center',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="center">
      <button
        type="button"
        class="flip"
        aria-label="Flip swap direction"
        [disabled]="!canFlip"
        (click)="flip.emit()"
      >
        <span class="material-symbols-outlined" aria-hidden="true">swap_horiz</span>
      </button>

      <div class="rate">
        <div class="orion-label">Rate</div>
        @if (fromSymbol && toSymbol && rate > 0) {
          <div class="rate-text orion-tabular">
            <span class="l1">1 {{ fromSymbol }}</span>
            <span class="eq">=</span> {{ rate | number:'1.2-6' }} {{ toSymbol }}
          </div>
        } @else {
          <div class="rate-text muted">—</div>
        }
        <button
          type="button"
          class="orion-btn-icon refresh"
          aria-label="Refresh exchange rate"
          [disabled]="!canRefresh"
          (click)="refresh.emit()"
        >
          <span
            class="material-symbols-outlined"
            [class.orion-spin]="spinning"
            aria-hidden="true"
          >refresh</span>
        </button>
      </div>

      @if (providerLabel) {
        <div class="provider">{{ providerLabel }}</div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }

    .center {
      padding: 26px 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      height: 100%;
    }

    .flip {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--orion-surface-3);
      border: 1px solid var(--orion-border-strong);
      color: var(--orion-text);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 160ms ease, border-color 160ms ease;
    }
    .flip:hover:not(:disabled) {
      background: var(--orion-accent);
      border-color: var(--orion-accent);
    }
    .flip:disabled { opacity: 0.5; cursor: not-allowed; }
    .flip .material-symbols-outlined { font-size: 22px; }

    .rate { text-align: center; }

    .rate-text {
      font-size: 13.5px;
      font-weight: 500;
      line-height: 1.35;
      color: var(--orion-text);
      margin-top: 6px;
    }
    .rate-text.muted { color: var(--orion-subtle); }
    .rate-text .eq { color: var(--orion-muted); font-weight: 400; }
    // Two lines on the desktop column ("1 ETH" / "= 1,900.00 USDC"),
    // one line in the compact stacked bar.
    .rate-text .l1 { display: block; }

    .refresh {
      margin-top: 6px;
      width: 32px;
      height: 32px;
      color: var(--orion-accent-text);
    }
    .refresh .material-symbols-outlined { font-size: 16px; }

    // Refreshing a stale quote is a frequent action on phones — give it a
    // real touch target there (44px guideline).
    @media (pointer: coarse) {
      .refresh { width: 40px; height: 40px; }
    }

    .provider {
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.02em;
      color: var(--orion-subtle);
    }

    // Stacked (vertical) mode: the centre column becomes a compact
    // horizontal bar between the two amount panels instead of a 240px-tall
    // card holding a lone button. The flip glyph rotates so the arrows
    // point along the new (vertical) swap direction.
    @media (max-width: 1023.98px) {
      .center {
        flex-direction: row;
        justify-content: flex-start;
        gap: 16px;
        padding: 12px 16px;
        height: auto;
      }
      .flip { width: 48px; height: 48px; flex: none; }
      .flip .material-symbols-outlined { transform: rotate(90deg); }
      .rate {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        text-align: left;
      }
      .rate .orion-label { display: none; }
      .rate-text { margin-top: 0; }
      .rate-text .l1 { display: inline; margin-right: 4px; }
      .refresh { margin-top: 0; flex: none; }
      .provider { display: none; }
    }
  `],
})
export class OrionSwapCenterComponent {
  @Input() fromSymbol: string | null = null;
  @Input() toSymbol: string | null = null;
  @Input() rate: number = 0;
  @Input() canFlip: boolean = true;
  @Input() canRefresh: boolean = false;
  @Input() spinning: boolean = false;
  @Input() providerLabel: string | null = null;

  @Output() flip = new EventEmitter<void>();
  @Output() refresh = new EventEmitter<void>();
}
