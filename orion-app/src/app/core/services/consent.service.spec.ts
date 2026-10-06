/**
 * =============================================================================
 * CONSENT SERVICE — SPECS
 * =============================================================================
 *
 * Covers the consent lifecycle around AnalyticsService (mocked):
 * no decision → banner opens and NOTHING is granted; accept → persisted +
 * analytics-only grant; reject/withdraw → persisted + deny; stored decisions
 * are restored on boot; "Cookie settings" reopens the banner.
 */

import { TestBed } from '@angular/core/testing';
import { AnalyticsService } from './analytics.service';
import { ConsentService } from './consent.service';

const STORAGE_KEY = 'cookie_consent';

describe('ConsentService', () => {
  let service: ConsentService;
  let analytics: jasmine.SpyObj<AnalyticsService>;

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    analytics = jasmine.createSpyObj<AnalyticsService>('AnalyticsService', [
      'init',
      'grantConsent',
      'denyConsent',
      'track',
    ]);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: AnalyticsService, useValue: analytics }],
    });
    service = TestBed.inject(ConsentService);
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it('opens the banner and grants nothing when no decision is stored', () => {
    service.init();
    expect(service.bannerOpen()).toBeTrue();
    expect(service.status()).toBe('unset');
    expect(analytics.grantConsent).not.toHaveBeenCalled();
    expect(analytics.denyConsent).not.toHaveBeenCalled();
  });

  it('accept() persists, closes the banner and grants consent', () => {
    service.init();
    service.accept();

    expect(service.status()).toBe('granted');
    expect(service.bannerOpen()).toBeFalse();
    expect(analytics.grantConsent).toHaveBeenCalledTimes(1);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { analytics: boolean };
    expect(stored.analytics).toBeTrue();
  });

  it('reject() persists, closes the banner and denies consent', () => {
    service.init();
    service.reject();

    expect(service.status()).toBe('denied');
    expect(service.bannerOpen()).toBeFalse();
    expect(analytics.denyConsent).toHaveBeenCalledTimes(1);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { analytics: boolean };
    expect(stored.analytics).toBeFalse();
  });

  it('restores a stored grant on boot without showing the banner', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ analytics: true, timestamp: 1, version: '1.0' }));
    service.init();

    expect(service.bannerOpen()).toBeFalse();
    expect(service.status()).toBe('granted');
    expect(analytics.grantConsent).toHaveBeenCalledTimes(1);
  });

  it('restores a stored rejection silently — no grant, no banner', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ analytics: false, timestamp: 1, version: '1.0' }));
    service.init();

    expect(service.bannerOpen()).toBeFalse();
    expect(service.status()).toBe('denied');
    expect(analytics.grantConsent).not.toHaveBeenCalled();
  });

  it('treats corrupt storage as undecided', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    service.init();
    expect(service.bannerOpen()).toBeTrue();
    expect(analytics.grantConsent).not.toHaveBeenCalled();
  });

  it('openSettings() reopens the banner so consent can be withdrawn', () => {
    service.init();
    service.accept();
    expect(service.bannerOpen()).toBeFalse();

    service.openSettings();
    expect(service.bannerOpen()).toBeTrue();

    service.reject();
    expect(service.status()).toBe('denied');
    expect(analytics.denyConsent).toHaveBeenCalledTimes(1);
  });
});
