/**
 * =============================================================================
 * TOKEN MODELS
 * =============================================================================
 * 
 * This file defines TypeScript interfaces for tokens and chains.
 * Also contains hardcoded popular tokens per chain for quick selection.
 * 
 * @author Orion DEX Team
 * @version 2.0.0
 */

// =============================================================================
// INTERFACES
// =============================================================================

/**
 * Represents a cryptocurrency token (ERC20 or native)
 */
export interface Token {
  /** Contract address (0x0...0 for native tokens like ETH) */
  address: string;
  
  /** Token symbol (e.g., "ETH", "USDC") */
  symbol: string;
  
  /** Full token name (e.g., "Ethereum", "USD Coin") */
  name: string;
  
  /** Number of decimal places (e.g., 18 for ETH, 6 for USDC) */
  decimals: number;
  
  /** Chain ID where this token exists */
  chainId: number;
  
  /** URL to token logo image */
  logoURI?: string;
  
  /** Current price in USD */
  priceUSD?: string;
  
  /** User's balance of this token (populated by wallet service) */
  balance?: string;
}

/**
 * Token with balance information
 * Extends Token with required balance field
 */
export interface TokenBalance extends Token {
  /** User's balance of this token */
  balance: string;
  
  /** Balance value in USD */
  balanceUSD?: string;
}

/**
 * Represents a blockchain network
 */
export interface Chain {
  /** Chain ID (e.g., 1 for Ethereum, 42161 for Arbitrum) */
  id: number;
  
  /** Human-readable chain name */
  name: string;
  
  /** URL to chain logo image */
  logoURI: string;
  
  /** The native token of this chain (ETH, MATIC, etc.) */
  nativeToken: Token;
}

// =============================================================================
// POPULAR TOKENS PER CHAIN
// =============================================================================

/**
 * Hardcoded popular tokens for quick selection in UI
 * Key = chainId, Value = array of popular tokens on that chain
 * 
 * These are shown first in the token selector for convenience.
 * Addresses are MAINNET addresses - do not use on testnets!
 */
// Token logo URLs from multiple reliable sources (CoinGecko CDN). Exported so
// the login-orb easter egg can reuse the same canonical supported-token icons.
export const LOGOS = {
  ETH: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
  USDC: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
  USDT: 'https://assets.coingecko.com/coins/images/325/small/Tether.png',
  WBTC: 'https://assets.coingecko.com/coins/images/7598/small/wrapped_bitcoin_wbtc.png',
  ARB: 'https://assets.coingecko.com/coins/images/16547/small/photo_2023-03-29_21.47.00.jpeg',
  OP: 'https://assets.coingecko.com/coins/images/25244/small/Optimism.png',
  MATIC: 'https://assets.coingecko.com/coins/images/4713/small/polygon.png',
  DAI: 'https://assets.coingecko.com/coins/images/9956/small/Badge_Dai.png',
  WETH: 'https://assets.coingecko.com/coins/images/2518/small/weth.png',
  BNB: 'https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png',
  AVAX: 'https://assets.coingecko.com/coins/images/12559/small/Avalanche_Circle_RedWhite_Trans.png',
};

