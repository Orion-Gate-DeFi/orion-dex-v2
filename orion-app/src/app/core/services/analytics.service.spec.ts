/**
 * =============================================================================
 * ANALYTICS SERVICE — SPECS
 * =============================================================================
 *
 * The privacy contour is the subject under test:
 * - init() only queues Consent Mode defaults — NO gtag.js script, no events.
 * - Nothing is ever emitted before consent; grantConsent() flips exactly
 *   analytics_storage (ad signals stay denied) and only then loads gtag.js.
 * - Page paths are sanitized to template form — payment-link query strings
 *   (`/send?to=0x…&amount=…`) and unknown paths can never reach the queue.
 * - usdBand buckets money values; exact amounts never appear.
 */

import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import {
  AnalyticsService,
  GA_MEASUREMENT_ID,
  SURFACE,
  sanitizePagePath,
  usdBand,
} from './analytics.service';

const SCRIPT_SRC = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;

interface DataLayerWindow {
  dataLayer?: unknown[];
}

/** Materialize the queued `arguments` objects into plain arrays. */
function queuedCalls(): unknown[][] {
  const dl = (window as Window & DataLayerWindow).dataLayer ?? [];
  return dl.map((entry) => Array.from(entry as ArrayLike<unknown>));
}

function consentCalls(kind: 'default' | 'update'): unknown[][] {
  return queuedCalls().filter((call) => call[0] === 'consent' && call[1] === kind);
}

function eventCalls(name?: string): unknown[][] {
  return queuedCalls().filter(
    (call) => call[0] === 'event' && (name === undefined || call[1] === name),
  );
}

/**
 * Index of the `config` call that stamps `surface`, or -1. It has to be a
 * config param: gtag.js drops custom params handed to an untargeted
 * `gtag('set', {…})`, so only config params ride on every hit.
 */
