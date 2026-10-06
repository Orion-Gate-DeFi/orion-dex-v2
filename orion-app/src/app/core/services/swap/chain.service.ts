/**
 * Chain Service
 * Handles chain-related utilities and constants
 */
import { Injectable } from '@angular/core';

/** Supported chain IDs */
export const SUPPORTED_CHAINS = [1, 42161, 8453, 137, 10, 56, 43114] as const;
export type SupportedChainId = (typeof SUPPORTED_CHAINS)[number];

/** Chain metadata */
interface ChainInfo {
  name: string;
  shortName: string;
  explorer: string;
  nativeSymbol: string;
  logoUrl: string;
}

const CHAIN_INFO: Record<number, ChainInfo> = {
  1: {
    name: 'Ethereum',
    shortName: 'ETH',
    explorer: 'https://etherscan.io',
    nativeSymbol: 'ETH',
    logoUrl: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/ethereum.svg',
  },
  42161: {
    name: 'Arbitrum',
    shortName: 'ARB',
    explorer: 'https://arbiscan.io',
    nativeSymbol: 'ETH',
    logoUrl: 'chains/arbitrum.svg',
  },
  8453: {
    name: 'Base',
    shortName: 'BASE',
    explorer: 'https://basescan.org',
    nativeSymbol: 'ETH',
    logoUrl: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/base.svg',
  },
  137: {
    name: 'Polygon',
    shortName: 'MATIC',
    explorer: 'https://polygonscan.com',
    nativeSymbol: 'MATIC',
    logoUrl: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/polygon.svg',
  },
  10: {
    name: 'Optimism',
    shortName: 'OP',
    explorer: 'https://optimistic.etherscan.io',
    nativeSymbol: 'ETH',
    logoUrl: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/optimism.svg',
  },
  56: {
    name: 'BNB Chain',
    shortName: 'BNB',
    explorer: 'https://bscscan.com',
    nativeSymbol: 'BNB',
    logoUrl: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/bsc.svg',
  },
  43114: {
    name: 'Avalanche',
    shortName: 'AVAX',
    explorer: 'https://snowscan.xyz',
    nativeSymbol: 'AVAX',
    logoUrl: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/avalanche.svg',
  },
};

@Injectable({
  providedIn: 'root',
})
export class ChainService {
  /**
   * Get chain name by ID
   */
  getChainName(chainId: number): string {
    return CHAIN_INFO[chainId]?.name || `Chain ${chainId}`;
  }

  /**
   * Get short chain name
   */
  getChainShortName(chainId: number): string {
    return CHAIN_INFO[chainId]?.shortName || `${chainId}`;
  }

  /**
   * Get chain logo URL
   */
  getChainLogo(chainId: number): string {
    return (
      CHAIN_INFO[chainId]?.logoUrl ||
      'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/ethereum.svg'
    );
  }

  /**
   * Get native token symbol
   */
  getNativeSymbol(chainId: number): string {
    return CHAIN_INFO[chainId]?.nativeSymbol || 'ETH';
  }

  /**
   * Get block explorer base URL
   */
  getExplorerBaseUrl(chainId: number): string {
    return CHAIN_INFO[chainId]?.explorer || 'https://etherscan.io';
  }

  /**
   * Get transaction explorer URL
   */
  getExplorerUrl(chainId: number, txHash: string): string {
    return `${this.getExplorerBaseUrl(chainId)}/tx/${txHash}`;
  }

  /**
   * Get address explorer URL
   */
  getAddressExplorerUrl(chainId: number, address: string): string {
    return `${this.getExplorerBaseUrl(chainId)}/address/${address}`;
  }

  /**
   * Check if chain is supported
   */
  isSupported(chainId: number): boolean {
    return chainId in CHAIN_INFO;
  }

  /**
   * Get all supported chains
   */
  getSupportedChains(): number[] {
    return [...SUPPORTED_CHAINS];
  }

  /**
   * Check if swap is cross-chain
   */
  isCrossChain(fromChainId: number, toChainId: number): boolean {
    return fromChainId !== toChainId;
  }
}
