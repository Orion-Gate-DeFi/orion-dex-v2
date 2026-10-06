<div align="center">

<img src="orion-app/public/logo_header.png" alt="Orion Gate" height="72" />

# Orion DEX

**One app, seven chains, four aggregators. Your keys stay yours.**

Orion asks 0x, ODOS, LI.FI and Squid for a quote at the same time and shows you the best route it found, including cross-chain swaps with live bridge tracking.

[![Angular](https://img.shields.io/badge/Angular-19-DD0031?logo=angular&logoColor=white)](https://angular.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![ethers](https://img.shields.io/badge/ethers-v6-2535A0)](https://docs.ethers.org/v6/)
[![Status](https://img.shields.io/badge/status-public%20beta-0066E0)](https://app.oriongate.top)

[**Open the app**](https://app.oriongate.top) · [Setup notes](docs/ENVIRONMENT_SETUP.md)

</div>

---

## What it does

Most swaps need you to compare several aggregators and bridges by hand. Orion does that in one screen.

1. You pick a pair and an amount.
2. The backend queries 0x, ODOS, LI.FI and Squid in parallel and waits for all of them. Coverage matters more to us than a few hundred milliseconds.
3. You see the best route with the real costs: network fee, minimum received, slippage.
4. Right before you sign, the app re-quotes silently. If the price moved or the approval address changed, you see it first.
5. You sign in your own wallet. Cross-chain swaps show bridge status until the funds land.

## Supported chains

| Chain | ID |
|---|---|
| Ethereum | 1 |
| Arbitrum | 42161 |
| Base | 8453 |
| Polygon | 137 |
| Optimism | 10 |
| BNB Chain | 56 |
| Avalanche | 43114 |

## Features

- **Meta-aggregation.** Four liquidity sources compared on every request, same-chain and cross-chain.
- **Wallet without a seed phrase.** Sign in with email, Google or Apple and get an embedded wallet through [Privy](https://privy.io). MetaMask and other external wallets work too.
- **Non-custodial.** Orion has no custom smart contracts and cannot move your funds. Every transaction is signed by you.
- **Portfolio.** Balances across all supported chains in one dashboard, plus an RWA section (tokenized gold PAXG and XAUT, ONDO).
- **Send and receive**, with transaction history.
- **Fiat on-ramp** on the `/buy` page.
- **Orion Assistant.** An AI helper for market questions and swap preparation. It is read-only: it can fill in a swap for you to review, but only you can sign.

## Safety checks

- Token screening through [GoPlus](https://gopluslabs.io) flags honeypots and scam tokens before you press Swap.
- The transaction is simulated before signing.
- Router and spender addresses are checked against an allowlist.
- Slippage is capped at 5%, and the review screen shows the values from quote time, not live settings.
- The CSP has no `unsafe-inline` or `unsafe-eval` in `script-src`.

Orion is in beta and DeFi carries real risk. Nothing in the app is financial advice.

## Run it locally

You need Node.js 22.

```bash
git clone https://github.com/Orion-Gate-DeFi/orion-dex-v2.git
cd orion-dex-v2/orion-app
npm install
npm start
```

Open http://localhost:4200. The default `environment.ts` points at the public preprod backend, so you don't need any keys.

```bash
npm test          # unit tests (Karma)
npm run build     # production build into dist/
npm run e2e       # Playwright end-to-end tests
```

To use your own Privy app or backend, copy values from `src/environments/environment.example.ts`. Everything in these files ends up in the browser bundle, so only public identifiers belong there.

## Repository layout

```
orion-app/        Angular 19 frontend
  src/app/core/     services: wallet, quotes, swap execution, token security
  src/app/features/ swap, dashboard, send, receive, buy, agent
  e2e/              Playwright tests
deploy/headers/   security headers for the static host
docs/             setup notes
```

The Go API (aggregator dispatcher) and the Rust auth service live in a separate backend repository.

## Tech stack

Angular 19 · TypeScript · Tailwind CSS · ethers v6 · Privy · LI.FI SDK · Playwright · Karma

## Contact

Product and support: support@oriongate.xyz  
Security reports: security@oriongate.xyz
