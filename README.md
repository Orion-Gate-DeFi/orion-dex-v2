# Orion DEX

Non-custodial multi-chain DEX aggregator. The web app (Angular 19) requests quotes from a backend that queries several aggregators in parallel (0x, ODOS, LI.FI, Squid) and lets the user swap or bridge with their own wallet.

**Chains:** Ethereum, Arbitrum, Base, Polygon, Optimism, BNB Chain, Avalanche.

## Run locally

```bash
cd orion-app
npm install
npm start        # http://localhost:4200
npm test         # unit tests (Karma)
```

`src/environments/environment.ts` points at the public preprod backend, so no extra setup is needed. See [docs/ENVIRONMENT_SETUP.md](docs/ENVIRONMENT_SETUP.md) for details.

## Layout

- `orion-app/` — Angular frontend
- `deploy/headers/` — security-header configs for the static host
- `docs/` — setup notes

The Go/Rust backend lives in a separate repository.
