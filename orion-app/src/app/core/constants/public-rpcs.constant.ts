/**
 * =============================================================================
 * PUBLIC RPC ENDPOINTS
 * =============================================================================
 *
 * Per-chain public RPC fallbacks — the SINGLE source of truth (WalletService's
 * former private RPC_URLS list was merged in here; don't re-introduce local
 * copies, they drift). Used when:
 * - The wallet provider is on a different chain (balance / gas-price fetch).
 * - The wallet provider's receipt parser breaks on Privy's `nonce: "undefined"`
 *   payload (post-broadcast receipt verification in swap execution).
 *
 * Order matters: first entry is tried first, fall through on failure.
 * llamarpc intentionally omitted — 429s arrive within seconds of any traffic.
 * rpc.ankr.com intentionally omitted — keyless access is deprecated/rejected.
 */

export const PUBLIC_RPCS: Record<number, string[]> = {
  1: ['https://cloudflare-eth.com', 'https://ethereum.publicnode.com', 'https://eth.drpc.org'],
  42161: ['https://arbitrum.publicnode.com', 'https://arb1.arbitrum.io/rpc', 'https://arbitrum.drpc.org'],
  8453: ['https://base.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org'],
  137: ['https://polygon-bor.publicnode.com', 'https://polygon-rpc.com', 'https://polygon.drpc.org'],
  10: ['https://optimism.publicnode.com', 'https://mainnet.optimism.io', 'https://optimism.drpc.org'],
  56: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc.drpc.org'],
  43114: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://avalanche.drpc.org', 'https://api.avax.network/ext/bc/C/rpc'],
};
