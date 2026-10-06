/**
 * =============================================================================
 * ANALYTICS CONSENT — privacy-contour verification (wallet-less)
 * =============================================================================
 *
 * Proves the GA4 consent contour end-to-end in a real browser:
 *  (a) before any consent: ZERO requests to Google, no GA cookies;
 *  (b) accept → consent update grants ONLY analytics_storage, gtag.js load
 *      is attempted, and a SANITIZED page_view lands in the dataLayer;
 *  (c) an address-bearing URL (/send?to=0x…&amount=…) produces a page_view
 *      with the template path only — the address never enters the dataLayer;
 *  (d) reject / withdrawal → all-denied update, no further events;
 *  (e) no analytics-related console errors.
 *
 * All googletagmanager.com requests are fulfilled with an EMPTY stub script,
 * so this suite never sends live traffic to the shared GA4 property.
 */

import { test, expect, Page } from '@playwright/test';

const GA_HOSTS = /googletagmanager\.com|google-analytics\.com|analytics\.google\.com/;

/** Address that must never leave the browser. */
const TEST_ADDRESS = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';

/** Serialize the gtag queue (Arguments objects) into plain arrays. */
async function dataLayer(page: Page): Promise<unknown[][]> {
  return page.evaluate(() => {
    const dl = (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? [];
    return dl.map((entry) =>
      JSON.parse(JSON.stringify(Array.from(entry as ArrayLike<unknown>))),
    ) as unknown[][];
  });
}

function consentUpdates(calls: unknown[][]): Record<string, string>[] {
  return calls
    .filter((c) => c[0] === 'consent' && c[1] === 'update')
    .map((c) => c[2] as Record<string, string>);
}

function events(calls: unknown[][], name: string): Record<string, unknown>[] {
  return calls.filter((c) => c[0] === 'event' && c[1] === name).map((c) => (c[2] ?? {}) as Record<string, unknown>);
}

/** Neutralize gtag.js: observe the request, hand back an empty script. */
async function stubGoogleTag(page: Page, seen: string[]): Promise<void> {
  await page.route(/googletagmanager\.com/, async (route) => {
    seen.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
  });
}

test.describe('analytics consent contour', () => {
  test('(a) before consent: zero Google requests, no GA cookies, banner offers equal choices', async ({ page, context }) => {
    const googleRequests: string[] = [];
    page.on('request', (req) => {
      if (GA_HOSTS.test(req.url())) googleRequests.push(req.url());
    });

    await page.goto('/');
    const banner = page.getByRole('region', { name: 'Cookie consent' });
    await expect(banner).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Accept' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Reject' })).toBeVisible();

    // A second full load (undecided consent persists) — still nothing may leave.
    // Swap/Send/Receive nav links are wallet-gated, so navigate directly.
    await page.goto('/swap');
    await page.waitForTimeout(1000);

    expect(googleRequests).toEqual([]);
    const cookies = await context.cookies();
    expect(cookies.filter((c) => c.name.startsWith('_ga'))).toEqual([]);

    // Consent Mode defaults are queued locally (all four denied).
    const calls = await dataLayer(page);
    const defaults = calls.filter((c) => c[0] === 'consent' && c[1] === 'default');
    expect(defaults).toHaveLength(1);
    expect(defaults[0][2]).toMatchObject({
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    });
  });

  test('(b) accept: analytics-only grant, gtag.js requested, sanitized page_view', async ({ page }) => {
    const gtagRequests: string[] = [];
    await stubGoogleTag(page, gtagRequests);

    await page.goto('/');
    await page.getByRole('region', { name: 'Cookie consent' }).getByRole('button', { name: 'Accept' }).click();
    await expect(page.getByRole('region', { name: 'Cookie consent' })).toBeHidden();
    await expect.poll(() => gtagRequests.length).toBeGreaterThan(0);

    const calls = await dataLayer(page);
    const updates = consentUpdates(calls);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      analytics_storage: 'granted',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    });

    const pageViews = events(calls, 'page_view');
    expect(pageViews).toHaveLength(1);
    expect(pageViews[0]['page_path']).toBe('/');
    expect(events(calls, 'app_loaded')).toHaveLength(1);

    // `surface` is stamped as a CONFIG param (gtag.js drops custom params
    // given to an untargeted `set`) and the config is queued before any
    // event, so every hit off this frontend is attributable to the app in
    // the stream shared with the marketing site.
    const surfaceConfig = calls.findIndex(
      (c) => c[0] === 'config' && (c[2] as Record<string, unknown> | undefined)?.['surface'] === 'app',
    );
    const firstEvent = calls.findIndex((c) => c[0] === 'event');
    expect(surfaceConfig).toBeGreaterThan(-1);
    expect(surfaceConfig).toBeLessThan(firstEvent);
  });

  test('(c) address-bearing URL: page_view carries the template path, never the address', async ({ page }) => {
    const gtagRequests: string[] = [];
    await stubGoogleTag(page, gtagRequests);
    // Arrive with consent already granted (returning user).
    await page.addInitScript(() => {
      localStorage.setItem(
        'cookie_consent',
        JSON.stringify({ analytics: true, timestamp: Date.now(), version: '1.0' }),
      );
    });

    await page.goto(`/send?to=${TEST_ADDRESS}&amount=5&token=USDC`);
    await expect.poll(async () => events(await dataLayer(page), 'page_view').length).toBeGreaterThan(0);

    const calls = await dataLayer(page);
    const pageViews = events(calls, 'page_view');
    for (const pv of pageViews) {
      expect(pv['page_path']).toBe('/send');
      expect(String(pv['page_location'])).not.toContain('?');
    }
    // The address must not appear ANYWHERE in the queue, in any casing.
    expect(JSON.stringify(calls).toLowerCase()).not.toContain(TEST_ADDRESS.toLowerCase());
    // And the pinned global page params are sanitized too.
    const sets = calls.filter((c) => c[0] === 'set' && typeof c[1] === 'object' && c[1] !== null);
    expect(sets.length).toBeGreaterThan(0);
    for (const s of sets) {
      expect(JSON.stringify(s[1])).not.toContain('to=');
    }
  });

  test('(d) withdrawal via footer Cookie settings: all-denied update, then silence', async ({ page, context }) => {
    const gtagRequests: string[] = [];
    await stubGoogleTag(page, gtagRequests);

    await page.goto('/');
    await page.getByRole('region', { name: 'Cookie consent' }).getByRole('button', { name: 'Accept' }).click();
    await expect(page.getByRole('region', { name: 'Cookie consent' })).toBeHidden();

    await page.getByRole('button', { name: 'Cookie settings' }).click();
    await page.getByRole('region', { name: 'Cookie consent' }).getByRole('button', { name: 'Reject' }).click();

    let calls = await dataLayer(page);
    const updates = consentUpdates(calls);
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    });

    // Post-withdrawal SPA navigation produces NO further events. The footer
    // legal links are the only nav available without a wallet session.
    const eventCountAfterDeny = calls.filter((c) => c[0] === 'event').length;
    await page.getByRole('link', { name: 'Privacy', exact: true }).click();
    await page.waitForTimeout(1000);
    calls = await dataLayer(page);
    expect(calls.filter((c) => c[0] === 'event').length).toBe(eventCountAfterDeny);

    // The stored decision is remembered and no GA cookies survive.
    const stored = await page.evaluate(() => localStorage.getItem('cookie_consent'));
    expect(JSON.parse(stored ?? '{}').analytics).toBe(false);
    const cookies = await context.cookies();
    expect(cookies.filter((c) => c.name.startsWith('_ga'))).toEqual([]);
  });

  test('(e) the consent flow produces no analytics-related console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    const gtagRequests: string[] = [];
    await stubGoogleTag(page, gtagRequests);

    await page.goto('/');
    await page.getByRole('region', { name: 'Cookie consent' }).getByRole('button', { name: 'Accept' }).click();
    await page.getByRole('link', { name: 'Privacy', exact: true }).click();
    await page.waitForTimeout(1000);

    const analyticsErrors = errors.filter(
      (e) =>
        /gtag|googletagmanager|google-analytics|dataLayer|consent|Refused to load|Refused to connect/i.test(e) &&
        // Pre-existing, documented notice: frame-ancestors is delivered as a
        // real HTTP header by the hosting layer (deploy/headers/), and the
        // <meta> copy is known to be ignored. Unrelated to analytics.
        !/frame-ancestors.*is ignored when delivered via a <meta> element/i.test(e),
    );
    expect(analyticsErrors).toEqual([]);
  });
});
