/**
 * =============================================================================
 * ENVIRONMENT CONFIGURATION
 * =============================================================================
 * 
 * This file contains environment-specific configuration.
 * DO NOT commit sensitive API keys to version control!
 * 
 * For production, use environment.prod.ts with different values.
 * 
 * @author Orion DEX Team
 * @version 2.0.0
 */

export const environment = {

  /** Environment tag for error tracking / analytics. */
  envName: 'development',

  /**
   * Privy App ID for wallet connection
   * Get yours at: https://dashboard.privy.io/
   *
   * Safe to expose on frontend - this is a public identifier
   */
  privyAppId: 'cmbwplnvd02hole0mb8zdsl7z',

  /**
   * LI.FI Integrator Name
   * This identifies your app in LI.FI's system
   * Must match the name in your LI.FI dashboard
   * 
   * Dashboard: https://dashboard.li.fi/
   */
  lifiIntegrator: 'orion-dex',

  /**
   * Integrator Fee (Commission)
   * This is the percentage we earn from each swap
   * 
   * Format: decimal (0.001 = 0.1%, 0.003 = 0.3%)
   * Maximum allowed by LI.FI: 0.05 (5%)
   * 
   * Competitor comparison:
   * - Uniswap: 0.3%
   * - 1inch: 0.3%
   * - Orion: 0.1% (lower = competitive advantage!)
   * 
   * Fee is automatically collected by LI.FI and sent to your wallet
   * configured in the LI.FI dashboard.
   */
  lifiFee: 0.001, // 0.1% - lower than competitors!

  /**
   * Default Chain ID
   * Chain to use when user first loads the app
   * 1 = Eth Mainnet
   */
  defaultChainId: 1,

  apiUrl: 'https://preprod-website.oriongate.services/api/v1',
  lifiProxyUrl: 'https://api.oriongate.services/lifi/v1',

  /**
   * Sentry DSN — empty string disables error tracking entirely.
   * Public identifier, safe to commit. Left empty in dev so local sessions
   * don't pollute the project.
   */
  sentryDsn: '',

  /**
   * Plausible analytics domain. Empty string disables analytics:
   * no script is injected, events are no-ops.
   */
  analyticsDomain: '',
};
