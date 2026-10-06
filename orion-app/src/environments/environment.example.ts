/**
 * =============================================================================
 * ENVIRONMENT CONFIGURATION TEMPLATE
 * =============================================================================
 *
 * Reference for the shape of environment.ts / environment.prod.ts.
 * The real environment.ts is committed with working values — a mix of the
 * preprod backend apiUrl and the prod Caddy lifiProxyUrl (see
 * docs/ENVIRONMENT_SETUP.md) — so a fresh clone needs no setup. Copy from
 * this file only when pointing a local build at your own Privy app or
 * backend.
 *
 * All values are compiled into the bundle and shipped to the browser:
 * only public identifiers belong here. See docs/ENVIRONMENT_SETUP.md.
 */

export const environment = {

  /** Environment tag for error tracking / analytics ('development' | 'production'). */
  envName: 'development',

  /**
   * Privy App ID for wallet connection.
   * Get yours at https://dashboard.privy.io/ — public identifier, safe to expose.
   */
  privyAppId: 'YOUR_PRIVY_APP_ID',

  /**
   * LI.FI integrator name — must match the name registered in the
   * LI.FI dashboard (https://dashboard.li.fi/).
   */
  lifiIntegrator: 'your-app-name',

  /** Integrator fee, decimal (0.001 = 0.1%). Collected by LI.FI. */
  lifiFee: 0.001,

  /** Default chain on first load (1 = Ethereum, 8453 = Base, 42161 = Arbitrum). */
  defaultChainId: 1,

  /** Orion Go backend (/best-quote, /refresh-quote, signup, …). */
  apiUrl: 'https://preprod-website.oriongate.services/api/v1',

  /** Authenticated LI.FI proxy (Caddy) — include the /v1 suffix. */
  lifiProxyUrl: 'https://preprod-api.oriongate.services/lifi/v1',

  /**
   * Sentry DSN — empty string disables error tracking entirely.
   * Public identifier, safe to commit.
   */
  sentryDsn: '',

  /**
   * Plausible analytics domain (the site's domain as registered in
   * Plausible). Empty string disables analytics: no script is injected,
   * events are no-ops.
   */
  analyticsDomain: '',
};
