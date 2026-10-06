/**
 * =============================================================================
 * ORION INFO STRIP
 * =============================================================================
 *
 * 5-cell strip below the swap card: network fee, minimum received,
 * price impact, timing, safety. Dividers between cells, single rounded
 * panel container.
 *
 * Receives a typed list of cells so callers can add / reorder without
 * touching this component.
 *
 * @author Orion DEX Team
 * @version 1.0.0
 */

import { Component, ChangeDetectionStrategy, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

export type InfoCellTone = 'neutral' | 'success' | 'warning' | 'danger' | 'muted';

export interface InfoCell {
  /** Stable identifier — used when the cell is clickable and emits an event. */
  id?: string;
  label: string;
  value: string;
  sub?: string;
  subTone?: InfoCellTone;
  tooltip?: boolean;
  /** Plain-language explanation surfaced via title attribute (and SR text). */
  tooltipText?: string;
  /** Cells that toggle an external detail panel (e.g. Safety → health details). */
  clickable?: boolean;
  /** When true, render the chevron as rotated so the user sees state. */
  expanded?: boolean;
  /** Rendered only in the phone layout (e.g. Rate, whose desktop home is
   *  the centre column that phones don't show). */
  mobileOnly?: boolean;
}

@Component({
  selector: 'app-orion-info-strip',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="strip orion-panel">
      @for (cell of cells; track cell.label; let first = $first) {
        @if (cell.clickable) {
          <button
            type="button"
            class="cell cell-button"
            [class.mobile-only]="cell.mobileOnly"
            [class.first]="first"
            [class.is-expanded]="cell.expanded"
            [attr.aria-expanded]="cell.expanded ?? false"
            (click)="onCellClick(cell)"
          >
            <div class="row">
              <span class="orion-label">{{ cell.label }}</span>
              <span
                class="material-symbols-outlined chev"
                [class.rotated]="cell.expanded"
                aria-hidden="true"
              >expand_more</span>
            </div>
            <div class="value orion-tabular">{{ cell.value }}</div>
            @if (cell.sub) {
              <div class="sub" [class]="'tone-' + (cell.subTone || 'muted')">
                {{ cell.sub }}
              </div>
            }
          </button>
        } @else {
          <!-- title includes the value: .value ellipsizes, and hover/long-press
               on the cell is the only way to recover the full figure. The
               clickable branch needs none — expanding reveals the details. -->
          <div
            class="cell"
            [class.first]="first"
            [class.mobile-only]="cell.mobileOnly"
            [attr.title]="cell.tooltipText ? cell.tooltipText + ' — ' + cell.value : cell.value"
          >
            <div class="row">
              <span class="orion-label">{{ cell.label }}</span>
              @if (cell.tooltip && cell.tooltipText) {
                <span class="material-symbols-outlined info" aria-hidden="true">info</span>
                <span class="sr-only">{{ cell.tooltipText }}</span>
              }
            </div>
            <div class="value orion-tabular">{{ cell.value }}</div>
            @if (cell.sub) {
              <div class="sub" [class]="'tone-' + (cell.subTone || 'muted')">
                {{ cell.sub }}
              </div>
            }
          </div>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; }

    .strip {
      display: flex;
      overflow: hidden;
    }

    .cell {
      flex: 1;
      /* Without min-width:0 a long unbreakable value (e.g. a full-precision
         "Minimum received") inflates the flex row past the container and the
         LAST cell — Safety, the risk disclosure — is silently clipped by the
         panel's overflow:hidden on 720-1023px viewports. */
      min-width: 0;
      padding: 14px 20px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      border-left: 1px solid var(--orion-border);
    }
    .cell.first { border-left: none; }

    .cell-button {
      background: transparent;
      text-align: left;
      cursor: pointer;
      transition: background 160ms ease;
    }
    .cell-button:hover { background: var(--orion-surface-2); }
    .cell-button.is-expanded { background: var(--orion-surface-2); }

    .row {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .info {
      font-size: 12px !important;
      color: var(--orion-subtle);
    }

    .chev {
      font-size: 14px !important;
      color: var(--orion-subtle);
      margin-left: auto;
      transition: transform 180ms ease;
    }
    .chev.rotated { transform: rotate(180deg); }

    .value {
      font-size: 14px;
      font-weight: 500;
      color: var(--orion-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sub {
      font-size: 11px;
      font-weight: 500;
    }
    .tone-neutral { color: var(--orion-text); }
    .tone-muted   { color: var(--orion-muted); }
    .tone-success { color: var(--orion-success); }
    .tone-warning { color: var(--orion-warning); }
    .tone-danger  { color: var(--orion-danger); }

    // Desktop/tablet: mobile-only cells stay out of the flex row.
    .cell.mobile-only { display: none; }

    // Phones: a single flex row clips cells behind overflow:hidden — which
    // silently hides minimum-received / price-impact / safety, i.e. the risk
    // disclosure. Switch to a 2-column grid; an odd last cell spans the row.
    @media (max-width: 719.98px) {
      .strip { display: grid; grid-template-columns: 1fr 1fr; }
      .cell {
        padding: 12px 16px;
        border-left: 1px solid var(--orion-border);
        border-top: 1px solid var(--orion-border);
      }
      .cell.mobile-only { display: flex; }
      .cell:nth-child(odd) { border-left: none; }
      .cell:nth-child(-n+2) { border-top: none; }
      .cell:last-child:nth-child(odd) { grid-column: 1 / -1; }
    }
  `],
})
export class OrionInfoStripComponent {
  @Input() cells: InfoCell[] = [];
  @Output() cellClick = new EventEmitter<string>();

  onCellClick(cell: InfoCell): void {
    if (cell.id) {
      this.cellClick.emit(cell.id);
    }
  }
}
