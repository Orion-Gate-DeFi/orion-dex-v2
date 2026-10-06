/**
 * =============================================================================
 * STATUS ICON
 * =============================================================================
 *
 * Tinted circle with a centered Material Symbols glyph — the status marker on
 * the Swap / Send / Receive progress and result screens.
 *
 * Dumb presentational component. The host element IS the circle, so callers
 * keep positioning it with layout classes (`mx-auto mb-6`, `orion-scale-in`)
 * exactly like the inline markup it replaces.
 *
 * @author Orion DEX Team
 * @version 1.0.0
 */

import { Component, ChangeDetectionStrategy, HostBinding, Input } from '@angular/core';

/** Semantic circle color; resolves to the matching `--orion-*` token pair. */
export type StatusIconTint = 'success' | 'danger' | 'warning' | 'accent';

@Component({
  selector: 'app-status-icon',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="material-symbols-outlined"
      [class.animate-pulse]="animate === 'pulse'"
      [class.orion-spin]="animate === 'spin'"
      [style.font-size.px]="iconSize"
      [style.color]="iconColor"
      aria-hidden="true"
    >{{ icon }}</span>
  `,
  styles: [`
    :host {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: none;
      border-radius: var(--orion-radius-chip);
    }
  `],
})
export class StatusIconComponent {
  /** Material Symbols glyph name (e.g. 'check_circle', 'error'). */
  @Input() icon = '';
  /** Semantic tint: the circle gets the `-tint` token, the glyph the solid one. */
  @Input() tint: StatusIconTint = 'accent';
  /** Circle diameter in px. */
  @Input() size = 80;
  /** Glyph font-size in px. */
  @Input() iconSize = 36;
  /** Optional motion while a step is in flight. */
  @Input() animate: 'spin' | 'pulse' | null = null;

  /** Purely decorative — the adjacent heading carries the meaning. */
  @HostBinding('attr.aria-hidden') readonly ariaHidden = 'true';

  @HostBinding('style.width.px')
  get hostWidth(): number { return this.size; }

  @HostBinding('style.height.px')
  get hostHeight(): number { return this.size; }

  @HostBinding('style.background')
  get hostBackground(): string { return `var(--orion-${this.tint}-tint)`; }

  /** Accent glyphs must use the text-safe accent — the button-safe accent
   *  is only ~2.7:1 as a glyph on graphite surfaces. */
  get iconColor(): string {
    return this.tint === 'accent' ? 'var(--orion-accent-text)' : `var(--orion-${this.tint})`;
  }
}
