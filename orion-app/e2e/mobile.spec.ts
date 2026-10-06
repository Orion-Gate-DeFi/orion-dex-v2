/**
 * =============================================================================
 * MOBILE SUITE — real device emulation (touch, coarse pointer, device UA)
 * =============================================================================
 *
 * Runs under the mobile-chrome (Pixel 7) and mobile-safari (iPhone 14)
 * projects only. Wallet-less: covers the vertical-DEX swap pattern, touch
 * interactions, and layout integrity on every route.
 *
 * Run: npm run e2e:mobile
 */

import { test, expect, Page } from '@playwright/test';

async function pickToken(page: Page, symbol: string): Promise<void> {
  await page.getByRole('button', { name: /Select token/i }).first().tap();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page
    .locator('.orion-token-list-row')
    .filter({ has: page.getByText(symbol, { exact: true }) })
    .first()
    .locator('.row-main')
    .tap();
  // Selection closes the modal — wait it out so the next pick can't race.
  await expect(dialog).toHaveCount(0);
}

test.describe('vertical-DEX swap pattern', () => {
  test('panels join with a seam flip; flipping swaps the pair by touch', async ({ page }) => {
    await page.goto('/swap');

    // Centre column is gone; the seam button takes its place.
    await expect(page.locator('.orion-center-card')).toBeHidden();
    const seam = page.locator('.orion-flip-seam');
    await expect(seam).toBeVisible();
    await expect(seam).toBeDisabled(); // no pair picked yet

    await pickToken(page, 'ETH');
    await pickToken(page, 'USDC');

    const pills = page.locator('app-orion-token-pill .sym');
    await expect(pills.nth(0)).toHaveText('ETH');
    await expect(pills.nth(1)).toHaveText('USDC');

    await expect(seam).toBeEnabled();
    await seam.tap();
    await expect(pills.nth(0)).toHaveText('USDC');
    await expect(pills.nth(1)).toHaveText('ETH');

    await page.screenshot({
      path: `e2e/screenshots/mobile-swap-${test.info().project.name}.png`,
      fullPage: true,
    });
  });

  test('amount input and token pill share one row', async ({ page }) => {
    await page.goto('/swap');
    const panel = page.locator('app-orion-amount-panel').first();
    const input = panel.locator('.orion-amount-input');
    const pill = panel.locator('app-orion-token-pill');
    await expect(input).toBeVisible();

    const inputBox = await input.boundingBox();
    const pillBox = await pill.boundingBox();
    const inputCenter = inputBox!.y + inputBox!.height / 2;
    const pillCenter = pillBox!.y + pillBox!.height / 2;
    expect(Math.abs(inputCenter - pillCenter)).toBeLessThan(20);
  });
});

test.describe('layout integrity on every route', () => {
  for (const route of ['/', '/swap', '/send', '/receive']) {
    test(`no horizontal scroll on ${route}`, async ({ page }) => {
      await page.goto(route);
      // Let lazy sections and async data paint before measuring.
      await page.waitForLoadState('networkidle').catch(() => undefined);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});

test.describe('touch affordances', () => {
  test('token rows are comfortable touch targets', async ({ page }) => {
    await page.goto('/swap');
    await page.getByRole('button', { name: /Select token/i }).first().tap();
    const row = page.locator('.orion-token-list-row').first();
    await expect(row).toBeVisible();
    const box = await row.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test('selector closes by tapping the backdrop', async ({ page }) => {
    await page.goto('/swap');
    await page.getByRole('button', { name: /Select token/i }).first().tap();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.locator('.orion-backdrop').tap({ position: { x: 10, y: 10 } });
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
