/**
 * =============================================================================
 * SETTINGS SERVICE
 * =============================================================================
 *
 * Global settings service for user preferences.
 * Settings are persisted in localStorage.
 *
 * @author Orion DEX Team
 * @version 2.2.0 — MAX_SLIPPAGE lowered 10% → 5% to match the backend's hard
 *                  validation (slippage ∈ (0, 0.05], SWAP_INVALID_SLIPPAGE
 *                  otherwise); persisted values above the cap migrate to the
 *                  defaults on load.
 */

import { Injectable, signal, effect } from '@angular/core';

// =============================================================================
// CONSTANTS
// =============================================================================

/** LocalStorage key for settings */
const SETTINGS_KEY = 'orion_settings';

/**
 * Hard bounds for slippage tolerance, applied on load AND when the user
 * mutates the value at runtime. localStorage is user-writable, so without
 * a clamp here an XSS payload (or a malicious browser extension) could shove
 * `slippage: 99` and the next swap would happily encode that into the
 * aggregator request — no actual slippage protection, sandwich-friendly.
 *
 * MAX is 5%: the backend rejects anything above 0.05 with
 * SWAP_INVALID_SLIPPAGE, which would silently demote the swap to the LI.FI
 * fallback path — so a larger local cap buys nothing. It is also the right
 * protection bound on its own: no legitimate route on the supported chains
 * needs more than 5% tolerance; anything above it is either a fat-finger or
 * an exploit window.
 */
const MIN_SLIPPAGE = 0.01;
const MAX_SLIPPAGE = 5;

/** Default settings values */
const DEFAULT_SETTINGS = {
  smartTips: true,       // Show contextual help tips
  slippage: 0.5,         // Default slippage tolerance for same-chain (0.5%)
  crossChainSlippage: 1.5, // Default slippage for cross-chain (1.5% - more volatility)
  crossChainMode: false, // Cross-chain swaps disabled by default (safer for beginners)
};

// =============================================================================
// TYPES
// =============================================================================

interface Settings {
  smartTips: boolean;
  slippage: number;
  crossChainSlippage: number;
  crossChainMode: boolean;
}

// =============================================================================
// SERVICE
// =============================================================================

@Injectable({
  providedIn: 'root',
})
export class SettingsService {
  // ---------------------------------------------------------------------------
  // Signals (reactive state)
  // ---------------------------------------------------------------------------

  /** Smart Tips toggle - shows contextual help throughout the app */
  smartTips = signal<boolean>(DEFAULT_SETTINGS.smartTips);

  /** Slippage tolerance in percentage for same-chain swaps */
  slippage = signal<number>(DEFAULT_SETTINGS.slippage);

  /** Slippage tolerance for cross-chain swaps (higher due to more volatility) */
  crossChainSlippage = signal<number>(DEFAULT_SETTINGS.crossChainSlippage);

  /** Cross-Chain Mode - allows swapping between different networks */
  crossChainMode = signal<boolean>(DEFAULT_SETTINGS.crossChainMode);

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor() {
    // Load settings from localStorage on init
    this.loadSettings();

    // Auto-save settings when they change
    effect(() => {
      const settings: Settings = {
        smartTips: this.smartTips(),
        slippage: this.slippage(),
        crossChainSlippage: this.crossChainSlippage(),
        crossChainMode: this.crossChainMode(),
      };
      this.saveSettings(settings);
    });
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Load settings from localStorage. Clamps numeric values to safe bounds —
   * see MIN_SLIPPAGE / MAX_SLIPPAGE constants above for rationale.
   */
  private loadSettings(): void {
    try {
      const stored = localStorage.getItem(SETTINGS_KEY);
      if (!stored) return;

      const parsed = JSON.parse(stored);
      if (!parsed || typeof parsed !== 'object') return;
      const settings = parsed as Partial<Settings>;

      if (typeof settings.smartTips === 'boolean') {
        this.smartTips.set(settings.smartTips);
      }
      // One-time migration from the previous caps (50%, then 10%): a
      // persisted value above the current MAX_SLIPPAGE was set under an older
      // policy (or injected), so it resets to the safe DEFAULT rather than
      // clamping to the cap — a user who once typed 30% almost certainly
      // didn't mean "the new maximum". The auto-save effect immediately
      // persists the corrected value, so this branch runs at most once per
      // stored value.
      if (typeof settings.slippage === 'number' && Number.isFinite(settings.slippage)) {
        this.slippage.set(
          settings.slippage > MAX_SLIPPAGE
            ? DEFAULT_SETTINGS.slippage
            : this.clampSlippage(settings.slippage),
        );
      }
      if (typeof settings.crossChainSlippage === 'number' && Number.isFinite(settings.crossChainSlippage)) {
        this.crossChainSlippage.set(
          settings.crossChainSlippage > MAX_SLIPPAGE
            ? DEFAULT_SETTINGS.crossChainSlippage
            : this.clampSlippage(settings.crossChainSlippage),
        );
      }
      if (typeof settings.crossChainMode === 'boolean') {
        this.crossChainMode.set(settings.crossChainMode);
      }
    } catch (error) {
      console.warn('Failed to load settings, using defaults:', error);
    }
  }

  private clampSlippage(value: number): number {
    if (!Number.isFinite(value)) return DEFAULT_SETTINGS.slippage;
    return Math.min(MAX_SLIPPAGE, Math.max(MIN_SLIPPAGE, value));
  }

  /**
   * Save settings to localStorage
   */
  private saveSettings(settings: Settings): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (error) {
      console.warn('Failed to save settings:', error);
    }
  }

  // ---------------------------------------------------------------------------
  // Public Methods
  // ---------------------------------------------------------------------------

  /**
   * Toggle Smart Tips on/off
   */
  toggleSmartTips(): void {
    this.smartTips.update(v => !v);
  }

  /**
   * Toggle Cross-Chain Mode on/off
   */
  toggleCrossChainMode(): void {
    this.crossChainMode.update(v => !v);
  }

  /**
   * Reset all settings to defaults
   */
  resetToDefaults(): void {
    this.smartTips.set(DEFAULT_SETTINGS.smartTips);
    this.slippage.set(DEFAULT_SETTINGS.slippage);
    this.crossChainSlippage.set(DEFAULT_SETTINGS.crossChainSlippage);
    this.crossChainMode.set(DEFAULT_SETTINGS.crossChainMode);
  }

  /**
   * Get appropriate slippage for a swap based on whether it's cross-chain.
   * Re-clamps at read time as a defence-in-depth — if anything ever managed
   * to set the signal directly past the loader's clamp, the actual quote
   * request still gets a value in [MIN_SLIPPAGE, MAX_SLIPPAGE].
   */
  getSlippageForSwap(isCrossChain: boolean): number {
    return this.clampSlippage(isCrossChain ? this.crossChainSlippage() : this.slippage());
  }
}

