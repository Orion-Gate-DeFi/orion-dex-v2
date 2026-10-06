/**
 * =============================================================================
 * WALLET SERVICE
 * =============================================================================
 *
 * This service handles all wallet-related functionality:
 * - Connecting to MetaMask or other Web3 wallets via window.ethereum
 * - Managing wallet state (address, chain, balance)
 * - Switching between different blockchain networks
 * - Fetching token balances across multiple chains
 *
 * Uses Angular Signals for reactive state management.
 *
 * Balance fetches on foreign chains go through the canonical PUBLIC_RPCS
 * list via the shared RpcPoolService (provider cache + circuit breaker,
 * shared with GasService).
 *
 * @author Orion DEX Team
 * @version 2.2.0
 */

import { Injectable, signal, computed, inject } from '@angular/core';
import { BrowserProvider, JsonRpcSigner, JsonRpcProvider, formatEther, formatUnits, Contract } from 'ethers';
import { Token, TokenBalance, Chain } from '../models/token.model';
import { TransactionHistoryService } from './transaction-history.service';
import { RpcPoolService } from './rpc-pool.service';
import { PUBLIC_RPCS } from '../constants/public-rpcs.constant';
import { getNetworkName } from '../constants/networks.constant';
import { AnalyticsService } from './analytics.service';

// =============================================================================
// INTERFACES
// =============================================================================

/**
 * Represents the current state of the wallet connection.
 * Used by components to reactively display wallet status.
 */
export interface WalletState {
  isConnected: boolean | null;      // True if wallet is connected
  isConnecting: boolean;     // True during connection process
  address: string | null;    // User's wallet address (0x...)
  chainId: number | null;    // Current network chain ID (1 = Ethereum, etc.)
  balance: string;           // Native token balance (ETH, MATIC, etc.)
  error: string | null;      // Error message if connection failed
}

/**
 * How far Privy's fiat on-ramp got before the modal closed. 'confirmed' means
 * the user completed Privy's confirmation step; 'submitted' means the payment
 * cleared at the provider but the user left before that step — the funds are
 * still on their way, so it is a pending state, never a failure.
 *
 * Mirrors the union PrivyWrapper.tsx declares for the same values. It is
 * re-declared rather than imported because the React island must stay out of
 * the Angular module graph (see privy-bridge.ts / session-login.ts).
 */
export type FundingStatus = 'submitted' | 'confirmed';

// =============================================================================
// SUPPORTED CHAINS CONFIGURATION
// =============================================================================
// List of blockchain networks supported by Orion DEX.
// Each chain includes its native token info for display purposes.

const SUPPORTED_CHAINS: Chain[] = [
  {
    id: 1,
    name: 'Ethereum',
    logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/ethereum.svg',
    nativeToken: {
      address: '0x0000000000000000000000000000000000000000', // Zero address = native token
      symbol: 'ETH',
      name: 'Ethereum',
      decimals: 18,
      chainId: 1,
    },
  },
  {
    id: 42161,
    name: 'Arbitrum',
    logoURI: 'chains/arbitrum.svg',
    nativeToken: {
      address: '0x0000000000000000000000000000000000000000',
      symbol: 'ETH',
      name: 'Ethereum',
      decimals: 18,
      chainId: 42161,
    },
  },
  {
    id: 137,
    name: 'Polygon',
    logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/polygon.svg',
    nativeToken: {
      address: '0x0000000000000000000000000000000000000000',
      // Polygon's gas token migrated MATIC → POL (Sept 2024, 1:1).
      symbol: 'POL',
      name: 'Polygon Ecosystem Token',
      decimals: 18,
      chainId: 137,
    },
  },
  {
    id: 10,
    name: 'Optimism',
    logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/optimism.svg',
    nativeToken: {
      address: '0x0000000000000000000000000000000000000000',
      symbol: 'ETH',
      name: 'Ethereum',
      decimals: 18,
      chainId: 10,
    },
  },
  {
    id: 8453,
    name: 'Base',
    logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/base.svg',
    nativeToken: {
      address: '0x0000000000000000000000000000000000000000',
      symbol: 'ETH',
      name: 'Ethereum',
      decimals: 18,
      chainId: 8453,
    },
  },
  {
    id: 56,
    name: 'BNB Chain',
    logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/bsc.svg',
    nativeToken: {
      address: '0x0000000000000000000000000000000000000000',
      symbol: 'BNB',
      name: 'BNB',
      decimals: 18,
      chainId: 56,
    },
  },
  {
    id: 43114,
    name: 'Avalanche',
    logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/avalanche.svg',
    nativeToken: {
      address: '0x0000000000000000000000000000000000000000',
      symbol: 'AVAX',
      name: 'Avalanche',
      decimals: 18,
      chainId: 43114,
    },
  },
];

