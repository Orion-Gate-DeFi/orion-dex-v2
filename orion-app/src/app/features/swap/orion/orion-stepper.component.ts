/**
 * =============================================================================
 * ORION STEPPER
 * =============================================================================
 *
 * Persistent 3-step progress indicator shown on every swap state:
 *   Set up your swap → Review → Confirm & send
 *
 * Input drives the highlighted step, not internal state — so swap.component
 * stays the single source of truth for flow position.
 *
 * @author Orion DEX Team
 * @version 1.0.0
 */

import { Component, ChangeDetectionStrategy, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

export type StepperState = 'active' | 'done' | 'pending';

export interface StepperItem {
  readonly id: string;
  readonly label: string;
}

@Component({
  selector: 'app-orion-stepper',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ol class="stepper">
      @for (step of steps; track step.id; let i = $index; let last = $last) {
        <li
          class="item"
          [attr.data-state]="stateOf(i)"
          [attr.aria-current]="stateOf(i) === 'active' ? 'step' : null"
        >
          <span class="dot" aria-hidden="true">
            @if (stateOf(i) === 'done') {
              <span class="material-symbols-outlined check">check</span>
            } @else {
              <span class="num">{{ i + 1 }}</span>
            }
          </span>
          <!-- State is conveyed visually via the dot; announce it for SR users
               since data-state styling is invisible to them. -->
          <span class="sr-only">
            {{ stateOf(i) === 'done' ? 'Completed step:' : (stateOf(i) === 'active' ? 'Current step:' : 'Upcoming step:') }}
          </span>
          <span class="label">{{ step.label }}</span>
          @if (!last) {
            <span class="rail" aria-hidden="true" [attr.data-done]="i < activeIndex"></span>
          }
        </li>
      }
    </ol>
  `,
  styles: [`
    :host { display: block; }

    // Visually-hidden a11y text. Defined locally (not relying on the global
    // Tailwind utility) so it is always applied inside this encapsulated
    // component — otherwise the "Current step:" / "Upcoming step:" labels
    // render as visible text and overflow into the step labels.
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .stepper {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      align-items: center;
      gap: 0;
    }

    .item {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .item:last-child { flex: 0 0 auto; }
    // flex-basis auto (not 0): size each step to its content first, then
    // grow. With basis 0 every non-last step got an equal share regardless of
    // label length, so the longest label ("Set up your swap") was squeezed
    // below its width and ellipsised even with room to spare. The rail
    // (flex:1 inside the item) still absorbs the slack; the base min-width:0 +
    // ellipsis on .label stays as the genuine-squeeze backstop.
    .item:not(:last-child) { flex: 1 1 auto; }

    .dot {
      flex: 0 0 auto;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11.5px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: var(--orion-subtle);
      background: var(--orion-surface-3);
      border: 1px solid var(--orion-border);
      transition: background 160ms ease, color 160ms ease, border-color 160ms ease;
    }
    .item[data-state="active"] .dot {
      background: var(--orion-accent-tint);
      border-color: var(--orion-accent);
      color: var(--orion-accent-text);
    }
    .item[data-state="done"] .dot {
      background: var(--orion-success);
      border-color: var(--orion-success);
      color: var(--orion-bg);
    }
    .check { font-size: 14px; font-weight: 700; }
    .num { line-height: 1; }

    .label {
      font-size: 12.5px;
      font-weight: 500;
      letter-spacing: -0.005em;
      color: var(--orion-subtle);
      white-space: nowrap;
      transition: color 160ms ease;
      // Anti-overlap safety at every width: a rigid nowrap label (min-width
      // auto) cannot shrink, so once the row is squeezed below the labels'
      // natural width it overflowed its flex item and painted over the next
      // step. min-width:0 lets the label shrink and ellipsis instead. On wide
      // screens the rail (flex:1) absorbs all slack, so labels never truncate
      // unnecessarily — this only engages under genuine squeeze.
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .item[data-state="active"] .label { color: var(--orion-text); }
    .item[data-state="done"] .label { color: var(--orion-muted); }

    .rail {
      flex: 1 1 0;
      min-width: 28px;
      height: 1px;
      background: var(--orion-border-strong);
      margin: 0 14px;
      transition: background 200ms ease;
    }
    .rail[data-done="true"] { background: var(--orion-success); }

    // Compact mode: the three nowrap labels ("Set up your swap" / "Review" /
    // "Confirm & send") need ~600px of track once dots, gaps and rails are
    // counted (≈630px viewport after the page's horizontal padding), and the
    // exact figure swings with font rendering. The base .label ellipsis already
    // makes overlap impossible at any width, but between that threshold and the
    // old 480px cut the full labels rendered slightly squeezed and showed an
    // ellipsis. Switch to active-label-only with comfortable margin (≤680px):
    // keep a dot for every step (orientation) but label only the current one,
    // so the three full labels appear only when there is clearly room for them.
    @media (max-width: 679.98px) {
      .item:not([data-state="active"]) .label { display: none; }
      // The active item keeps its natural width (rails absorb the slack);
      // ellipsis (from the base .label rule) only guards pathological cases.
      .item[data-state="active"] { flex: 0 0 auto; }
      .label { max-width: 60vw; }
      .rail { min-width: 16px; margin: 0 8px; }
    }
  `],
})
export class OrionStepperComponent {
  @Input({ required: true }) steps: readonly StepperItem[] = [];
  @Input({ required: true }) activeIndex: number = 0;

  stateOf(index: number): StepperState {
    if (index < this.activeIndex) return 'done';
    if (index === this.activeIndex) return 'active';
    return 'pending';
  }
}
