/**
 * =============================================================================
 * SMOKE / VISUAL CHECKS — wallet-less surface
 * =============================================================================
 *
 * What this covers (and deliberately doesn't):
 *  - covers: boot, responsive horizontal↔vertical switching, token-selector
 *    UX (tabs, search scoping, keyboard, focus trap), regression guards
 *    (dead-icon request loop, fee badges, ghost buttons).
 *  - does NOT cover: anything behind a Privy session (quotes, review,
 *    execution, balances) — those flows are manual-test territory.
 */

import { test, expect, Page } from '@playwright/test';

/** Requests to the dead LI.FI unknown.svg — the old infinite-404 regression. */
function trackDeadIconRequests(page: Page): { count: () => number } {
  let n = 0;
  page.on('request', (req) => {
    if (req.url().includes('icons/tokens/unknown.svg')) n++;
  });
  return { count: () => n };
}

function gridColumnCount(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate(
    (el) => getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length,
  );
}

test.describe('boot & dashboard (disconnected)', () => {
  test('dashboard renders the flat hero, no glassmorphism remnants', async ({ page }) => {
    const deadIcons = trackDeadIconRequests(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Your Gateway to/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Connect Wallet/i }).first()).toBeVisible();

    // The retired aesthetic must not resurface.
    expect(await page.locator('[class*="backdrop-blur"]').count()).toBe(0);
    expect(await page.locator('[class*="blur-["]').count()).toBe(0);

    await page.screenshot({ path: 'e2e/screenshots/dashboard-disconnected.png', fullPage: true });
    expect(deadIcons.count()).toBe(0);
  });
});

test.describe('swap layout: horizontal on desktop, vertical on mobile', () => {
  test('desktop 1440px → 3-column swap grid', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/swap');
    await expect(page.locator('.orion-swap-card-grid')).toBeVisible();
    expect(await gridColumnCount(page, '.orion-swap-card-grid')).toBe(3);
    await expect(page.locator('.orion-flip-seam')).toBeHidden();
    await page.screenshot({ path: 'e2e/screenshots/swap-desktop.png', fullPage: true });
  });

  test('tablet portrait 768px → stacked', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/swap');
    expect(await gridColumnCount(page, '.orion-swap-card-grid')).toBe(1);
  });

  test('phone 390px → stacked, compact centre bar, no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/swap');
    expect(await gridColumnCount(page, '.orion-swap-card-grid')).toBe(1);

    // Phones: the centre column disappears entirely; the seam flip button
    // takes its place between the joined panels (vertical-DEX pattern).
    await expect(page.locator('.orion-center-card')).toBeHidden();
    await expect(page.locator('.orion-flip-seam')).toBeVisible();

    // Vertical layout must not leak horizontal scroll.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await page.screenshot({ path: 'e2e/screenshots/swap-mobile.png', fullPage: true });
  });
});

test.describe('token selector', () => {
  async function openSelector(page: Page): Promise<void> {
    await page.goto('/swap');
    await page.getByRole('button', { name: /Select token/i }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
  }

  test('opens as a dialog with tabs; no fee badges; Escape closes and restores focus', async ({ page }) => {
    const deadIcons = trackDeadIconRequests(page);
    await openSelector(page);

    await expect(page.getByRole('tab', { name: /Popular/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /RWA/ })).toBeVisible();
    // De-noise regression guard: per-network fee badges were removed.
    expect(await page.locator('.orion-fee-tag').count()).toBe(0);
    await expect(page.getByText(/Fees on /)).toHaveCount(0);

    await page.screenshot({ path: 'e2e/screenshots/token-selector.png' });

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(deadIcons.count()).toBe(0);
  });

  test('search is scoped by the active tab', async ({ page }) => {
    await openSelector(page);
    const search = page.getByLabel(/Search tokens/);

    // Popular scope: ETH should match.
    await search.fill('ETH');
    await expect(page.locator('.orion-token-list-row').first()).toBeVisible();

    // RWA scope: ETH is not an RWA — the RWA empty state must show instead
    // of leaking the whole market into the results.
    await page.getByRole('tab', { name: /RWA/ }).click();
    await expect(page.getByText(/No RWA tokens match|No RWA tokens listed/)).toBeVisible();
  });

  test('token rows are reachable by keyboard (real buttons)', async ({ page }) => {
    await openSelector(page);
    const firstRow = page.locator('.orion-token-list-row .row-main').first();
    await expect(firstRow).toBeVisible();
    const tag = await firstRow.evaluate((el) => el.tagName);
    expect(tag).toBe('BUTTON');

    // ArrowDown from search jumps into the list.
    await page.getByLabel(/Search tokens/).focus();
    await page.keyboard.press('ArrowDown');
    const focusedClass = await page.evaluate(() => document.activeElement?.className || '');
    expect(focusedClass).toContain('row-main');
  });
});

test.describe('header & global chrome', () => {
  test('no dead-affordance buttons; footer shows a real version', async ({ page }) => {
    await page.goto('/');
    // "Buy Crypto" ghost button and "Manage token lists" were removed.
    await expect(page.getByRole('button', { name: /Buy Crypto/i })).toHaveCount(0);
    await expect(page.getByText('Manage token lists')).toHaveCount(0);
    await expect(page.getByText(/Alpha v\d+\.\d+\.\d+/)).toBeVisible();
  });

  test('loading spinners use an infinite animation', async ({ page }) => {
    await page.goto('/swap');
    const iteration = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.className = 'orion-spin';
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).animationIterationCount;
      probe.remove();
      return value;
    });
    expect(iteration).toBe('infinite');
  });
});