// =============================================================================
// WALLET SERVICE
// =============================================================================

@Injectable({
  providedIn: 'root', // Singleton - available throughout the app
})
export class WalletService {
  // ---------------------------------------------------------------------------
  // Private Properties
  // ---------------------------------------------------------------------------

  /** Ethers.js provider for blockchain interactions */
  private provider: BrowserProvider | null = null;

  /** Signer for signing transactions */
  private signer: JsonRpcSigner | null = null;

  /** Raw ethereum provider (from Privy or MetaMask) for RPC calls */
  private ethereumProvider: any = null;

  /** Transaction history service for syncing wallet address */
  private txHistoryService = inject(TransactionHistoryService);

  /** Shared read-only provider cache + RPC circuit breaker (also GasService's). */
  private rpcPool = inject(RpcPoolService);

  /** Consent-gated product analytics (chain_selected on successful switch). */
  private analytics = inject(AnalyticsService);

  /**
   * Fiat on-ramp function registered by PrivyWrapper through the
   * `onFundWalletReady` callback prop (NOT a window global — a publicly
   * writable slot that opens a payment modal is a phishing surface). Null
   * until the lazy React mount completes, and again after the provider
   * component is destroyed. Lives here rather than on AuthService because
   * funding a wallet is a wallet operation, not a session one.
   */
  private walletFundingFn: ((address: string) => Promise<FundingStatus>) | null = null;

  // ---------------------------------------------------------------------------
  // Reactive State (Angular Signals)
  // ---------------------------------------------------------------------------

  /** Internal mutable state */
  private _state = signal<WalletState>({
    isConnected: false,
    isConnecting: false,
    address: null,
    chainId: null,
    balance: '0',
    error: null,
  });

  // ---------------------------------------------------------------------------
  // Public Computed Signals (Read-only access for components)
  // ---------------------------------------------------------------------------

  /** Full wallet state - use for complex state checks */
  readonly state = this._state.asReadonly();

  /** Quick check if wallet is connected */
  readonly isConnected = computed(() => this._state().isConnected);

  /** User's full wallet address */
  readonly address = computed(() => this._state().address);

  /** Current chain ID */
  readonly chainId = computed(() => this._state().chainId);

  /** Shortened address for display (0x1234...5678) */
  readonly shortAddress = computed(() => {
    const addr = this._state().address;
    return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : null;
  });

  /** Current chain info object */
  readonly currentChain = computed(() => {
    const chainId = this._state().chainId;
    return SUPPORTED_CHAINS.find((c) => c.id === chainId) || null;
  });

  /** List of all supported chains */
  readonly chains = SUPPORTED_CHAINS;

  readonly isConnectedInPrivy = signal<boolean | null>(null);

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor() {
    // Auto-reconnect if user was previously connected
    this.checkConnection();
    // Listen for wallet events (account/chain changes)
    this.setupEventListeners();
  }

  // ---------------------------------------------------------------------------
  // Connection Methods
  // ---------------------------------------------------------------------------

