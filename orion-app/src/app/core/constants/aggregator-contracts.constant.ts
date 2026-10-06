/**
 * =============================================================================
 * AGGREGATOR CONTRACT ALLOWLIST
 * =============================================================================
 *
 * Frontend mirror of the backend's verified swap-contract allowlist
 * (defense-in-depth for the public-test audit findings #9/#10). Before any
 * quote reaches the signer, both the calldata target (`tx_request.to`) and
 * the ERC-20 spender (`approval_address`) must be one of these officially
 * published contracts for the aggregator that produced the quote, keyed by
 * the chain the transaction executes on (the FROM chain — correct for
 * cross-chain quotes too).
 *
 * Every address below was verified against TWO official sources (docs +
 * source repo) on 2026-06-12 (BNB Chain entries: 2026-06-13; Avalanche
 * entries: 2026-07-01), plus an on-chain eth_getCode cross-check (the
 * Avalanche set was additionally adversarially re-verified against an
 * independent explorer label). Do NOT add or edit addresses from
 * memory — re-verify against the linked sources and keep the backend
 * allowlist (backend/go/website, internal/swap) in lockstep.
 *
 * Addresses are stored LOWERCASE; upstreams return EIP-55 checksummed
 * strings, so all comparisons must lowercase the candidate first.
 *
 * An EMPTY list for an aggregator+chain pair means "no verification was
 * attempted" (currently only ParaSwap, whose adapter is disabled backend-side).
 * Callers fail CLOSED on every empty pair — no exemptions. The aggregator name
 * is backend-controlled, so a fail-open branch (even for ParaSwap) would let a
 * compromised backend skip verification by re-labeling a hostile quote. Never
 * treat an empty pair as "everything is allowed by design".
 *
 * @version 1.2.0
 */

import type { AggregatorName } from '../models/swap.model';

/**
 * 0x Settler architecture note: for the /swap/allowance-holder endpoint
 * (the one our backend uses) the AllowanceHolder contract is BOTH the
 * spender (`allowanceTarget`) and the entry point (`transaction.to`).
 * Settler addresses rotate per deployment and must NEVER be approved —
 * https://docs.0x.org/evm/0x-swap-api/additional-topics/how-to-set-your-token-allowances
 *
 * Sources per aggregator (each address checked against both):
 * - zerox: https://docs.0x.org/docs/core-concepts/contracts and
 *   https://github.com/0xProject/0x-settler (README Deployments,
 *   AllowanceHolder Cancun) — 0x0000000000001fF3684f28c67538d4D072C22734
 *   on Ethereum, Optimism, BNB Chain, Polygon, Base, Arbitrum (all six are
 *   Cancun chains in both sources).
 * - odos: https://docs.odos.xyz/build/contracts and
 *   https://github.com/odos-xyz/odos-router-v2 (README Chain Deployments) —
 *   per-chain OdosRouterV2 deployments, see inline comments.
 * - lifi: https://docs.li.fi/smart-contracts/deployments-contract-addresses
 *   and https://github.com/lifinance/contracts/blob/main/deployments/
 *   {mainnet,optimism,bsc,polygon,base,arbitrum}.json — LiFiDiamond
 *   0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE on all six chains.
 * - squid: https://docs.squidrouter.com/additional-resources/contracts and
 *   https://github.com/0xsquid/squid-sdk (src/handlers/evm/utils.spec.ts @
 *   80eaa3223241b1618ef8b6a26d44e22eb8da2541) — SquidRouter
 *   0xce16F69375520ab01377ce7B88f5BA8C48F8D666 on all six chains (BNB Chain
 *   is absent from every documented alternate-address exception list and the
 *   bytecode at the address is byte-identical on BSC/Ethereum/Base).
 */
export const AGGREGATOR_CONTRACT_ALLOWLIST: Readonly<
  Record<AggregatorName, Readonly<Record<number, readonly string[]>>>
> = {
  // 0x AllowanceHolder (Cancun) — same address on every supported chain.
  zerox: {
    1: ['0x0000000000001ff3684f28c67538d4d072c22734'],
    10: ['0x0000000000001ff3684f28c67538d4d072c22734'],
    56: ['0x0000000000001ff3684f28c67538d4d072c22734'],
    137: ['0x0000000000001ff3684f28c67538d4d072c22734'],
    8453: ['0x0000000000001ff3684f28c67538d4d072c22734'],
    42161: ['0x0000000000001ff3684f28c67538d4d072c22734'],
    43114: ['0x0000000000001ff3684f28c67538d4d072c22734'],
  },
  // OdosRouterV2 — distinct deployment per chain.
  odos: {
    1: ['0xcf5540fffcdc3d510b18bfca6d2b9987b0772559'], // 0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559
    10: ['0xca423977156bb05b13a2ba3b76bc5419e2fe9680'], // 0xCa423977156BB05b13A2BA3b76Bc5419E2fE9680
    56: ['0x89b8aa89fdd0507a99d334cbe3c808fafc7d850e'], // 0x89b8AA89FDd0507a99d334CBe3C808fAFC7d850E
    137: ['0x4e3288c9ca110bcc82bf38f09a7b425c095d92bf'], // 0x4E3288c9ca110bCC82bf38F09A7b425c095d92Bf
    8453: ['0x19ceead7105607cd444f5ad10dd51356436095a1'], // 0x19cEeAd7105607Cd444F5ad10dd51356436095a1
    42161: ['0xa669e7a0d4b3e4fa48af2de86bd4cd7126be4e13'], // 0xa669e7A0d4b3e4Fa48af2dE86BD4CD7126Be4e13
    43114: ['0x88de50b233052e4fb783d4f6db78cc34fea3e9fc'], // 0x88de50B233052e4Fb783d4F6db78Cc34fEa3e9FC (OdosRouterV2 on Avalanche — distinct per-chain deployment)
  },
  // LiFiDiamond — same address on every supported chain.
  lifi: {
    1: ['0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'],
    10: ['0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'],
    56: ['0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'],
    137: ['0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'],
    8453: ['0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'],
    42161: ['0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'],
    43114: ['0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'],
  },
  // SquidRouter — same address on every supported chain.
  squid: {
    1: ['0xce16f69375520ab01377ce7b88f5ba8c48f8d666'],
    10: ['0xce16f69375520ab01377ce7b88f5ba8c48f8d666'],
    56: ['0xce16f69375520ab01377ce7b88f5ba8c48f8d666'],
    137: ['0xce16f69375520ab01377ce7b88f5ba8c48f8d666'],
    8453: ['0xce16f69375520ab01377ce7b88f5ba8c48f8d666'],
    42161: ['0xce16f69375520ab01377ce7b88f5ba8c48f8d666'],
    43114: ['0xce16f69375520ab01377ce7b88f5ba8c48f8d666'],
  },
  // ParaSwap adapter is disabled backend-side; no verification was attempted.
  // Deliberately empty (fail-open + warning), mirroring the backend.
  paraswap: {
    1: [],
    10: [],
    56: [],
    137: [],
    8453: [],
    42161: [],
    43114: [],
  },
};

/**
 * Verified contracts for an aggregator+chain pair. Returns `[]` both for
 * deliberately-empty pairs (ParaSwap) and unknown aggregators/chains —
 * callers treat an empty result as "cannot verify": fail closed, unless
 * the aggregator is in the known-disabled set (then fail open with a
 * warning). Never treat an empty result as a verified match.
 */
export function getVerifiedAggregatorContracts(
  aggregator: AggregatorName,
  chainId: number,
): readonly string[] {
  return AGGREGATOR_CONTRACT_ALLOWLIST[aggregator]?.[chainId] ?? [];
}
