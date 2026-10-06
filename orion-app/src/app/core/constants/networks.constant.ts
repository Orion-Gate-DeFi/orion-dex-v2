/**
 * =============================================================================
 * NETWORKS CONSTANTS
 * =============================================================================
 * 
 * Centralized network/chain configuration for the entire application.
 * Used for network selection, display, and blockchain interactions.
 * 
 * @author Orion DEX Team
 * @version 1.0.0
 */

// =============================================================================
// TYPES
// =============================================================================

export type FeeLevel = 'low' | 'medium' | 'high';

export interface NetworkInfo {
  id: number;
  name: string;
  shortName: string;
  logoURI: string;
  explorerUrl: string;
  explorerName: string;
  nativeSymbol: string;
  fees: FeeLevel;
  recommended?: boolean;
  color?: string;
}

// =============================================================================
// SUPPORTED NETWORKS
// =============================================================================

/**
 * List of supported networks with full configuration
 */
export const NETWORKS: NetworkInfo[] = [
  {
    id: 1,
    name: 'Ethereum',
    shortName: 'ETH',
    logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/ethereum.svg',
    explorerUrl: 'https://etherscan.io',
    explorerName: 'Etherscan',
    nativeSymbol: 'ETH',
    fees: 'high',
    color: '#627EEA',
  },
  {
    id: 42161,
    name: 'Arbitrum',
    shortName: 'ARB',
    // Self-hosted: the LI.FI asset ships a square #2C374B backdrop that reads
    // as a dark plate among the otherwise-transparent chain marks. Same
    // artwork, backdrop rect stripped (public/chains/arbitrum.svg).
    logoURI: 'chains/arbitrum.svg',
    explorerUrl: 'https://arbiscan.io',
    explorerName: 'Arbiscan',
    nativeSymbol: 'ETH',
    fees: 'low',
    recommended: true,
    color: '#28A0F0',
  },
  {
    id: 8453,
    name: 'Base',
    shortName: 'BASE',
    logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/base.svg',
    explorerUrl: 'https://basescan.org',
    explorerName: 'BaseScan',
    nativeSymbol: 'ETH',
    fees: 'low',
    recommended: true,
    color: '#0052FF',
  },
  {
    id: 137,
    name: 'Polygon',
    // Polygon's gas token migrated MATIC → POL (Sept 2024, 1:1).
    shortName: 'POL',
    logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/polygon.svg',
    explorerUrl: 'https://polygonscan.com',
    explorerName: 'PolygonScan',
    nativeSymbol: 'POL',
    fees: 'low',
    color: '#8247E5',
  },
  {
    id: 10,
    name: 'Optimism',
    shortName: 'OP',
    logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/optimism.svg',
    explorerUrl: 'https://optimistic.etherscan.io',
    explorerName: 'Optimism Explorer',
    nativeSymbol: 'ETH',
    fees: 'low',
    color: '#FF0420',
  },
  {
    id: 56,
    name: 'BNB Chain',
    shortName: 'BNB',
    logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/bsc.svg',
    explorerUrl: 'https://bscscan.com',
    explorerName: 'BscScan',
    nativeSymbol: 'BNB',
    fees: 'low',
    color: '#F0B90B',
  },
  {
    id: 43114,
    name: 'Avalanche',
    shortName: 'AVAX',
    logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/avalanche.svg',
    // Snowscan is Etherscan's Avalanche product — same /tx/ + /address/ path
    // shape as the other explorers here (snowtrace.io moved to Routescan and
    // Cloudflare-gates plain HTTP).
    explorerUrl: 'https://snowscan.xyz',
    explorerName: 'Snowscan',
    nativeSymbol: 'AVAX',
    fees: 'low',
    color: '#E84142',
  },
];

// =============================================================================
// LOOKUP MAPS (for fast access)
// =============================================================================

/**
 * Map of network ID to NetworkInfo for O(1) lookup
 */
export const NETWORK_BY_ID: Record<number, NetworkInfo> = NETWORKS.reduce(
  (acc, network) => {
    acc[network.id] = network;
    return acc;
  },
  {} as Record<number, NetworkInfo>
);

/**
 * Set of supported network IDs for O(1) lookup
 */
export const SUPPORTED_CHAIN_IDS: Set<number> = new Set(NETWORKS.map(n => n.id));

/**
 * Check if a network is supported
 */
export function isSupportedNetwork(chainId: number): boolean {
  return SUPPORTED_CHAIN_IDS.has(chainId);
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get network info by chain ID
 */
export function getNetworkById(chainId: number): NetworkInfo | undefined {
  return NETWORK_BY_ID[chainId];
}

/**
 * Get network name by chain ID
 */
export function getNetworkName(chainId: number): string {
  return NETWORK_BY_ID[chainId]?.name || `Chain ${chainId}`;
}

/**
 * Get network logo URL by chain ID
 */
export function getNetworkLogo(chainId: number): string {
  return NETWORK_BY_ID[chainId]?.logoURI || 
    'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/ethereum.svg';
}

/**
 * Get block explorer URL for a transaction
 */
export function getExplorerTxUrl(chainId: number, txHash: string): string {
  const network = NETWORK_BY_ID[chainId];
  if (!network) return `https://etherscan.io/tx/${txHash}`;
  return `${network.explorerUrl}/tx/${txHash}`;
}

/**
 * Get block explorer URL for an address
 */
export function getExplorerAddressUrl(chainId: number, address: string): string {
  const network = NETWORK_BY_ID[chainId];
  if (!network) return `https://etherscan.io/address/${address}`;
  return `${network.explorerUrl}/address/${address}`;
}

/**
 * Check if network is an L2 (low fees)
 */
export function isL2Network(chainId: number): boolean {
  const network = NETWORK_BY_ID[chainId];
  return network?.fees === 'low';
}

/**
 * Get list of recommended networks (for beginners)
 */
export function getRecommendedNetworks(): NetworkInfo[] {
  return NETWORKS.filter(n => n.recommended);
}

/**
 * Get fee level display info
 */
export function getFeeLevelInfo(level: FeeLevel): { label: string; emoji: string; color: string } {
  switch (level) {
    case 'low':
      return { label: 'Low', emoji: '💚', color: 'text-emerald-400' };
    case 'medium':
      return { label: 'Medium', emoji: '💛', color: 'text-yellow-400' };
    case 'high':
      return { label: 'High', emoji: '🔴', color: 'text-red-400' };
  }
}