  /**
   * Check if user was previously connected and auto-reconnect
   * This runs on app startup to restore the session
   */
  private async checkConnection(): Promise<void> {
    // Skip if running on server (SSR) or no wallet installed
    if (typeof window === 'undefined' || !window.ethereum) return;

    try {
      // eth_accounts returns connected accounts without prompting
      const accounts = await window.ethereum.request({
        method: 'eth_accounts',
      });
      // If accounts exist, user was previously connected
      if (accounts && accounts.length > 0) {
        await this.connect();
      }
    } catch (error) {
      console.error('Error checking connection:', error);
    }
  }

  /**
   * Set up listeners for wallet events
   * - accountsChanged: User switched accounts or disconnected
   * - chainChanged: User switched networks
   */
  private setupEventListeners(): void {
    if (typeof window === 'undefined' || !window.ethereum) return;

    // Handle account changes
    window.ethereum.on('accountsChanged', (accounts: string[]) => {
      if (accounts.length === 0) {
        // User disconnected
        this.disconnect();
      } else {
        // User switched accounts
        this._state.update((s) => ({ ...s, address: accounts[0] }));
        // Sync new wallet address to transaction history service
        this.txHistoryService.setWallet(accounts[0]);
        this.updateBalance();
      }
    });

    // Handle network changes
    window.ethereum.on('chainChanged', (chainId: string) => {
      this._state.update((s) => ({
        ...s,
        chainId: parseInt(chainId, 16), // Convert hex to number
      }));
      this.updateBalance();
    });
  }

  /**
   * Register (or clear, with null) the fiat on-ramp function handed up by
   * PrivyWrapper's onFundWalletReady callback prop.
   */
  registerWalletFunding(fundFn: ((address: string) => Promise<FundingStatus>) | null): void {
    this.walletFundingFn = fundFn;
  }

  /**
   * Open Privy's fiat on-ramp so the user can buy crypto with a card. The
   * destination chain/token and the sandbox-vs-production switch are fixed
   * inside the React island — callers only choose the receiving address.
   *
   * Resolves with how far the flow got: 'confirmed' when the user completed
   * Privy's confirmation step, 'submitted' when the payment cleared at the
   * provider but the user left before that step.
   *
   * Throws when no funding function is registered (Privy not mounted yet) or
   * when Privy itself rejects. Privy also rejects when the user simply closes
   * the modal ('User exited flow' / 'Payment method selection was cancelled'),
   * so callers must treat those messages as a cancel, not an error.
   */
  async fundWallet(address: string): Promise<FundingStatus> {
    if (!this.walletFundingFn) {
      throw new Error('Buying crypto is unavailable — Privy is not ready');
    }
    return this.walletFundingFn(address);
  }

  /**
   * Connect to user's wallet via Privy modal
   * Opens Privy wallet selection modal
   *
   * @returns true if connection initiated
   */
  async connect(): Promise<boolean> {
    // Trigger Privy login modal via global function
    if (typeof window !== 'undefined' && (window as any).__privyTriggerLogin) {
      this._state.update((s) => ({ ...s, isConnecting: true, error: null }));
      (window as any).__privyTriggerLogin();
      return true;
    }
    // Fallback: direct MetaMask connection if Privy not available
    return this.connectDirect();
  }

  /**
   * Connect with provider from Privy
   * Called by PrivyProviderComponent after successful wallet connection
   *
   * @param address - Connected wallet address
   * @param ethereumProvider - Provider from Privy wallet
   */
  async connectWithProvider(address: string, ethereumProvider: any): Promise<void> {
    try {
      // Store raw provider for RPC calls (switchChain, etc.)
      this.ethereumProvider = ethereumProvider;

      // Create ethers provider from Privy's ethereum provider
      this.provider = new BrowserProvider(ethereumProvider);
      this.signer = await this.provider.getSigner();

      // Get network and balance
      const network = await this.provider.getNetwork();
      const balance = await this.provider.getBalance(address);

      // Update state with connected wallet info
      this._state.set({
        isConnected: true,
        isConnecting: false,
        address,
        chainId: Number(network.chainId),
        balance: formatEther(balance),
        error: null,
      });

      // Sync wallet address to transaction history service
      this.txHistoryService.setWallet(address);

      // Setup event listeners for the new provider
      this.setupProviderListeners(ethereumProvider);
    } catch (error: any) {
      console.error('Error connecting with Privy provider:', error);
      this._state.update((s) => ({
        ...s,
        isConnecting: false,
        error: error.message || 'Failed to connect wallet',
      }));
    }
  }