function surfaceConfigIndex(calls: unknown[][]): number {
  return calls.findIndex(
    (call) =>
      call[0] === 'config' &&
      call[1] === GA_MEASUREMENT_ID &&
      (call[2] as Record<string, unknown> | undefined)?.['surface'] === SURFACE,
  );
}

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let appendedScripts: HTMLScriptElement[];

  beforeEach(() => {
    appendedScripts = [];
    // Intercept the injection so unit tests never attach the tag to the DOM
    // (no live request to googletagmanager.com from Karma) — capture the
    // element for assertions instead.
    spyOn(document.head, 'appendChild').and.callFake(<T extends Node>(node: T): T => {
      if (node instanceof HTMLScriptElement) {
        appendedScripts.push(node);
      }
      return node;
    });
    delete (window as Window & DataLayerWindow).dataLayer;

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    service = TestBed.inject(AnalyticsService);
  });

  afterEach(() => {
    delete (window as Window & DataLayerWindow).dataLayer;
  });

  // ---------------------------------------------------------------------------
  // Pure helpers
  // ---------------------------------------------------------------------------

  describe('sanitizePagePath', () => {
    it('keeps known template routes', () => {
      expect(sanitizePagePath('/')).toBe('/');
      expect(sanitizePagePath('/swap')).toBe('/swap');
      expect(sanitizePagePath('/receive')).toBe('/receive');
    });

    it('strips the payment-link query string carrying the recipient address', () => {
      expect(sanitizePagePath('/send?to=0x742d35Cc6634C0532925a3b844Bc454e4438f44e&amount=5&token=USDC')).toBe('/send');
    });

    it('strips referral query params and fragments', () => {
      expect(sanitizePagePath('/?ref=SECRETCODE')).toBe('/');
      expect(sanitizePagePath('/legal#privacy')).toBe('/legal');
    });

    it('collapses unknown paths to /other and drops extra segments', () => {
      expect(sanitizePagePath('/0x742d35Cc6634C0532925a3b844Bc454e4438f44e')).toBe('/other');
      expect(sanitizePagePath('/swap/extra/segments')).toBe('/swap');
      expect(sanitizePagePath('/admin?x=1')).toBe('/other');
    });
  });

  describe('usdBand', () => {
    it('buckets values without exposing exact amounts', () => {
      expect(usdBand('42.17')).toBe('<100');
      expect(usdBand(99.99)).toBe('<100');
      expect(usdBand('100')).toBe('100-1k');
      expect(usdBand(999.99)).toBe('100-1k');
      expect(usdBand('1000')).toBe('1k-10k');
      expect(usdBand(9999)).toBe('1k-10k');
      expect(usdBand('10000')).toBe('>10k');
    });

    it('maps unparseable or negative input to unknown', () => {
      expect(usdBand(undefined)).toBe('unknown');
      expect(usdBand('')).toBe('unknown');
      expect(usdBand('n/a')).toBe('unknown');
      expect(usdBand(-1)).toBe('unknown');
    });
  });

  // ---------------------------------------------------------------------------
  // Before consent: silence
  // ---------------------------------------------------------------------------

  describe('before consent', () => {
    it('init() queues all-denied Consent Mode defaults', () => {
      service.init();
      const defaults = consentCalls('default');
      expect(defaults.length).toBe(1);
      expect(defaults[0][2]).toEqual(jasmine.objectContaining({
        analytics_storage: 'denied',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
      }));
    });

    it('init() does NOT load gtag.js', () => {
      service.init();
      expect(appendedScripts.length).toBe(0);
    });

    it('init() disables the automatic page_view and sends none manually', () => {
      service.init();
      const configs = queuedCalls().filter(
        (call) => call[0] === 'config' && call[1] === GA_MEASUREMENT_ID,
      );
      expect(configs.length).toBe(1);
      expect(configs[0][2]).toEqual(jasmine.objectContaining({ send_page_view: false }));
      expect(eventCalls('page_view').length).toBe(0);
    });

    it('init() stamps surface as a config param, and keeps the page pin sanitized', () => {
      service.init();
      const calls = queuedCalls();
      expect(surfaceConfigIndex(calls)).toBeGreaterThan(-1);
      expect(SURFACE).toBe('app');

      // The page pin stays exactly as it was — page params only.
      const sets = calls.filter(
        (call) => call[0] === 'set' && typeof call[1] === 'object' && call[1] !== null,
      );
      expect(sets.length).toBe(1);
      expect(sets[0][1]).toEqual(
        jasmine.objectContaining({ page_path: '/', page_location: `${window.location.origin}/` }),
      );
    });

    it('track() is a strict no-op', () => {
      service.init();
      service.track('swap_completed', { from_chain: 1 });
      expect(eventCalls().length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Grant: analytics only, then (and only then) the script
  // ---------------------------------------------------------------------------

  describe('grantConsent()', () => {
    beforeEach(() => {
      // Simulate a completed initial navigation — in the app, accepting the
      // banner always happens after the router has navigated. (When consent
      // is restored DURING bootstrap, the immediate page_view is skipped and
      // the initial NavigationEnd delivers it instead.)
      TestBed.inject(Router).navigated = true;
      service.init();
      service.grantConsent();
    });

    it('grants ONLY analytics_storage — ad signals stay denied', () => {
      const updates = consentCalls('update');
      expect(updates.length).toBe(1);
      expect(updates[0][2]).toEqual(jasmine.objectContaining({
        analytics_storage: 'granted',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
      }));
    });

    it('loads gtag.js exactly once, only after the grant', () => {
      expect(appendedScripts.length).toBe(1);
      expect(appendedScripts[0].src).toBe(SCRIPT_SRC);
      service.grantConsent(); // idempotent
      expect(appendedScripts.length).toBe(1);
    });

    it('sends the deferred sanitized page_view and a single app_loaded', () => {
      const pageViews = eventCalls('page_view');
      expect(pageViews.length).toBe(1);
      expect(pageViews[0][2]).toEqual(jasmine.objectContaining({ page_path: '/' }));
      expect(eventCalls('app_loaded').length).toBe(1);
      service.grantConsent();
      expect(eventCalls('app_loaded').length).toBe(1);
    });

    it('stamps surface before the first event, so page_view/app_loaded carry it', () => {
      const calls = queuedCalls();
      const firstEvent = calls.findIndex((call) => call[0] === 'event');
      expect(firstEvent).toBeGreaterThan(-1);
      const config = surfaceConfigIndex(calls);
      expect(config).toBeGreaterThan(-1);
      expect(config).toBeLessThan(firstEvent);
    });

    it('track() forwards events with their props', () => {
      service.track('swap_completed', { from_chain: 1, usd_band: '<100' });
      const events = eventCalls('swap_completed');
      expect(events.length).toBe(1);
      expect(events[0][2]).toEqual(jasmine.objectContaining({ from_chain: 1, usd_band: '<100' }));
    });
  });

  // ---------------------------------------------------------------------------
  // Withdrawal
  // ---------------------------------------------------------------------------

  describe('denyConsent()', () => {
    it('pushes an all-denied update and silences subsequent events', () => {
      service.init();
      service.grantConsent();
      service.denyConsent();

      const updates = consentCalls('update');
      expect(updates.length).toBe(2);
      expect(updates[1][2]).toEqual(jasmine.objectContaining({
        analytics_storage: 'denied',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
      }));

      const eventsBefore = eventCalls().length;
      service.track('swap_completed');
      expect(eventCalls().length).toBe(eventsBefore);
    });
  });
});
