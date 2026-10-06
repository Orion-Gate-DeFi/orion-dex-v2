/**
 * =============================================================================
 * PLAYWRIGHT CONFIG — cross-browser smoke & visual checks
 * =============================================================================
 *
 * Runs against a dev server (`ng serve`) started automatically. Scope is the
 * wallet-less surface: rendering, responsive layout switching, token-selector
 * behaviour, regression guards (no dead-icon request loops). Wallet-gated
 * flows (quotes, review, execution) need a Privy session and stay manual.
 *
 * Run: npm run e2e        (all browsers)
 *      npm run e2e:chrome (chromium only)
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 1,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4300',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    // Desktop browsers run the smoke + authed suites.
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testIgnore: /mobile\.spec\.ts/ },
    // Real mobile emulation (touch events, coarse pointer, device UA) —
    // not just a narrow window. Runs the dedicated mobile suite only.
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
    { name: 'mobile-safari', use: { ...devices['iPhone 14'] }, testMatch: /mobile\.spec\.ts/ },
  ],
  // Locally: `ng serve`, for the fast edit-reload loop.
  // In CI: the production build, served statically. `ng serve` cannot start on
  // a clean checkout — Vite's cold dependency pre-bundle fails to resolve
  // `@farcaster/mini-app-solana`, an OPTIONAL peer of @privy-io/react-auth that
  // is legitimately not installed, and paints an error overlay that intercepts
  // every click. A warm .angular cache hides this locally. Testing the built
  // artifact is the better default for CI regardless.
  webServer: {
    command: process.env['CI']
      ? 'npm run build && node scripts/serve-dist.mjs dist/orion-app/browser 4300'
      : 'npx ng serve --port 4300',
    url: 'http://localhost:4300',
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