export const POPULAR_TOKENS: Record<number, Token[]> = {
  // ---------------------------------------------------------------------------
  // Ethereum Mainnet (Chain ID: 1)
  // ---------------------------------------------------------------------------
  1: [
    {
      address: '0x0000000000000000000000000000000000000000',
      symbol: 'ETH',
      name: 'Ethereum',
      decimals: 18,
      chainId: 1,
      logoURI: LOGOS.ETH,
    },
    {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      chainId: 1,
      logoURI: LOGOS.USDC,
    },
    {
      address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      chainId: 1,
      logoURI: LOGOS.USDT,
    },
    {
      address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
      symbol: 'WBTC',
      name: 'Wrapped Bitcoin',
      decimals: 8,
      chainId: 1,
      logoURI: LOGOS.WBTC,
    },
  ],

  // ---------------------------------------------------------------------------
  // Arbitrum One (Chain ID: 42161)
  // ---------------------------------------------------------------------------
  42161: [
    {
      address: '0x0000000000000000000000000000000000000000',
      symbol: 'ETH',
      name: 'Ethereum',
      decimals: 18,
      chainId: 42161,
      logoURI: LOGOS.ETH,
    },
    {
      address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      chainId: 42161,
      logoURI: LOGOS.USDC,
    },
    {
      address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      chainId: 42161,
      logoURI: LOGOS.USDT,
    },
    {
      address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
      symbol: 'ARB',
      name: 'Arbitrum',
      decimals: 18,
      chainId: 42161,
      logoURI: LOGOS.ARB,
    },
  ],

  // ---------------------------------------------------------------------------
  // Base (Chain ID: 8453)
  // ---------------------------------------------------------------------------
  8453: [
    {
      address: '0x0000000000000000000000000000000000000000',
      symbol: 'ETH',
      name: 'Ethereum',
      decimals: 18,
      chainId: 8453,
      logoURI: LOGOS.ETH,
    },
    {
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      chainId: 8453,
      logoURI: LOGOS.USDC,
    },
    {
      address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
      symbol: 'DAI',
      name: 'Dai Stablecoin',
      decimals: 18,
      chainId: 8453,
      logoURI: LOGOS.DAI,
    },
  ],

  // ---------------------------------------------------------------------------
  // Polygon (Chain ID: 137)
  // ---------------------------------------------------------------------------
  137: [
    {
      address: '0x0000000000000000000000000000000000000000',
      symbol: 'MATIC',
      name: 'Polygon',
      decimals: 18,
      chainId: 137,
      logoURI: LOGOS.MATIC,
    },
    {
      address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      chainId: 137,
      logoURI: LOGOS.USDC,
    },
    {
      address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      chainId: 137,
      logoURI: LOGOS.USDT,
    },
    {
      address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
      chainId: 137,
      logoURI: LOGOS.WETH,
    },
  ],

  // ---------------------------------------------------------------------------
  // Optimism (Chain ID: 10)
  // ---------------------------------------------------------------------------
  10: [
    {
      address: '0x0000000000000000000000000000000000000000',
      symbol: 'ETH',
      name: 'Ethereum',
      decimals: 18,
      chainId: 10,
      logoURI: LOGOS.ETH,
    },
    {
      address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      chainId: 10,
      logoURI: LOGOS.USDC,
    },
    {
      address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      chainId: 10,
      logoURI: LOGOS.USDT,
    },
    {
      address: '0x4200000000000000000000000000000000000042',
      symbol: 'OP',
      name: 'Optimism',
      decimals: 18,
      chainId: 10,
      logoURI: LOGOS.OP,
    },
  ],

  // ---------------------------------------------------------------------------
  // BNB Chain (Chain ID: 56)
  // NOTE: Binance-Peg USDC / USDT / ETH are 18-decimal tokens on BSC —
  // do NOT copy the 6-decimal values from the other chains.
  // ---------------------------------------------------------------------------
  56: [
    {
      address: '0x0000000000000000000000000000000000000000',
      symbol: 'BNB',
      name: 'BNB',
      decimals: 18,
      chainId: 56,
      logoURI: LOGOS.BNB,
    },
    {
      address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 18,
      chainId: 56,
      logoURI: LOGOS.USDC,
    },
    {
      address: '0x55d398326f99059fF775485246999027B3197955',
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 18,
      chainId: 56,
      logoURI: LOGOS.USDT,
    },
    {
      address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
      symbol: 'ETH',
      name: 'Ethereum',
      decimals: 18,
      chainId: 56,
      logoURI: LOGOS.ETH,
    },
  ],

  // ---------------------------------------------------------------------------
  // Avalanche C-Chain (Chain ID: 43114)
  // Native USDC / USDt are the 6-decimal Circle/Tether-issued tokens — NOT the
  // bridged .e variants (USDC.e 0xA7D7…4C664 / USDT.e). Aggregators route the
  // native tokens by default.
  // ---------------------------------------------------------------------------
  43114: [
    {
      address: '0x0000000000000000000000000000000000000000',
      symbol: 'AVAX',
      name: 'Avalanche',
      decimals: 18,
      chainId: 43114,
      logoURI: LOGOS.AVAX,
    },
    {
      address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      chainId: 43114,
      logoURI: LOGOS.USDC,
    },
    {
      address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      chainId: 43114,
      logoURI: LOGOS.USDT,
    },
    {
      address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
      symbol: 'WAVAX',
      name: 'Wrapped AVAX',
      decimals: 18,
      chainId: 43114,
      logoURI: LOGOS.AVAX,
    },
  ],
};

