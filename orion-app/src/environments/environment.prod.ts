/**
 * Production environment — substituted for environment.ts via angular.json
 * fileReplacements in the `production` build configuration (the default
 * for `ng build`).
 */

export const environment = {

  /** Environment tag for error tracking / analytics. */
  envName: 'production',

  /** Privy app id (public identifier); must match the backend auth config. */
  privyAppId: 'cmhjdpucy005ti50bhr54ol11',

  /** LI.FI integrator name (must match the LI.FI dashboard). */
  lifiIntegrator: 'orion-dex',

  /** Integrator fee, decimal (0.003 = 0.3%). */
  lifiFee: 0.003,

  /** Default chain on first load (1 = Ethereum mainnet). */
  defaultChainId: 1,

  apiUrl: 'https://website.oriongate.services/api/v1',
  lifiProxyUrl: 'https://api.oriongate.services/lifi/v1',

  /** Sentry DSN — empty string disables error tracking. */
  sentryDsn: '',

  /** Plausible analytics domain — empty string disables analytics. */
  analyticsDomain: '',
};
