/**
 * =============================================================================
 * NUMERIC INPUT DIRECTIVE
 * =============================================================================
 *
 * Blocks non-numeric keystrokes on an `<input>` so amount/percent fields can
 * only ever hold a decimal number. `type="text"` (needed so a partial "0."
 * survives while typing and so locale commas can be normalized downstream)
 * gives no native protection, so the keystroke filter lives here.
 *
 * Allows: digits, a single decimal separator ('.' or ','), navigation/editing
 * keys, and clipboard shortcuts. Blocks: letters (notably 'e'/'E' scientific
 * notation), sign keys ('+'/'-'), and a second decimal separator.
 *
 * The directive only filters KEYSTROKES — pastes still reach the value, so the
 * host component must keep sanitizing on (ngModelChange)/(input) (e.g.
 * `sanitizeAmountInput`). Lifted verbatim from the swap page's original
 * inline `onAmountKeydown` so the send page and the slippage inputs get the
 * same protection without duplicating the logic.
 *
 * @author Orion DEX Team
 * @version 1.0.0
 */

import { Directive, HostListener } from '@angular/core';

@Directive({
  selector: '[orionNumericInput]',
  standalone: true,
})
export class NumericInputDirective {
  @HostListener('keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    // Navigation / editing keys pass through untouched.
    if (['Backspace', 'Delete', 'Tab', 'Escape', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      return;
    }
    // Clipboard / select-all shortcuts (Ctrl/Cmd + A/C/V/X).
    if ((event.ctrlKey || event.metaKey) && ['a', 'c', 'v', 'x'].includes(event.key.toLowerCase())) {
      return;
    }
    // A single decimal separator — dot or comma. The comma is allowed on
    // purpose: the host's sanitizer normalizes it to '.' immediately, so
    // blocking it here would only punish locales whose keyboards type ','.
    if (event.key === '.' || event.key === ',') {
      const input = event.target as HTMLInputElement;
      if (input.value.includes('.') || input.value.includes(',')) {
        event.preventDefault();
      }
      return;
    }
    // Everything else must be a single digit.
    if (!/^[0-9]$/.test(event.key)) {
      event.preventDefault();
    }
  }
}
