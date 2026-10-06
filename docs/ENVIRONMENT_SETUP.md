# Environment Configuration

Last verified: 2026-06-11. This replaces an older version of this document
that described Infura keys and deploy-platform environment variables —
**neither exists in this project**. There is no runtime configuration at all.

## How configuration actually works

All settings are **compiled into the bundle** from TypeScript files in
`orion-app/src/environments/`:

| File | Used by |
|---|---|
| `environment.ts` | `ng serve` and dev builds (local dev points at the preprod backend) |
| `environment.prod.ts` | production builds — swapped in via `angular.json` `fileReplacements` |
| `environment.example.ts` | template with placeholders, safe reference for the real shape |

`ng build` defaults to the `production` configuration, so a plain build
already uses `environment.prod.ts`. Consequences:

- Setting `PRIVY_APP_ID` or anything else in a deploy platform's dashboard
  does **nothing**. The Angular build never reads process environment
  variables.
- Changing any value requires a **rebuild and redeploy** of the frontend.
- Everything in these files ships to the browser — only public identifiers
  belong here (Privy app IDs, Sentry DSNs and Plausible domains are all
  public by design).

Do not edit `environment.ts` / `environment.prod.ts` casually — their values
drive what a deploy talks to. Change them deliberately and review the diff.

## Build commands

```bash
cd orion-app
npm ci
npm run build                                  # production (environment.prod.ts)
npm run build -- --configuration development   # dev build (environment.ts)
```

Note the `--` before `--configuration`: without it npm swallows the flag and
the build silently stays on the default configuration.

## Fields

All fields exist in both `environment.ts` and `environment.prod.ts`:

| Field | Type | Meaning |
|---|---|---|
| `envName` | string | Environment tag for Sentry / analytics (`'development'`, `'production'`) |
| `privyAppId` | string | Privy app ID ([dashboard](https://dashboard.privy.io/)). Public identifier. Currently the same app for dev and prod — a separate prod app is tracked in the security pass |
| `lifiIntegrator` | string | Integrator name as registered in the [LI.FI dashboard](https://dashboard.li.fi/) (`'orion-dex'`) |
| `lifiFee` | number | Integrator fee as a decimal (`0.001` = 0.1%), collected by LI.FI |
| `defaultChainId` | number | Chain on first load (`1` = Ethereum mainnet) |
| `apiUrl` | string | Orion Go backend (`/best-quote`, `/refresh-quote`, signup, …) |
| `lifiProxyUrl` | string | Authenticated LI.FI proxy (Caddy), include the `/v1` suffix |
| `sentryDsn` | string | Sentry DSN; `''` disables error tracking entirely |
| `analyticsDomain` | string | Plausible site domain; `''` disables analytics (no script injected) |

## Hosts

| | Preprod | Production |
|---|---|---|
| `apiUrl` | `https://preprod-website.oriongate.services/api/v1` | `https://website.oriongate.services/api/v1` |
| `lifiProxyUrl` | `https://preprod-api.oriongate.services/lifi/v1` | `https://api.oriongate.services/lifi/v1` |

Current state of the committed files: `environment.ts` (dev) uses the
**preprod** `apiUrl` but the **prod** LI.FI proxy; `environment.prod.ts`
uses prod for both.

## RPC: no Infura, no keys

There are no RPC API keys to configure. The project deliberately uses public
RPC endpoints (Cloudflare, PublicNode, DRPC, chain-official endpoints) with a circuit-breaker —
see `orion-app/src/app/core/constants/public-rpcs.constant.ts`. Do not add
Infura/Alchemy keys; reintroducing a paid RPC provider is a post-MVP
decision.

## Enabling Sentry and Plausible before launch

Both are off by default (empty strings). To enable for production, edit
`environment.prod.ts` and rebuild:

1. **Sentry**: create a project at sentry.io, copy the DSN (public, safe to
   commit) into `sentryDsn`. `envName` becomes the Sentry environment tag.
2. **Plausible**: register the site domain in Plausible, put that exact
   domain string into `analyticsDomain`. The analytics script is only
   injected when the value is non-empty.

Leave both empty in `environment.ts` so local sessions don't pollute prod
error tracking and stats.

## Fresh clone setup

`environment.ts` is committed with working preprod values — a fresh clone
builds and runs against preprod with **zero** setup. Use
`environment.example.ts` as a reference if you need to point a local build at
your own Privy app or backend.
