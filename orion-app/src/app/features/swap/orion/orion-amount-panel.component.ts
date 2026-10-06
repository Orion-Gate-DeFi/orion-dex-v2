/**
 * =============================================================================
 * ORION AMOUNT PANEL
 * =============================================================================
 *
 * One column of the horizontal swap card ("You're paying" / "You'll get").
 *
 * Paying side: editable input + percentage segmented control.
 * Receiving side: read-only display + "Best rate" chip.
 *
 * Dumb component — emits amountChange / tokenSelect / percentPick.
 *
 * @author Orion DEX Team
 * @version 1.0.0
 */

import {
  Component,
  ChangeDetectionStrategy,
  Input,
  Output,
  EventEmitter,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Token } from '../../../core/models/token.model';
import { OrionTokenPillComponent } from './orion-token-pill.component';

type PanelKind = 'pay' | 'get';

@Component({
  selector: 'app-orion-amount-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, OrionTokenPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel">
      <header>
        <div class="label-group">
          <span class="orion-label">{{ kind === 'pay' ? "You're paying" : "You'll get" }}</span>

          <!-- $ / token entry toggle (pay side only). Shows the CURRENT unit so
               the field's meaning is always legible; the icon implies "flip".
               Hidden until a price is known (canToggleMode) — without one we
               can't convert dollars to a token amount. -->
          @if (kind === 'pay' && canToggleMode) {
            <button
              type="button"
              class="mode-toggle"
              (click)="toggleMode.emit()"
              [attr.aria-label]="inputMode === 'usd' ? 'Switch to entering the token amount' : 'Switch to entering a dollar amount'"
            >
              <span class="material-symbols-outlined" aria-hidden="true">swap_vert</span>
              <span>{{ inputMode === 'usd' ? 'USD' : (token?.symbol || 'Token') }}</span>
            </button>
          }
        </div>

        @if (kind === 'pay' && showPercents) {
          <div class="orion-seg">
            @for (p of percents; track p) {
              <!-- aria-pressed: the active segment was conveyed by colour
                   only — invisible to screen readers. -->
              <button
                type="button"
                [class.active]="activePercent === p"
                [attr.aria-pressed]="activePercent === p"
                (click)="percentPick.emit(p)"
              >
                {{ p === 100 ? 'MAX' : p + '%' }}
              </button>
            }
          </div>
        }

      </header>

      <div class="amount">
        @if (kind === 'pay') {
          <div class="pay-input">
            @if (inputMode === 'usd') {
              <span class="pay-prefix" aria-hidden="true">$</span>
            }
            <input
              type="text"
              inputmode="decimal"
              class="orion-amount-input"
              [attr.aria-label]="inputMode === 'usd' ? 'Amount in US dollars' : 'Amount to pay'"
              [ngModel]="amount"
              (ngModelChange)="amountChange.emit($event)"
              (keydown)="keydown.emit($event)"
              [placeholder]="inputMode === 'usd' ? '0.00' : '0.0'"
            />
          </div>
        } @else if (loading) {
          <!-- Skeleton shimmer while a quote is in flight — feels faster
               than a static "0.00" or a centred spinner. -->
          <div class="amount-skeleton orion-shimmer" aria-hidden="true"></div>
        } @else {
          <div class="orion-amount-input orion-tabular" aria-live="polite">
            {{ amount || '0.00' }}
          </div>
        }
        <div class="usd orion-tabular">
          @if (loading && kind === 'get') {
            <span class="usd-skeleton orion-shimmer" aria-hidden="true"></span>
          } @else {
            {{ usd }}
          }
        </div>

        <!-- Empty-state hint: replaces the silent "0.0" placeholder when no
             token is picked yet, so first-time users know where to start. -->
        @if (!token) {
          <div class="empty-hint">
            <span class="material-symbols-outlined" aria-hidden="true">arrow_downward</span>
            <span>{{ kind === 'pay' ? 'Pick a token to start' : 'Pick a token to receive' }}</span>
          </div>
        }
      </div>

      <footer>
        <app-orion-token-pill
          [token]="token"
          (select)="tokenSelect.emit()"
        />

        @if (token && showBalance) {
          <div class="balance">
            Balance:
            <span class="orion-tabular value">
              {{ balance | number:'1.2-4' }} {{ token.symbol }}
            </span>
          </div>
        }
      </footer>
    </div>
  `,
  styles: [`
    :host { display: block; }

    .panel {
      padding: 26px 28px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      min-height: 240px;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      // Reserve the segmented control's height (button 40px + 3px pad +
      // 1px border, top & bottom = 48px) on BOTH panels, so the pay side
      // gaining the percent row never shifts its amount/footer rows out of
      // line with the get side's. Overridden in the phone grid below, where
      // the panels stack vertically and cross-panel alignment is moot.
      min-height: 48px;
    }

    .label-group {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .mode-toggle {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
      color: var(--orion-accent-text);
      background: var(--orion-accent-tint);
      transition: opacity 0.15s ease;
    }
    .mode-toggle:hover { opacity: 0.82; }
    .mode-toggle .material-symbols-outlined { font-size: 13px; }

    .amount { display: flex; flex-direction: column; gap: 4px; min-width: 0; }

    // Pay-side input row: the optional "$" prefix sits on the amount's
    // baseline so USD mode reads as a dollar field at a glance.
    .pay-input { display: flex; align-items: baseline; gap: 2px; min-width: 0; }
    .pay-prefix {
      font-family: var(--orion-font-display);
      font-size: 40px;
      font-weight: 600;
      letter-spacing: -0.02em;
      line-height: 1;
      color: var(--orion-muted);
    }

    // Read-only "You'll get" value: a pathological full-precision amount
    // (18-decimal formatUnits output) must truncate with an ellipsis rather
    // than push the token pill or escape the card. Scoped to the div so the
    // editable input variant is untouched.
    div.orion-amount-input {
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .usd {
      font-size: 13px;
      color: var(--orion-muted);
    }
    .empty-hint {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 500;
      width: fit-content;
      background: var(--orion-accent-tint);
      color: var(--orion-accent-text);
    }
    .empty-hint .material-symbols-outlined {
      font-size: 14px;
    }
    .amount-skeleton {
      height: 48px;
      width: 60%;
      border-radius: 8px;
    }
    .usd-skeleton {
      display: inline-block;
      height: 14px;
      width: 70px;
      border-radius: 4px;
      vertical-align: middle;
    }

    footer {
      margin-top: auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .balance {
      font-size: 12px;
      color: var(--orion-muted);
      /* "Balance: 12345.6789 LONGSYMBOL" must truncate, not push its row
         (flex footer on desktop, the panel grid on phones) past the card. */
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .balance .value { color: var(--orion-text); }

    // Phones: classic vertical-DEX panel anatomy — amount input and token
    // pill share one row, fiat value and balance share the next. Achieved
    // by flattening .amount/footer (display: contents) into one grid so
    // children can be placed across their original containers.
    @media (max-width: 719.98px) {
      .panel {
        min-height: 0;
        padding: 16px;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        column-gap: 12px;
        row-gap: 6px;
        align-items: center;
      }
      header { grid-column: 1 / -1; min-height: 0; }
      .amount, footer { display: contents; }

      .orion-amount-input,
      .amount-skeleton { grid-column: 1; grid-row: 2; font-size: 32px; }
      // The pay input is wrapped in .pay-input (for the "$" prefix), so the
      // wrapper — not the bare input — is the grid item here.
      .pay-input { grid-column: 1; grid-row: 2; min-width: 0; }
      .pay-prefix { font-size: 32px; }
      app-orion-token-pill { grid-column: 2; grid-row: 2; justify-self: end; }
      .usd { grid-column: 1; grid-row: 3; }
      .balance {
        grid-column: 2; grid-row: 3; justify-self: end; white-space: nowrap;
        /* The auto grid column sizes to max-content, which defeats the base
           rule's ellipsis (the track just widens to fit nowrap text). Cap
           the item itself — a fixed ch cap stays predictable across phone
           widths, unlike vw, and the column 1 input keeps its minmax(0,1fr)
           share — so "Balance: 12345.6789 LONGSYMBOL" actually truncates. */
        max-width: 24ch;
      }
      .empty-hint { grid-column: 1 / -1; margin-top: 0; }

      // Uniswap-style restraint: balance + MAX is enough on a phone.
      .orion-seg button:not(:last-child) { display: none; }
    }
  `],
})
export class OrionAmountPanelComponent {
  @Input() kind: PanelKind = 'pay';
  @Input() token: Token | null = null;
  @Input() amount: string = '';
  @Input() usd: string = '$0.00';
  @Input() balance: number = 0;
  @Input() showBalance: boolean = false;
  @Input() showPercents: boolean = false;
  @Input() activePercent: number | null = null;
  /** Show shimmer skeleton instead of "0.00" while a quote is in flight. */
  @Input() loading: boolean = false;
  /** Pay side: whether the field reads as a token amount or a USD amount. */
  @Input() inputMode: 'token' | 'usd' = 'token';
  /** Pay side: show the $/token toggle (parent gates on a known price). */
  @Input() canToggleMode: boolean = false;

  @Output() amountChange = new EventEmitter<string>();
  @Output() keydown = new EventEmitter<KeyboardEvent>();
  @Output() tokenSelect = new EventEmitter<void>();
  @Output() percentPick = new EventEmitter<number>();
  /** Pay side: user tapped the $/token toggle. */
  @Output() toggleMode = new EventEmitter<void>();

  readonly percents: readonly number[] = [25, 50, 100];
}
