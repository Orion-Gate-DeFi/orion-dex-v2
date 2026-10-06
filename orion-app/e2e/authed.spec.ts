/**
 * =============================================================================
 * WALLET-GATED FLOWS — requires a saved Privy session
 * =============================================================================
 *
 * Setup once: npm run e2e:login (log in via Privy, close the window).
 * Then: npm run e2e:authed
 *
 * READ-ONLY by design: these tests fetch quotes and open the review screen
 * but NEVER click Confirm/Approve — no transaction is ever signed.
 */

import { existsSync } from 'node:fs';
import { test as base, expect, chromium, Page } from '@playwright/test';

const PROFILE = 'e2e/.auth/profile';

const test = base.extend<{ authed: Page }>({
  // eslint-disable-next-line no-empty-pattern
  authed: async ({}, use) => {
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      headless: true,
      viewport: { width: 1440, height: 900 },
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await use(page);
    await ctx.close();
  },
});

test.describe('wallet-gated flows', () => {
  // One persistent Chromium profile = one browser at a time: parallel
  // workers fight over the profile lock and lose the Privy session.
  test.describe.configure({ mode: 'serial' });
  test.skip(!existsSync(PROFILE), 'No saved Privy session — run: npm run e2e:login');
  test.skip(({ browserName }) => browserName !== 'chromium', 'Persistent profile is chromium-only');

  test('dashboard: allocation ring renders; quick bar appears on scroll', async ({ authed: page }) => {
    await page.goto('http://localhost:4300/');
    await expect(page.locator('app-orion-asset-ring')).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: 'e2e/screenshots/dashboard-connected.png', fullPage: true });

    // Quick bar only has a job when the page can actually scroll the ring
    // away — an empty portfolio fits one screen and never triggers it.
    const scrollable = await page.evaluate(
      () => document.documentElement.scrollHeight > window.innerHeight + 100,
    );
    if (scrollable) {
      await page.mouse.wheel(0, 2500);
      await expect(page.locator('.quick-bar')).toBeVisible();
      await page.screenshot({ path: 'e2e/screenshots/dashboard-quickbar.png' });

      // Scrolling back hides the bar again.
      await page.mouse.wheel(0, -2500);
      await expect(page.locator('.quick-bar')).toHaveCount(0);
    } else {
      await expect(page.locator('.quick-bar')).toHaveCount(0);
    }
  });

  test('swap: ETH→USDC quote shows info strip; review shows freshness chip (no execution)', async ({ authed: page }) => {
    await page.goto('http://localhost:4300/swap');

    // Exact symbol match: a loose hasText('ETH') also matches every
    // "… · on Ethereum" sublabel (first run picked USDC as the from-token).
    const pickToken = async (symbol: string) => {
      await page.getByRole('button', { name: /Select token/i }).first().click();
      await page
        .locator('.orion-token-list-row')
        .filter({ has: page.getByText(symbol, { exact: true }) })
        .first()
        .locator('.row-main')
        .click();
    };
    await pickToken('ETH');
    await pickToken('USDC');

    await page.getByLabel('Amount to pay').fill('0.001');

    await expect(page.locator('app-orion-info-strip')).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: 'e2e/screenshots/swap-quote.png', fullPage: true });

    const review = page.getByRole('button', { name: /Review swap/i });
    if (await review.isVisible() && await review.isEnabled()) {
      await review.click();
      await expect(page.getByText(/Rate locked for|Quote expired/)).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: 'e2e/screenshots/swap-review.png', fullPage: true });
      // Deliberately stop here: nothing is ever confirmed or signed.
    }
  });

  test('RWA tab lists real assets with category and network line', async ({ authed: page }) => {
    await page.goto('http://localhost:4300/swap');
    await page.getByRole('button', { name: /Select token/i }).first().click();
    await page.getByRole('tab', { name: /RWA/ }).click();

    await expect(page.locator('.orion-token-list-row').first()).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText(/Tokenized gold|Tokenized treasuries|Treasury yield|Private credit/).first(),
    ).toBeVisible();
    await page.screenshot({ path: 'e2e/screenshots/rwa-tab.png' });
  });
});