// =============================================================================
// NETWORK OPTIONS (for UI)
// =============================================================================

/**
 * Network option for display in UI
 * Simplified version of Chain for the network selector
 */
export interface NetworkOption {
  id: number;
  name: string;
  logoURI: string;
  fees: 'high' | 'low';  // Indicates typical transaction fee level
}

/**
 * Available networks for the token selector
 */
export const NETWORKS: NetworkOption[] = [
  { id: 1, name: 'Ethereum', logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/ethereum.svg', fees: 'high' },
  { id: 42161, name: 'Arbitrum', logoURI: 'chains/arbitrum.svg', fees: 'low' },
  { id: 8453, name: 'Base', logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/base.svg', fees: 'low' },
  { id: 137, name: 'Polygon', logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/polygon.svg', fees: 'low' },
  { id: 10, name: 'Optimism', logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/optimism.svg', fees: 'low' },
  { id: 56, name: 'BNB Chain', logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/bsc.svg', fees: 'low' },
  { id: 43114, name: 'Avalanche', logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/avalanche.svg', fees: 'low' },
];

// =============================================================================
// RWA (REAL-WORLD ASSET) TOKEN CURATION
// =============================================================================

/**
 * Curated symbols for the token selector's RWA tab — tokenized treasuries,
 * gold, private credit, and RWA-protocol governance tokens.
 *
 * Deliberately a SYMBOL allowlist, not hardcoded addresses: candidates are
 * matched against the verified LI.FI token list for the active chain and
 * must carry a positive priceUSD (indexed liquidity). Hand-typed addresses
 * are the single most dangerous thing to get wrong in a DEX; if we later
 * want per-address pinning, each entry must be verified against the
 * issuer's official docs in its own review.
 */
// NOTE: tokenized-treasury *securities* (USDY, OUSG, USTB) were removed
// 2026-06-20. They are transfer-gated at the contract layer (on-chain
// allowlist / blocklist / sanctions-oracle checks, qualified-purchaser
// thresholds), so a swap that delivers them to an unvetted retail wallet
// reverts — they are not freely DEX-tradable and must not be offered as a
// swap target. Only freely-transferable, DEX-liquid RWA stays. See the deep
// research write-up in docs/ for the per-issuer compliance breakdown.
export const RWA_TOKEN_INFO: Readonly<Record<string, string>> = {
  // Treasury-yield governance token (the ONDO token is a permissionless
  // ERC-20 — distinct from Ondo's gated USDY/OUSG fund tokens).
  ONDO: 'Treasury yield protocol',
  // Tokenized gold — the only tokenized-asset RWA that is both freely
  // transferable and meaningfully liquid on EVM.
  PAXG: 'Tokenized gold',
  XAUT: 'Tokenized gold',
  // Private credit / lending protocol tokens (permissionless governance
  // tokens, not the gated credit pools themselves).
  TRU: 'Private credit',
  CPOOL: 'Private credit',
  MPL: 'Private credit',
  GFI: 'Private credit',
  CFG: 'RWA infrastructure',
  // RWA-adjacent reserve assets
  RSR: 'Reserve-backed assets',
};

export const RWA_TOKEN_SYMBOLS: ReadonlySet<string> = new Set(Object.keys(RWA_TOKEN_INFO));

/**
 * Family rules for tokenized stocks/ETFs.
 *
 * INTENTIONALLY EMPTY since 2026-06-20. Tokenized equities (Backed xStocks
 * "AAPLx" + bTokens "bTSLA") were dropped from the RWA tab: on the EVM chains
 * we support they have effectively no DEX liquidity (~$0–$224; the real market
 * is Solana, which we don't support), so LI.FI cannot route them — and they
 * additionally carry hard geo-restrictions (no US/CA/UK/AU). Re-introducing
 * tokenized equities requires either Solana support or LI.FI's permissioned
 * intents layer; see the deep-research write-up in docs/. The rule machinery
 * is kept so the category can be re-enabled by re-adding entries here.
 */
export interface RwaFamilyRule {
  category: string;
  symbolPattern: RegExp;
  namePattern: RegExp;
  /** Chains where the genuine issuance exists (live-verified 2026-06). */
  chains: readonly number[];
  maxPriceUSD: number;
}

export const RWA_STOCK_FAMILIES: readonly RwaFamilyRule[] = [];

/**
 * Verified contract addresses for flagship RWA tokens (Ethereum mainnet).
 *
 * Provenance: dual-source verified 2026-06-10 — address taken from the
 * LI.FI token list (highest-volume candidate per symbol), then confirmed by
 * an independent CoinGecko reverse contract lookup returning the matching
 * symbol+name. Re-verify the same way before adding entries; NEVER add an
 * address from memory or a single source.
 *
 * Keys are UPPERCASED symbols; addresses lowercase. A pin is an exact-match
 * override on its chain: a token claiming a pinned symbol on that chain
 * with a different address is rejected outright. On chains without a pin,
 * the layered rules (symbol allowlist / family guards) still apply.
 */
export const RWA_PINNED_ADDRESSES: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  // Tokenized gold + the ONDO governance token — the freely-transferable,
  // DEX-liquid RWA we surface. The Backed xStocks/bTokens pins and the
  // transfer-gated USDY pin were removed 2026-06-20 (see RWA_TOKEN_INFO and
  // RWA_STOCK_FAMILIES notes): illiquid on EVM / not freely swappable.
  PAXG:  { 1: '0x45804880de22913dafe09f4980848ece6ecbaf78' },
  XAUT:  { 1: '0x68749665ff8d2d112fa859aa293f07a622782f38' },
  ONDO:  { 1: '0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3' },
};

/**
 * Chains on which the curated RWA set has genuine, verified issuance — the
 * union of every family rule's `chains` and every pinned address's chain.
 * The token selector's RWA tab restricts the network picker to these: on any
 * other chain (Optimism, BNB) every "RWA" row would be a ticker-squatter
 * with no curated counterpart, so we don't even offer those networks.
 *
 * Derived (not hand-listed) so it can never drift from the rules above:
 * adding a chain to a family or a pin extends the tab automatically.
 * Currently resolves to Ethereum only (PAXG/XAUT/ONDO pins, all on chain 1;
 * stock families are empty). Adding L2 gold/ONDO pins would extend it.
 */
export const RWA_CHAINS: readonly number[] = (() => {
  const chains = new Set<number>();
  for (const rule of RWA_STOCK_FAMILIES) {
    for (const chainId of rule.chains) chains.add(chainId);
  }
  for (const pins of Object.values(RWA_PINNED_ADDRESSES)) {
    for (const chainId of Object.keys(pins)) chains.add(Number(chainId));
  }
  return [...chains].sort((a, b) => a - b);
})();

export type RwaPinVerdict = 'match' | 'mismatch' | 'unpinned';

/** Exact-match check against the pinned registry (see provenance above). */
export function rwaPinVerdict(symbol: string, chainId: number, address: string): RwaPinVerdict {
  const pins = RWA_PINNED_ADDRESSES[symbol.toUpperCase()];
  const pinned = pins?.[chainId];
  if (!pinned) return 'unpinned';
  return pinned === address.toLowerCase() ? 'match' : 'mismatch';
}

/**
 * Match a token against the stock families. `strict` enforces the family's
 * chain list, plus the price cap WHEN a price is supplied (selector lists pass
 * both; the GoPlus security context passes `{ chainId }` only — price isn't in
 * the GoPlus payload). Without `strict`, only the symbol+name shape is checked.
 */
export function matchesRwaStockFamily(
  symbol: string,
  name: string,
  strict?: { chainId: number; priceUSD?: number },
): RwaFamilyRule | null {
  for (const rule of RWA_STOCK_FAMILIES) {
    if (!rule.symbolPattern.test(symbol) || !rule.namePattern.test(name)) continue;
    if (strict) {
      if (!rule.chains.includes(strict.chainId)) continue;
      // Price cap only when a price is available; the chain guard above is the
      // load-bearing check for the price-less GoPlus context.
      if (strict.priceUSD !== undefined && (!(strict.priceUSD > 0) || strict.priceUSD > rule.maxPriceUSD)) continue;
    }
    return rule;
  }
  return null;
}
