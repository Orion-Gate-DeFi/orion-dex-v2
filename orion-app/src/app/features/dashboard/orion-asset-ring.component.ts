/**
 * =============================================================================
 * ORION ASSET RING
 * =============================================================================
 *
 * Interactive donut showing the USD breakdown of portfolio assets, with the
 * total balance in the centre. Hovering (or tapping / focusing a legend row)
 * highlights a segment and swaps the centre read-out to that asset.
 *
 * Adaptive by construction: the SVG scales through its viewBox to whatever
 * width the parent gives it, and the centre type scales with container-query
 * units — no JS measurement.
 *
 * Colour: the categorical --orion-chart-* ramp (data-visualization carve-out
 * from the single-accent rule), with the trailing "Other" bucket in neutral
 * grey.
 *
 * Dumb component: parent supplies pre-aggregated segments + total.
 *
 * @author Orion DEX Team
 * @version 1.1.0 — categorical chart colours; defensive outline reset.
 */

import { Component, ChangeDetectionStrategy, Input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface RingSegment {
  /** Stable id ("ETH", "other") — used for hover/selection tracking. */
  id: string;
  label: string;
  value: number;
  logoURI?: string;
}

interface RingArc extends RingSegment {
  color: string;
  dasharray: string;
  dashoffset: number;
  share: number;
}

const RING_RADIUS = 80;
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/** Visual gap between segments, in circumference units. */
const SEGMENT_GAP = 3;

/** Categorical chart ramp from the design tokens; neutral tail = "Other". */
const SEGMENT_COLORS: readonly string[] = [
  'var(--orion-chart-1)',
  'var(--orion-chart-2)',
  'var(--orion-chart-3)',
  'var(--orion-chart-4)',
  'var(--orion-chart-5)',
  'var(--orion-chart-other)',
];

@Component({
  selector: 'app-orion-asset-ring',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="orion-ring-wrap">
      <div class="orion-ring" role="img" [attr.aria-label]="ariaSummary">
        <svg viewBox="0 0 200 200" aria-hidden="true">
          <!-- Track: keeps the ring visible for empty / single-asset states -->
          <circle
            cx="100" cy="100" [attr.r]="radius"
            fill="none"
            stroke="var(--orion-surface-3)"
            stroke-width="18"
          />
          @for (arc of arcs; track arc.id) {
            <circle
              class="seg"
              cx="100" cy="100" [attr.r]="radius"
              fill="none"
              [style.stroke]="arc.color"
              [attr.stroke-width]="activeId() === arc.id ? 24 : 18"
              [attr.stroke-dasharray]="arc.dasharray"
              [attr.stroke-dashoffset]="arc.dashoffset"
              [style.opacity]="activeId() && activeId() !== arc.id ? 0.35 : 1"
              transform="rotate(-90 100 100)"
              (mouseenter)="hovered.set(arc.id)"
              (mouseleave)="hovered.set(null)"
              (click)="toggleSticky(arc.id)"
            />
          }
        </svg>

        <!-- Centre read-out (HTML overlay: crisper text than SVG <text>) -->
        <div class="orion-ring-center">
          @if (activeArc; as arc) {
            <span class="center-label">{{ arc.label }}</span>
            <span class="center-value orion-tabular">{{ formatUsd(arc.value) }}</span>
            <span class="center-sub orion-tabular">{{ arc.share.toFixed(1) }}% of {{ caption }}</span>
          } @else {
            <span class="center-label">{{ caption }}</span>
            <span class="center-value orion-tabular">{{ formatUsd(total) }}</span>
            @if (arcs.length > 0) {
              <span class="center-sub">{{ segments.length }} asset{{ segments.length === 1 ? '' : 's' }}</span>
            }
          }
        </div>
      </div>

      <!-- Legend: the keyboard/SR path to the same information -->
      @if (arcs.length > 0) {
        <ul class="legend">
          @for (arc of arcs; track arc.id) {
            <li>
              <button
                type="button"
                class="legend-row"
                [class.dimmed]="activeId() !== null && activeId() !== arc.id"
                [attr.aria-pressed]="sticky() === arc.id"
                (mouseenter)="hovered.set(arc.id)"
                (mouseleave)="hovered.set(null)"
                (focus)="hovered.set(arc.id)"
                (blur)="hovered.set(null)"
                (click)="toggleSticky(arc.id)"
              >
                <span class="legend-dot" [style.background]="arc.color" aria-hidden="true"></span>
                <span class="legend-label">{{ arc.label }}</span>
                <span class="legend-value orion-tabular">{{ formatUsd(arc.value) }}</span>
                <span class="legend-share orion-tabular">{{ arc.share.toFixed(1) }}%</span>
              </button>
            </li>
          }
        </ul>
      }
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; }

    .orion-ring-wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      width: 100%;
    }

    .orion-ring {
      position: relative;
      width: 100%;
      max-width: 240px;
      aspect-ratio: 1 / 1;
    }
    // Defensive: nothing in or around the chart may ever draw a UA focus
    // rectangle or border — interaction focus lives on the legend buttons.
    .orion-ring, .orion-ring svg, .orion-ring svg * {
      outline: none !important;
      border: none;
    }
    svg { width: 100%; height: 100%; display: block; }

    .seg {
      cursor: pointer;
      transition: stroke-width 160ms ease, opacity 160ms ease;
    }

    .orion-ring-center {
      position: absolute;
      inset: 18%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      text-align: center;
      pointer-events: none;
    }
    .center-label {
      font-size: 11px;
      color: var(--orion-muted);
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .center-value {
      font-size: clamp(18px, 6vw, 26px);
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--orion-text);
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .center-sub {
      font-size: 10.5px;
      color: var(--orion-subtle);
    }

    .legend {
      list-style: none;
      margin: 0;
      padding: 0;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .legend-row {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 7px 10px;
      border-radius: 10px;
      font-size: 13px;
      color: var(--orion-text);
      background: transparent;
      transition: background 120ms ease, opacity 160ms ease;
      cursor: pointer;
    }
    .legend-row:hover { background: var(--orion-surface-2); }
    .legend-row.dimmed { opacity: 0.45; }

    .legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      flex: none;
    }
    .legend-label {
      flex: 1;
      min-width: 0;
      text-align: left;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
    }
    .legend-value { color: var(--orion-text); }
    .legend-share {
      color: var(--orion-muted);
      font-size: 12px;
      min-width: 44px;
      text-align: right;
    }
  `],
})
export class OrionAssetRingComponent {
  @Input() segments: RingSegment[] = [];
  @Input() total: number = 0;
  /** Scope shown under/over the centre value ("All networks", "Ethereum"). */
  @Input() caption: string = '';

  readonly radius = RING_RADIUS;

  /** Transient highlight (pointer/focus). */
  readonly hovered = signal<string | null>(null);
  /** Sticky selection (tap/click — the touch path to the centre read-out). */
  readonly sticky = signal<string | null>(null);

  activeId(): string | null {
    return this.hovered() ?? this.sticky();
  }

  toggleSticky(id: string): void {
    this.sticky.update((current) => (current === id ? null : id));
  }

  /**
   * Arc geometry, recomputed per change-detection pass — bounded by the
   * parent's top-N aggregation, so this stays a handful of items.
   */
  get arcs(): RingArc[] {
    const total = this.segments.reduce((sum, s) => sum + s.value, 0);
    if (total <= 0) return [];

    const gap = this.segments.length > 1 ? SEGMENT_GAP : 0;
    let cursor = 0;

    return this.segments.map((seg, i) => {
      const length = (seg.value / total) * CIRCUMFERENCE;
      const visible = Math.max(1, length - gap);
      const arc: RingArc = {
        ...seg,
        color: SEGMENT_COLORS[Math.min(i, SEGMENT_COLORS.length - 1)],
        dasharray: `${visible} ${CIRCUMFERENCE - visible}`,
        dashoffset: -cursor,
        share: (seg.value / total) * 100,
      };
      cursor += length;
      return arc;
    });
  }

  get activeArc(): RingArc | null {
    const id = this.activeId();
    if (!id) return null;
    return this.arcs.find((a) => a.id === id) ?? null;
  }

  get ariaSummary(): string {
    if (this.arcs.length === 0) {
      return `Portfolio value ${this.formatUsd(this.total)}`;
    }
    const parts = this.arcs.map((a) => `${a.label} ${a.share.toFixed(0)}%`).join(', ');
    return `Portfolio ${this.formatUsd(this.total)} on ${this.caption}: ${parts}`;
  }

  formatUsd(value: number): string {
    // Unknown value must read as "unknown", never as a $0.00 balance.
    if (!Number.isFinite(value)) return '—';
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}