  /**
   * Setup listeners for Privy provider
   */
  private setupProviderListeners(provider: any): void {
    if (!provider) return;

    provider.on?.('accountsChanged', (accounts: string[]) => {
      if (accounts.length === 0) {
        this.disconnect();
      } else {
        this._state.update((s) => ({ ...s, address: accounts[0] }));
        // Sync new wallet address to transaction history service
        this.txHistoryService.setWallet(accounts[0]);
        this.updateBalance();
      }
    });

    provider.on?.('chainChanged', (chainId: string) => {
      this._state.update((s) => ({
        ...s,
        chainId: parseInt(chainId, 16),
      }));
      // ethers' BrowserProvider pins the network it detected at construction:
      // after the wallet switches chains, the next request on the old
      // instance throws NETWORK_ERROR ("network changed: 1 => 42161")
      // instead of answering. Rebuild provider + signer against the new
      // chain BEFORE any balance read — refreshConnection() recreates both
      // and refreshes the balance itself. It never re-enters switchChain or
      // re-emits wallet events, so a wallet-initiated switch can't recurse.
      void this.refreshConnection();
    });
  }

  /**
   * Fallback direct connection to MetaMask (if Privy not available)
   */
  private async connectDirect(): Promise<boolean> {
    if (typeof window === 'undefined' || !window.ethereum) {
      this._state.update((s) => ({
        ...s,
        error: 'No wallet found. Please install MetaMask or another wallet.',
      }));
      return false;
    }

    this._state.update((s) => ({ ...s, isConnecting: true, error: null }));

    try {
      this.provider = new BrowserProvider(window.ethereum);
      await this.provider.send('eth_requestAccounts', []);
      this.signer = await this.provider.getSigner();

      const address = await this.signer.getAddress();
      const network = await this.provider.getNetwork();
      const balance = await this.provider.getBalance(address);

      this._state.set({
        isConnected: true,
        isConnecting: false,
        address,
        chainId: Number(network.chainId),
        balance: formatEther(balance),
        error: null,
      });

      // Sync wallet address to transaction history service
      this.txHistoryService.setWallet(address);
      return true;
    } catch (error: any) {
      this._state.update((s) => ({
        ...s,
        isConnecting: false,
        error: error.message || 'Failed to connect wallet',
      }));
      return false;
    }
  }

  /**
   * Cancel the connecting state (e.g., when user closes the Privy modal without connecting)
   */
  cancelConnecting(): void {
    this._state.update(s => ({ ...s, isConnecting: false }));
  }

  /**
   * Disconnect wallet and reset state
   * Also logs out from Privy if available
   */
  disconnect(): void {
    // Logout from Privy if available. The lazy-bridge shim REJECTS on
    // abort/timeout — swallow here: local state is reset below regardless,
    // and an unhandled rejection would only add Sentry noise.
    if (typeof window !== 'undefined' && (window as any).__privyLogout) {
      Promise.resolve((window as any).__privyLogout()).catch(() => {});
    }

    // Clear wallet from transaction history service
    this.txHistoryService.setWallet(null);

    this.provider = null;
    this.signer = null;
    this.ethereumProvider = null;
    this._state.set({
      isConnected: false,
      isConnecting: false,
      address: null,
      chainId: null,
      balance: '0',
      error: null,
    });
  }

  // ---------------------------------------------------------------------------
  // Chain Switching Methods
  // ---------------------------------------------------------------------------

