import { Component, HostListener, inject, output, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SettingsService } from '../../../core/services/settings.service';
import { FocusTrapDirective } from '../../../shared/directives/focus-trap.directive';
import { NumericInputDirective } from '../../../shared/directives/numeric-input.directive';

const AUTO_SLIPPAGE = 0.5;
const AUTO_CROSS_CHAIN_SLIPPAGE = 1.5;

@Component({
  selector: 'app-settings-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, FocusTrapDirective, NumericInputDirective],
  templateUrl: './settings-panel.component.html',
  styleUrl: './settings-panel.component.scss'
})
export class SettingsPanelComponent {
  settingsService = inject(SettingsService);
  close = output<void>();

  /**
   * Fires after a slippage value is actually committed (Auto reset or a
   * confirmed custom value). Quotes freeze slippage at fetch time, the
   * silent pre-execution re-quote re-sends `quote.slippage`, and the auto
   * refresh only ticks every 30 s — so the parent must refetch the quote on
   * this event for the new slippage to apply before the next swap.
   */
  slippageCommitted = output<void>();

  // Same-chain slippage
  slippageInput = signal<string>('');

  // Cross-chain slippage
  crossChainSlippageInput = signal<string>('');

  // Inline validation: out-of-range input used to silently revert on Apply,
  // which read as "the button does nothing". The error line renders live
  // under the input and Apply stays disabled while it shows.
  // Upper bound mirrors SettingsService.MAX_SLIPPAGE (5%) — the backend
  // rejects anything above with SWAP_INVALID_SLIPPAGE, and a wider tolerance
  // is value handed to sandwich bots, not slippage protection.
  slippageError = computed<string | null>(() => {
    const raw = this.slippageInput().trim();
    if (!raw) return null;
    const value = parseFloat(raw);
    if (isNaN(value) || value < 0.1 || value > 5) return 'Allowed: 0.1–5%';
    return null;
  });

  crossChainSlippageError = computed<string | null>(() => {
    const raw = this.crossChainSlippageInput().trim();
    if (!raw) return null;
    const value = parseFloat(raw);
    if (isNaN(value) || value < 0.5 || value > 5) return 'Allowed: 0.5–5%';
    return null;
  });

  // Confirmation modal state
  showConfirmModal = signal(false);
  confirmationType = signal<'same-chain' | 'cross-chain'>('same-chain');
  confirmationChecked = signal(false);
  pendingSlippageValue = signal<number>(0);

  // Computed: check if current slippage is Auto (0.5%)
  isAutoSlippage = computed(() => this.settingsService.slippage() === AUTO_SLIPPAGE);

  // Computed: check if cross-chain slippage is Auto (1.5%)
  isAutoCrossChainSlippage = computed(() => this.settingsService.crossChainSlippage() === AUTO_CROSS_CHAIN_SLIPPAGE);

  // Computed: check if input differs from current value
  hasSlippageChanged = computed(() => {
    const inputValue = parseFloat(this.slippageInput());
    return !isNaN(inputValue) && inputValue !== this.settingsService.slippage();
  });

  // Computed: check if cross-chain input differs from current value
  hasCrossChainSlippageChanged = computed(() => {
    const inputValue = parseFloat(this.crossChainSlippageInput());
    return !isNaN(inputValue) && inputValue !== this.settingsService.crossChainSlippage();
  });

  constructor() {
    this.slippageInput.set(this.settingsService.slippage().toString());
    this.crossChainSlippageInput.set(this.settingsService.crossChainSlippage().toString());
  }

  /**
   * Normalize a slippage edit before it lands in the signal. The numeric-input
   * directive only filters keystrokes — a pasted locale comma ('1,5') would
   * otherwise reach `parseFloat` as '1,5' → 1, silently committing 1% for an
   * intended 1.5%. Convert ',' → '.', strip non-numeric, collapse extra dots.
   */
  private normalizeSlippageInput(value: string): string {
    return value
      .replace(/,/g, '.')
      .replace(/[^0-9.]/g, '')
      .replace(/(\..*)\./g, '$1');
  }

  setSlippageInput(value: string): void {
    this.slippageInput.set(this.normalizeSlippageInput(value));
  }

  setCrossChainSlippageInput(value: string): void {
    this.crossChainSlippageInput.set(this.normalizeSlippageInput(value));
  }

