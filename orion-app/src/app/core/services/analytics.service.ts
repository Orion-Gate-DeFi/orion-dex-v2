/**
 * =============================================================================
 * ANALYTICS SERVICE
 * =============================================================================
 *
 * Product analytics via Google Analytics 4 (measurement ID shared with the
 * marketing site, so the site → app funnel lands in one GA4 property with
 * cross-domain tracking configured stream-side by the operator).
 *
 * Privacy contour (mirrors the marketing site, tightened for a wallet app):
 * - Consent Mode v2, default ALL four signals denied. `gtag.js` is NOT even
 *   loaded until the user grants analytics consent — before that, zero
 *   requests leave the browser and no GA cookies exist.
 * - On consent: ONLY `analytics_storage` is granted. The ad signals
 *   (`ad_storage`, `ad_user_data`, `ad_personalization`) are denied forever
 *   by design — Orion runs no ads product. `ads_data_redaction` stays on.
 * - `send_page_view: false` — page views are sent manually with a SANITIZED
 *   template path (see `sanitizePagePath`). Real URLs can carry wallet
 *   addresses and amounts (`/send?to=0x…&amount=…` payment links, `?ref=`
 *   codes), which must never reach Google. `page_location`/`page_path` are
 *   pinned via `gtag('set')` so every event carries the sanitized value.
 * - Event hygiene: callers must never attach wallet addresses, tx hashes,
 *   exact amounts, or emails. Funnel events carry only coarse facts
 *   (chain ids/names, token symbols, aggregator, `usd_band`).
 * - Withdrawal: `denyConsent()` pushes an all-denied consent update, stops
 *   all further events, and expires GA cookies.
 * - Attribution: every hit carries `surface: 'app'` (see `SURFACE`), passed as
 *   a `config` parameter, so the stream shared with the marketing site can be
 *   split app vs site in reports.
 *
 * @author Orion DEX Team
 * @version 2.0.0 — Plausible (never activated) replaced with consent-gated
 *                  GA4 sharing the marketing site's stream. Public API kept
 *                  (`init()` / `track()`), so existing call sites are intact.
 */

import { Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';

/** Allowed event property values — keep these coarse and non-identifying. */
export type AnalyticsProps = Record<string, string | number | boolean>;

/** Single GA4 web stream shared with oriongate.xyz (cross-domain funnel). */
export const GA_MEASUREMENT_ID = 'G-GV7ECE53GD';

/**
 * Constant stamped on every hit from this frontend (`site` on the marketing
 * site). The two frontends share the single measurement ID above on purpose —
 * GA4 stitches a cross-domain journey together only INSIDE one stream — so
 * `surface` is what splits them apart again in reports (registered later as a
 * custom dimension in the GA UI). It is more reliable than the built-in
 * Hostname dimension because the product runs on several domains
 * (.xyz, .top, .services).
 *
 * Delivered as a `config` parameter, NOT via the `gtag('set')` below that pins
 * the page params: gtag.js honours an untargeted global `set` only for the
 * parameters it recognizes (`page_location`, `page_path`, …) and silently
 * drops custom ones, so a `set`-borne `surface` never reaches the wire.
 * Config params are attached to every event sent to this measurement ID.
 */
export const SURFACE = 'app';

const GTAG_SCRIPT_SRC = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;

/**
 * Top-level route segments that may appear in `page_path`. Must mirror
 * app.routes.ts. Anything else (should not exist — `**` redirects to `/`)
 * collapses to `/other` so an unexpected URL can never leak.
 */
const KNOWN_ROUTE_SEGMENTS: ReadonlySet<string> = new Set(['swap', 'send', 'receive', 'legal']);

/** Window slice the gtag bootstrap reads/writes. */
interface GtagWindow {
  dataLayer?: unknown[];
}

/**
 * Reduce a router URL to its template form: query string and fragment are
 * dropped entirely (payment links put the recipient ADDRESS and amount in
 * the query; the marketing site appends `?ref=` codes), and the path is
 * allowlisted down to its first segment — `/send?to=0x…` becomes `/send`.
 */
export function sanitizePagePath(url: string): string {
  const path = url.split('?')[0].split('#')[0];
  const segment = path.split('/').filter((part) => part.length > 0)[0];
  if (!segment) return '/';
  return KNOWN_ROUTE_SEGMENTS.has(segment) ? `/${segment}` : '/other';
}

/**
 * Coarse USD bucket for money-adjacent events. Exact amounts are never sent —
 * a precise USD value plus a timestamp is enough to re-identify an on-chain
 * transaction (and thus the wallet) from public data.
 */
export function usdBand(usd: string | number | undefined): string {
  const value = typeof usd === 'number' ? usd : parseFloat(usd ?? '');
  if (!isFinite(value) || value < 0) return 'unknown';
  if (value < 100) return '<100';
  if (value < 1_000) return '100-1k';
  if (value < 10_000) return '1k-10k';
  return '>10k';
}

@Injectable({
  providedIn: 'root',
})
export class AnalyticsService {
  private router = inject(Router);

  /** Guards against duplicate bootstrap across repeated init() calls. */
  private initialized = false;

  /** True only after the user granted analytics consent this page session. */
  private consentGranted = false;

  /** Guards against duplicate gtag.js injection. */
  private scriptInjected = false;

  /** `app_loaded` is a session-start marker — sent at most once per boot. */
  private appLoadedSent = false;

  /**
   * Bootstrap the gtag queue and Consent Mode defaults, and start watching
   * router navigations for sanitized page views. Deliberately does NOT load
   * gtag.js — the script is injected only after consent (`grantConsent`),
   * so a user who never consents never contacts Google at all.
   */
  init(): void {
    if (this.initialized) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    this.initialized = true;

    const w = window as Window & GtagWindow;
    w.dataLayer = w.dataLayer ?? [];

    // Consent Mode v2 baseline: everything denied until the user decides.
    // All four parameters are always stated explicitly — omitted params are
    // treated as unchanged, so "denied" must be said, never implied.
    this.gtag('consent', 'default', {
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      wait_for_update: 500,
    });

    // Redact ad-click identifiers (gclid etc.) while ad_storage is denied.
    this.gtag('set', 'ads_data_redaction', true);

    this.gtag('js', new Date());

    // Manual page views only; auto page_view would carry the real URL.
    this.setSanitizedPage(this.router.url);
    this.gtag('config', GA_MEASUREMENT_ID, {
      send_page_view: false,
      anonymize_ip: true,
      // Rides on EVERY hit for this measurement ID — page_view, app_loaded and
      // every product event — so the stream shared with the marketing site can
      // be split app vs site in reports. See SURFACE.
      surface: SURFACE,
    });

    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        this.setSanitizedPage(event.urlAfterRedirects);
        this.trackPageView();
      }
    });
  }

  /**
   * User granted analytics consent (or a stored grant was restored): update
   * consent (analytics only — ad signals stay denied forever), load gtag.js,
   * and emit the session-start events that were held back.
   */
  grantConsent(): void {
    this.init();
    if (this.consentGranted) return;
    this.consentGranted = true;

    this.gtag('consent', 'update', {
      analytics_storage: 'granted',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    });

    this.injectScript();

    // The initial page view + session marker were suppressed while consent
    // was undecided; send them now against the current (sanitized) route.
    // When a STORED grant is restored during bootstrap the router has not
    // navigated yet (`router.url` is still '/') — skip the immediate
    // page_view and let the imminent initial NavigationEnd deliver it.
    if (this.router.navigated) {
      this.setSanitizedPage(this.router.url);
      this.trackPageView();
    }
    if (!this.appLoadedSent) {
      this.appLoadedSent = true;
      this.track('app_loaded');
    }
  }

  /**
   * User rejected or withdrew analytics consent: push an all-denied update,
   * stop emitting events, and expire any GA cookies already set.
   */
  denyConsent(): void {
    this.init();
    this.gtag('consent', 'update', {
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    });
    this.consentGranted = false;
    this.deleteGaCookies();
  }

  /**
   * Record a product event. Safe to call unconditionally: a strict no-op
   * until the user has granted analytics consent.
   */
  track(event: string, props?: AnalyticsProps): void {
    if (!this.consentGranted) return;
    this.gtag('event', event, props ?? {});
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Manual, sanitized page_view (no-op before consent, like every event). */
  private trackPageView(): void {
    if (!this.consentGranted) return;
    const path = sanitizePagePath(this.router.url);
    this.gtag('event', 'page_view', {
      page_path: path,
      page_location: this.sanitizedLocation(path),
      page_title: document.title,
    });
  }

  /**
   * Pin `page_location`/`page_path` globally so EVERY subsequent hit —
   * including anything gtag generates on its own — carries the sanitized
   * URL instead of `location.href` (which GA reads by default).
   */
  private setSanitizedPage(url: string): void {
    const path = sanitizePagePath(url);
    this.gtag('set', {
      page_path: path,
      page_location: this.sanitizedLocation(path),
    });
  }

  private sanitizedLocation(path: string): string {
    return `${window.location.origin}${path}`;
  }

  /** Load gtag.js once — only ever reached after consent. */
  private injectScript(): void {
    if (this.scriptInjected) return;
    this.scriptInjected = true;
    if (document.querySelector(`script[src="${GTAG_SCRIPT_SRC}"]`)) return;

    const script = document.createElement('script');
    script.src = GTAG_SCRIPT_SRC;
    script.async = true;
    document.head.appendChild(script);
  }

  /**
   * Standard gtag queue call. Must push the `arguments` object (not a plain
   * array) — gtag.js pattern-matches on Arguments when draining the queue.
   */
  private gtag(..._args: unknown[]): void {
    const w = window as Window & GtagWindow;
    // eslint-disable-next-line prefer-rest-params
    (w.dataLayer = w.dataLayer ?? []).push(arguments);
  }

  /**
   * Best-effort GA cookie removal on withdrawal (`_ga`, `_ga_<container>`).
   * GA sets cookies on the broadest registrable domain, so expiry is
   * attempted on every suffix of the current hostname.
   */
  private deleteGaCookies(): void {
    const cookieNames = document.cookie
      .split(';')
      .map((entry) => entry.split('=')[0].trim())
      .filter((name) => name === '_ga' || name.startsWith('_ga_'));

    const hostParts = window.location.hostname.split('.');
    for (const name of cookieNames) {
      const expiry = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
      document.cookie = expiry;
      for (let i = 0; i < hostParts.length - 1; i++) {
        const domain = hostParts.slice(i).join('.');
        document.cookie = `${expiry}; domain=${domain}`;
        document.cookie = `${expiry}; domain=.${domain}`;
      }
    }
  }
}
