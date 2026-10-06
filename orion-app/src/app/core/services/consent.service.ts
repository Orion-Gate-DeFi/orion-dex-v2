/**
 * =============================================================================
 * CONSENT SERVICE
 * =============================================================================
 *
 * Analytics-consent state for the cookie banner: persisted decision,
 * banner visibility, and the bridge into AnalyticsService (Consent Mode v2
 * grant/deny updates). Mirrors the marketing site's contour — a single
 * optional "analytics" category, accept/reject with equal prominence, and a
 * withdrawal path (footer "Cookie settings" reopens the banner).
 *
 * Storage shape matches the marketing site's `cookie_consent` record
 * ({ analytics, timestamp, version }) so the two stay reviewable as one
 * policy, even though localStorage is per-origin and never shared.
 *
 * @author Orion DEX Team
 * @version 1.0.0
 */

import { Injectable, inject, signal } from '@angular/core';
import { AnalyticsService } from './analytics.service';

export type ConsentStatus = 'unset' | 'granted' | 'denied';

interface StoredConsent {
  analytics: boolean;
  timestamp: number;
  version: string;
}

const CONSENT_STORAGE_KEY = 'cookie_consent';
const CONSENT_VERSION = '1.0';

@Injectable({
  providedIn: 'root',
})
export class ConsentService {
  private analytics = inject(AnalyticsService);

  private readonly _status = signal<ConsentStatus>('unset');
  /** The user's current analytics-consent decision. */
  readonly status = this._status.asReadonly();

  private readonly _bannerOpen = signal<boolean>(false);
  /** Whether the consent banner is currently shown. */
  readonly bannerOpen = this._bannerOpen.asReadonly();

  private initializedSession = false;

  /**
   * Restore a stored decision (applying it to Consent Mode) or open the
   * banner when none exists. Call once at app boot, after
   * `AnalyticsService.init()`.
   */
  init(): void {
    if (this.initializedSession) return;
    this.initializedSession = true;

    const stored = this.readStored();
    if (stored === null) {
      this._bannerOpen.set(true);
      return;
    }
    if (stored.analytics) {
      this._status.set('granted');
      this.analytics.grantConsent();
    } else {
      this._status.set('denied');
      // Consent Mode already defaults to denied — nothing to send. Sending
      // nothing IS the point: a rejecting user never contacts Google.
    }
  }

  /** Banner ACCEPT: persist, close the banner, grant analytics-only consent. */
  accept(): void {
    this.persist(true);
    this._status.set('granted');
    this._bannerOpen.set(false);
    this.analytics.grantConsent();
  }

  /** Banner REJECT (or withdrawal): persist, close, push all-denied update. */
  reject(): void {
    this.persist(false);
    this._status.set('denied');
    this._bannerOpen.set(false);
    this.analytics.denyConsent();
  }

  /** Reopen the banner so the user can change or withdraw their choice. */
  openSettings(): void {
    this._bannerOpen.set(true);
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  private readStored(): StoredConsent | null {
    try {
      const raw = localStorage.getItem(CONSENT_STORAGE_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as StoredConsent).analytics === 'boolean'
      ) {
        return parsed as StoredConsent;
      }
      return null;
    } catch {
      // Unreadable storage (privacy mode, corrupt JSON) → treat as undecided.
      return null;
    }
  }

  private persist(analytics: boolean): void {
    try {
      const record: StoredConsent = {
        analytics,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      };
      localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(record));
    } catch {
      // Storage unavailable — the in-memory decision still applies for this
      // session; the banner will simply re-ask next visit.
    }
  }
}
