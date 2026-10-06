/**
 * One-time interactive login for wallet-gated e2e tests.
 *
 * Opens a headed Chromium with a PERSISTENT profile (e2e/.auth/profile —
 * gitignored: it will hold live Privy session tokens). Log in via Privy in
 * the opened window, then simply close the browser window; authed specs
 * (e2e/authed.spec.ts) reuse the profile headlessly afterwards.
 *
 * Requires the dev server: npx ng serve --port 4300 (or let `npm run e2e`
 * start it first).
 */
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const profileDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.auth', 'profile');

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: null,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

try {
  await page.goto('http://localhost:4300', { timeout: 15_000 });
} catch {
  console.error('Dev server is not responding on http://localhost:4300 — start it with: npx ng serve --port 4300');
  await ctx.close();
  process.exit(1);
}

console.log('Окно открыто. Войдите через Privy (Connect), затем просто закройте окно браузера.');
await new Promise((resolve) => ctx.on('close', resolve));
console.log('Сессия сохранена: e2e/.auth/profile — можно запускать npm run e2e:authed');