  /**
   * One Escape closes one layer: the slippage-confirm modal first, the
   * popover itself otherwise. Dismissing the modal keeps the panel open but
   * NOT the typed value — cancelSlippageChange resets the input back to the
   * stored setting, exactly like clicking the modal's Cancel button.
   *
   * Ordering with SwapComponent.handleEscape: document listeners fire in
   * registration order, so the parent's (registered at SwapComponent
   * creation) runs BEFORE this one. The parent deliberately does NOT close
   * the settings popover anymore — it only consumes Escape for its own
   * modals (cross-chain confirm, token selector) and stops immediate
   * propagation when it does, so this handler never double-fires on the
   * same press. stopImmediatePropagation here likewise shields any
   * listeners registered after this panel.
   */
  @HostListener('document:keydown.escape', ['$event'])
  handleEscape(event: KeyboardEvent): void {
    event.stopImmediatePropagation();
    if (this.showConfirmModal()) {
      this.cancelSlippageChange();
      return;
    }
    this.close.emit();
  }

  /**
   * Reset same-chain slippage to Auto (0.5%)
   */
  resetToAuto(): void {
    const changed = this.settingsService.slippage() !== AUTO_SLIPPAGE;
    this.slippageInput.set(AUTO_SLIPPAGE.toString());
    this.settingsService.slippage.set(AUTO_SLIPPAGE);
    if (changed) this.slippageCommitted.emit();
  }

  /**
   * Reset cross-chain slippage to Auto (1.5%)
   */
  resetCrossChainToAuto(): void {
    const changed = this.settingsService.crossChainSlippage() !== AUTO_CROSS_CHAIN_SLIPPAGE;
    this.crossChainSlippageInput.set(AUTO_CROSS_CHAIN_SLIPPAGE.toString());
    this.settingsService.crossChainSlippage.set(AUTO_CROSS_CHAIN_SLIPPAGE);
    if (changed) this.slippageCommitted.emit();
  }

  /**
   * Request same-chain slippage change (shows confirmation modal).
   * Out-of-range values never get here — Apply is disabled and the inline
   * error line explains the allowed range (no more silent revert).
   */
  requestSlippageChange(): void {
    if (this.slippageError() !== null) return;
    const value = parseFloat(this.slippageInput());
    if (isNaN(value)) return;
    this.pendingSlippageValue.set(value);
    this.confirmationType.set('same-chain');
    this.confirmationChecked.set(false);
    this.showConfirmModal.set(true);
  }

  /**
   * Request cross-chain slippage change (shows confirmation modal).
   * Same inline-error contract as `requestSlippageChange`.
   */
  requestCrossChainSlippageChange(): void {
    if (this.crossChainSlippageError() !== null) return;
    const value = parseFloat(this.crossChainSlippageInput());
    if (isNaN(value)) return;
    this.pendingSlippageValue.set(value);
    this.confirmationType.set('cross-chain');
    this.confirmationChecked.set(false);
    this.showConfirmModal.set(true);
  }

  /**
   * Confirm slippage change after user acknowledges risk
   */
  confirmSlippageChange(): void {
    const value = this.pendingSlippageValue();
    if (this.confirmationType() === 'same-chain') {
      this.settingsService.slippage.set(value);
    } else {
      this.settingsService.crossChainSlippage.set(value);
    }
    this.closeConfirmModal();
    this.slippageCommitted.emit();
  }

  /**
   * Cancel slippage change and reset input
   */
  cancelSlippageChange(): void {
    if (this.confirmationType() === 'same-chain') {
      this.slippageInput.set(this.settingsService.slippage().toString());
    } else {
      this.crossChainSlippageInput.set(this.settingsService.crossChainSlippage().toString());
    }
    this.closeConfirmModal();
  }

  /**
   * Close confirmation modal
   */
  closeConfirmModal(): void {
    this.showConfirmModal.set(false);
    this.confirmationChecked.set(false);
  }

  /**
   * Get warning level for the pending slippage value
   */
  getSlippageWarningLevel(): 'low' | 'normal' | 'high' | 'dangerous' {
    const value = this.pendingSlippageValue();
    const isCrossChain = this.confirmationType() === 'cross-chain';

    // Recalibrated for the 5% cap (backend hard limit): the old 'dangerous'
    // threshold (>5%) became unreachable. Same-chain routes past 3% are
    // sandwich-bait on every supported chain; cross-chain bridges legitimately
    // quote up to ~4% on volatile pairs, so 'dangerous' starts above that.
    if (isCrossChain) {
      if (value < 1) return 'low';
      if (value <= 3) return 'normal';
      if (value <= 4) return 'high';
      return 'dangerous';
    } else {
      if (value < 0.3) return 'low';
      if (value <= 1) return 'normal';
      if (value <= 3) return 'high';
      return 'dangerous';
    }
  }
}
