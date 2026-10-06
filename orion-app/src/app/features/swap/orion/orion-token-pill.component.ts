/**
 * =============================================================================
 * ORION TOKEN PILL
 * =============================================================================
 *
 * Rounded token selector button used inside the horizontal swap card.
 * Shows token glyph + network badge, symbol, network name, and a chevron.
 *
 * Dumb presentational component — emits `select` when clicked.
 *
 * @author Orion DEX Team
 * @version 1.0.0
 */

import { Component, ChangeDetectionStrategy, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Token } from '../../../core/models/token.model';
import { getNetworkName, getNetworkLogo } from '../../../core/constants';
import { replaceWithLetterIcon } from '../../../core/utils/token-icon';

@Component({
  selector: 'app-orion-token-pill',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="token-pill"
      (click)="select.emit()"
    >
      @if (token) {
        <span class="glyph">
          <img [src]="token.logoURI" [alt]="token.symbol" (error)="onImageError($event)">
          <img class="chain" [src]="networkLogo" [alt]="networkName" (error)="onImageError($event)">
        </span>
        <span class="meta">
          <span class="sym">{{ token.symbol }}</span>
          <span class="net">on {{ networkName }}</span>
        </span>
      } @else {
        <span class="meta">
          <span class="sym placeholder">Select token</span>
        </span>
      }
      <span class="material-symbols-outlined chev" aria-hidden="true">expand_more</span>
    </button>
  `,
  styles: [`
    :host { display: inline-flex; }

    .token-pill {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 6px 12px 6px 6px;
      border-radius: var(--orion-radius-chip);
      background: var(--orion-surface-3);
      border: 1px solid var(--orion-border-strong);
      color: var(--orion-text);
      transition: background 120ms ease;
    }
    .token-pill:hover { background: var(--orion-border-strong); }

    .glyph {
      position: relative;
      width: 28px;
      height: 28px;
    }
    .glyph img {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      background: #fff;
      object-fit: cover;
    }
    .glyph .chain {
      position: absolute;
      right: -2px;
      bottom: -2px;
      width: 14px;
      height: 14px;
      border-radius: 999px;
      border: 1.5px solid var(--orion-surface-3);
      background: var(--orion-surface);
    }

    .meta {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      line-height: 1.1;
    }
    .sym {
      font-size: 14px;
      font-weight: 600;
      color: var(--orion-text);
      /* Long-tail symbols run 10-20 chars; uncapped they inflate the pill
         and squeeze the amount column out of the panel grid on phones. */
      max-width: 12ch;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sym.placeholder { color: var(--orion-accent-text); }
    .net {
      margin-top: 2px;
      font-size: 11px;
      color: var(--orion-muted);
    }

    .chev {
      font-size: 16px !important;
      color: var(--orion-muted);
      margin-left: 2px;
    }
  `],
})
export class OrionTokenPillComponent {
  @Input() token: Token | null = null;
  @Output() select = new EventEmitter<void>();

  get networkName(): string {
    return this.token ? getNetworkName(this.token.chainId) : '';
  }

  get networkLogo(): string {
    return this.token ? getNetworkLogo(this.token.chainId) : '';
  }

  onImageError(event: Event): void {
    replaceWithLetterIcon(event);
  }
}