  /**
   * Switch to a different blockchain network
   * Will prompt user to add the chain if not already in their wallet
   *
   * @param chainId - The chain ID to switch to (e.g., 42161 for Arbitrum)
   * @returns true if switch successful
   */
  async switchChain(chainId: number): Promise<boolean> {
    // Use stored ethereum provider (from Privy) or fallback to window.ethereum
    const provider = this.ethereumProvider || window.ethereum;
    if (!provider) return false;

    const chainHex = `0x${chainId.toString(16)}`;

    try {
      // Request chain switch
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: chainHex }],
      });

      // Refresh provider and signer after chain switch. If the refresh fails
      // we MUST report the switch as failed — otherwise callers proceed with
      // a stale `chainId` and a swap intended for chain X gets signed against
      // chain Y. (Pre-fix this just logged and returned `true`.)
      const refreshed = await this.refreshConnection();
      if (!refreshed) return false;
      // Coarse network name only ("Arbitrum One") — never addresses.
      this.analytics.track('chain_selected', { chain: getNetworkName(chainId) });
      return true;
    } catch (error: any) {
      // Error code 4902 = chain not added to wallet
      if (error.code === 4902) {
        // Try to add the chain first
        const added = await this.addChain(chainId);
        if (added) {
          const refreshed = await this.refreshConnection();
          if (refreshed) {
            this.analytics.track('chain_selected', { chain: getNetworkName(chainId) });
          }
          return refreshed;
        }
      }
      console.error('Failed to switch chain:', error);
      return false;
    }
  }

  /**
   * Add a new chain to user's wallet
   * This is called when user tries to switch to a chain they don't have
   *
   * @param chainId - The chain ID to add
   * @returns true if chain was added successfully
   */
  private async addChain(chainId: number): Promise<boolean> {
    const provider = this.ethereumProvider || window.ethereum;
    if (!provider) return false;

    // Chain configurations for wallet_addEthereumChain. The RPC handed to
    // the wallet is the canonical first PUBLIC_RPCS entry — a stale local
    // copy here once pointed MetaMask at llamarpc, which 429s within
    // seconds of any traffic.
    const chainConfigs: Record<number, any> = {
      1: {
        chainId: '0x1',
        chainName: 'Ethereum Mainnet',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: [PUBLIC_RPCS[1][0]],
        blockExplorerUrls: ['https://etherscan.io'],
      },
      42161: {
        chainId: '0xa4b1',
        chainName: 'Arbitrum One',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: [PUBLIC_RPCS[42161][0]],
        blockExplorerUrls: ['https://arbiscan.io'],
      },
      8453: {
        chainId: '0x2105',
        chainName: 'Base',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: [PUBLIC_RPCS[8453][0]],
        blockExplorerUrls: ['https://basescan.org'],
      },
      137: {
        chainId: '0x89',
        chainName: 'Polygon',
        // POL (not MATIC) since the Sept 2024 migration — wallets that
        // validate add-chain params against their registry expect POL.
        nativeCurrency: { name: 'Polygon Ecosystem Token', symbol: 'POL', decimals: 18 },
        rpcUrls: [PUBLIC_RPCS[137][0]],
        blockExplorerUrls: ['https://polygonscan.com'],
      },
      10: {
        chainId: '0xa',
        chainName: 'Optimism',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: [PUBLIC_RPCS[10][0]],
        blockExplorerUrls: ['https://optimistic.etherscan.io'],
      },
      56: {
        chainId: '0x38',
        // "BNB Smart Chain" is the name in wallet chain registries —
        // wallets that validate add-chain params expect it verbatim.
        chainName: 'BNB Smart Chain',
        nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
        rpcUrls: [PUBLIC_RPCS[56][0]],
        blockExplorerUrls: ['https://bscscan.com'],
      },
      43114: {
        chainId: '0xa86a',
        chainName: 'Avalanche C-Chain',
        nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
        rpcUrls: [PUBLIC_RPCS[43114][0]],
        blockExplorerUrls: ['https://snowscan.xyz'],
      },
    };

    const config = chainConfigs[chainId];
    if (!config) {
      console.error('Unknown chain:', chainId);
      return false;
    }

    try {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [config],
      });
      return true;
    } catch (error) {
      console.error('Failed to add chain:', error);
      return false;
    }
  }

  /**
   * Refresh provider and signer after chain switch. Necessary because the
   * underlying provider is chain-specific.
   *
   * Returns `true` only when the new state was committed; on failure we
   * surface a user-visible error and DO NOT touch `chainId`. Callers must
   * treat a `false` return as a failed chain switch — otherwise stale state
   * will leak into the next transaction (signed against the wrong chain).
   */
  private async refreshConnection(): Promise<boolean> {
    const provider = this.ethereumProvider || window.ethereum;
    if (!provider) return false;

    try {
      this.provider = new BrowserProvider(provider);
      this.signer = await this.provider.getSigner();
      const network = await this.provider.getNetwork();
      const address = await this.signer.getAddress();
      const balance = await this.provider.getBalance(address);

      this._state.update((s) => ({
        ...s,
        chainId: Number(network.chainId),
        balance: formatEther(balance),
        error: null,
      }));
      return true;
    } catch (error) {
      console.error('Error refreshing connection:', error);
      this._state.update((s) => ({
        ...s,
        error: 'Network switch failed. Please try again.',
      }));
      return false;
    }
  }

  /**
   * Ensure wallet is on the correct chain before executing a transaction
   * Used before swaps to automatically switch chains if needed
   *
   * @param requiredChainId - The chain ID required for the transaction
   * @returns true if already on correct chain or switch successful
   */
  async ensureCorrectChain(requiredChainId: number): Promise<boolean> {
    const currentChainId = this._state().chainId;

    // Already on correct chain
    if (currentChainId === requiredChainId) {
      return true;
    }

    return this.switchChain(requiredChainId);
  }

  // ---------------------------------------------------------------------------
  // Balance Methods
  // ---------------------------------------------------------------------------

  /**
   * Update native token balance (ETH/MATIC etc)
   * Call this after transactions to refresh displayed balance
   */
  async updateBalance(): Promise<void> {
    if (!this.provider || !this._state().address) return;

    try {
      const balance = await this.provider.getBalance(this._state().address!);
      this._state.update((s) => ({ ...s, balance: formatEther(balance) }));
    } catch (error) {
      console.error('Error updating balance:', error);
    }
  }

  /**
   * Get balance of any token (native or ERC20) on any chain
   * Uses public RPC endpoints to query chains user is not connected to
   *
   * @param tokenAddress - Token contract address (0x0...0 for native)
   * @param decimals - Token decimals
   * @param chainId - Optional chain ID (defaults to current chain)
   * @returns Token balance as string
   */
  async getTokenBalance(tokenAddress: string, decimals: number, chainId?: number): Promise<string> {
    const address = this._state().address;
    if (!address) return '0';

    // Determine which chain to query
    const targetChainId = chainId || this._state().chainId || 1;
    const walletChainId = this._state().chainId;

    // Use wallet provider if on same chain
    if (targetChainId === walletChainId && this.provider) {
      return this.fetchBalanceWithProvider(this.provider, address, tokenAddress, decimals, targetChainId);
    }

    // Otherwise walk the public RPCs (cached providers + cooldown skip)
    const balance = await this.fetchBalanceViaPublicRpcs(targetChainId, address, tokenAddress, decimals);
    if (balance === null) {
      console.error(`All RPCs failed for chain ${targetChainId}`);
      return '0';
    }
    return balance;
  }

  /**
   * STRICT native-balance read for preflight gating: resolves to the
   * balance string on success and `null` when the balance could not be
   * determined (no connected address, no RPC configured for the chain, or
   * every fetch attempt failed). `getTokenBalance` deliberately collapses
   * those cases to '0' — fine for display, but a gate that blocks Confirm
   * must distinguish "the wallet holds zero" from "the RPCs are flaky":
   * the latter has to fail open. Additive: `getTokenBalance` keeps its
   * existing behavior for every other caller.
   */
  async getNativeBalanceStrict(chainId: number): Promise<string | null> {
    const address = this._state().address;
    if (!address) return null;

    const nativeAddress = '0x0000000000000000000000000000000000000000';

    // Same-chain: the wallet's own provider is the best source — but its
    // failure still means "unknown", never zero; fall through to the
    // public RPCs below instead of giving up.
    if (chainId === this._state().chainId && this.provider) {
      try {
        return await this.fetchBalanceWithProvider(this.provider, address, nativeAddress, 18, chainId);
      } catch {
        // Wallet-provider hiccup — try the public RPCs.
      }
    }

    // Every source failed (or in cooldown) → null: caller treats as "unknown".
    return this.fetchBalanceViaPublicRpcs(chainId, address, nativeAddress, 18);
  }

  /**
   * Walk the chain's public RPCs — skipping any in cooldown — and return the
   * first successful balance, or `null` when no RPC could answer. Shared by
   * `getTokenBalance` (display path — collapses null to '0') and
   * `getNativeBalanceStrict` (gating path — must surface null as "unknown").
   */
  private async fetchBalanceViaPublicRpcs(
    chainId: number,
    address: string,
    tokenAddress: string,
    decimals: number,
  ): Promise<string | null> {
    const urls = PUBLIC_RPCS[chainId];
    if (!urls || urls.length === 0) {
      console.warn(`No RPC URLs configured for chain ${chainId}`);
      return null;
    }

    for (const url of urls) {
      if (!this.rpcPool.isHealthy(url)) continue;
      try {
        const provider = this.rpcPool.getProvider(url, chainId);
        return await this.fetchBalanceWithProvider(provider, address, tokenAddress, decimals, chainId);
      } catch (error) {
        this.rpcPool.markUnhealthy(url, error);
      }
    }
    return null;
  }

  /**
   * Helper to fetch balance using a specific provider
   */
  private async fetchBalanceWithProvider(
    provider: BrowserProvider | JsonRpcProvider,
    address: string,
    tokenAddress: string,
    decimals: number,
    chainId: number
  ): Promise<string> {
    // Native token (ETH, MATIC, etc.)
    if (tokenAddress === '0x0000000000000000000000000000000000000000') {
      const balance = await provider.getBalance(address);
      return formatEther(balance);
    }

    // ERC20 token - call balanceOf on the contract
    const abi = ['function balanceOf(address) view returns (uint256)'];
    const contract = new Contract(tokenAddress, abi, provider);
    const balance = await contract['balanceOf'](address);
    return formatUnits(balance, decimals);
  }

  // ---------------------------------------------------------------------------
  // Getters
  // ---------------------------------------------------------------------------

  /** Get ethers provider instance */
  getProvider(): BrowserProvider | null {
    return this.provider;
  }

  /** Get signer instance for signing transactions */
  getSigner(): JsonRpcSigner | null {
    return this.signer;
  }

  /**
   * Get raw EIP-1193 ethereum provider
   * Used by LI.FI SDK for transaction signing
   * @returns EIP-1193 compatible provider or null
   */
  getEthereumProvider(): any {
    return this.ethereumProvider || (typeof window !== 'undefined' ? window.ethereum : null);
  }

  public setConnectedStatus(isConnected: boolean): void {
    this.isConnectedInPrivy.set(isConnected);
  }
}

// =============================================================================
// TYPE DECLARATIONS
// =============================================================================

/**
 * Extend Window interface to include ethereum object
 * This is injected by MetaMask and other Web3 wallets
 */
declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: any[] }) => Promise<any>;
      on: (event: string, callback: (...args: any[]) => void) => void;
      removeListener: (event: string, callback: (...args: any[]) => void) => void;
      isMetaMask?: boolean;
    };
  }
}
