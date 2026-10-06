import { TestBed } from '@angular/core/testing';
import { SettingsService } from './settings.service';

describe('SettingsService', () => {
  let service: SettingsService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [SettingsService]
    });
    service = TestBed.inject(SettingsService);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('should initialize smart tips as enabled by default', () => {
    expect(service.smartTips()).toBe(true);
  });

  it('should toggle smart tips', () => {
    const initialValue = service.smartTips();
    service.toggleSmartTips();
    expect(service.smartTips()).toBe(!initialValue);
  });

  it('should persist smart tips setting to localStorage', () => {
    // Root-level effects do NOT run on microtasks inside TestBed — in the
    // real app change detection drives the flush, so the test must flush
    // explicitly after each signal write.
    service.smartTips.set(false);
    TestBed.flushEffects();

    const settings = localStorage.getItem('orion_settings');
    expect(settings).toBeTruthy();
    if (settings) {
      const parsed = JSON.parse(settings);
      expect(parsed.smartTips).toBe(false);
    }

    service.smartTips.set(true);
    TestBed.flushEffects();

    const settings2 = localStorage.getItem('orion_settings');
    expect(settings2).toBeTruthy();
    if (settings2) {
      const parsed2 = JSON.parse(settings2);
      expect(parsed2.smartTips).toBe(true);
    }
  });

  it('should load smart tips setting from localStorage', () => {
    // Clear localStorage and set up test data
    localStorage.clear();
    localStorage.setItem('orion_settings', JSON.stringify({
      smartTips: false,
      slippage: 0.5,
      crossChainMode: 'recommended'
    }));

    // Reset TestBed to create a new service instance
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [SettingsService]
    });

    const newService = TestBed.inject(SettingsService);
    expect(newService.smartTips()).toBe(false);
  });

  it('should handle invalid localStorage values gracefully', () => {
    // Clear localStorage and set invalid JSON
    localStorage.clear();
    localStorage.setItem('orion_settings', 'invalid-json');

    // Reset TestBed to create a new service instance
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [SettingsService]
    });

    const newService = TestBed.inject(SettingsService);

    // Should default to true if invalid value
    expect(newService.smartTips()).toBe(true);
  });

  it('should toggle multiple times correctly', () => {
    expect(service.smartTips()).toBe(true);

    service.toggleSmartTips();
    expect(service.smartTips()).toBe(false);

    service.toggleSmartTips();
    expect(service.smartTips()).toBe(true);

    service.toggleSmartTips();
    expect(service.smartTips()).toBe(false);
  });

  describe('getSlippageForSwap picks the right default per route type', () => {
    // The two defaults are not interchangeable: quoting a bridge at the
    // same-chain 0.5% is how cross-chain swaps fail on normal volatility,
    // and quoting a same-chain swap at 1.5% widens the sandwich window.
    it('serves the cross-chain default (1.5%) for a bridge', () => {
      expect(service.getSlippageForSwap(true)).toBe(1.5);
    });

    it('serves the same-chain default (0.5%) for a direct swap', () => {
      expect(service.getSlippageForSwap(false)).toBe(0.5);
    });

    it('keeps the two settings independent', () => {
      service.slippage.set(1);
      service.crossChainSlippage.set(3);

      expect(service.getSlippageForSwap(false)).toBe(1);
      expect(service.getSlippageForSwap(true)).toBe(3);
    });
  });

  describe('slippage cap migration (above-cap values reset to defaults)', () => {
    /** Boot a fresh service instance against whatever localStorage holds. */
    function freshService(stored: Record<string, unknown>): SettingsService {
      localStorage.clear();
      localStorage.setItem('orion_settings', JSON.stringify(stored));
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ providers: [SettingsService] });
      return TestBed.inject(SettingsService);
    }

    it('resets a persisted same-chain slippage above 5% to the default', () => {
      // 8% was legal under the previous 10% cap; under the new policy it
      // resets to the DEFAULT (0.5), not to the new maximum — the user never
      // chose 5%.
      const svc = freshService({ slippage: 8 });
      expect(svc.slippage()).toBe(0.5);
    });

    it('resets a persisted cross-chain slippage above 5% to the cross-chain default', () => {
      const svc = freshService({ crossChainSlippage: 10 });
      expect(svc.crossChainSlippage()).toBe(1.5);
    });

    it('keeps persisted values at or below the new cap untouched', () => {
      const svc = freshService({ slippage: 4, crossChainSlippage: 5 });
      expect(svc.slippage()).toBe(4);
      expect(svc.crossChainSlippage()).toBe(5);
    });

    it('clamps a runtime value pushed past the cap at read time (getSlippageForSwap)', () => {
      const svc = freshService({ slippage: 1 });
      // Direct signal write bypassing the loader — defence-in-depth re-clamp
      // must still bound the value the quote request actually uses.
      svc.slippage.set(42);
      expect(svc.getSlippageForSwap(false)).toBe(5);
    });
  });
});
