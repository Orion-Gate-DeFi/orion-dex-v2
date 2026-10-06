/**
 * =============================================================================
 * SEND SERVICE
 * =============================================================================
 *
 * Handles sending tokens (native and ERC20) to other wallet addresses.
 * Supports all networks configured in the app.
 *
 * @author Orion DEX Team
 * @version 1.2.0 — reentrancy guard: concurrent sends are rejected instead of
 *                  racing two signatures out of one click.
 */

import { Injectable, inject } from '@angular/core';
import { parseEther, parseUnits, Contract, isAddress, JsonRpcProvider } from 'ethers';
import { WalletService } from './wallet.service';
import { GasService } from './swap/gas.service';
import { Token } from '../models/token.model';
import { getExplorerTxUrl } from '../constants';
import { PUBLIC_RPCS } from '../constants/public-rpcs.constant';
import { fetchReceiptWithFallback } from '../utils/fetch-receipt';

// =============================================================================
// INTERFACES
// =============================================================================

export interface SendResult {
  success: boolean;
  txHash?: string;
  explorerUrl?: string;
  error?: string;
}

export interface GasEstimate {
  gasLimit: bigint;
  gasPrice: bigint;
  estimatedCostWei: bigint;
  estimatedCostUSD: string;
}

// ERC20 ABI for transfer function
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

// =============================================================================
// PURE HELPERS
// =============================================================================

/** Known burn addresses — anything sent here is unrecoverable. Lower-cased. */
const BURN_ADDRESSES: ReadonlySet<string> = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

/**
 * Whether `address` is a well-known burn address (zero address or 0x…dEaD).
 * Case-insensitive. Exported standalone so the send UI can hard-block these
 * recipients and the check stays trivially unit-testable.
 */
export function isBurnAddress(address: string): boolean {
  return BURN_ADDRESSES.has(address.toLowerCase());
}

/**
 * Truncate (never round) a decimal amount string to at most `decimals`
 * fractional digits.
 *
 * Safety net for `parseUnits` / `parseEther`, which throw 'too many decimals
 * for format' when the fraction has more significant digits than the token
 * supports (USDC/USDT = 6, WBTC = 8) — near-certain in USD input mode where
 * usd / priceUSD yields a long fraction. Mirrors QuoteService.parseAmount's
 * truncation fallback. Truncation (not rounding) is deliberate: rounding up
 * could send more than the user confirmed; truncation only drops dust.
 */
export function truncateDecimals(amount: string, decimals: number): string {
  // Exponent notation ('1e-7') has no plain fraction to clip and would pass
  // through unchanged into parseUnits, which throws on it — zero it instead
  // (such values are dust or unreachable behind the balance checks anyway).
  if (/[eE]/.test(String(amount))) return '0';
  const [whole = '0', fraction = ''] = String(amount).split('.');
  const clipped = decimals > 0 ? fraction.slice(0, decimals) : '';
  return clipped ? `${whole || '0'}.${clipped}` : (whole || '0');
}

// =============================================================================
// SEND SERVICE
// =============================================================================

@Injectable({
  providedIn: 'root',
})
export class SendService {
  private walletService = inject(WalletService);
  private gasService = inject(GasService);

  /**
   * Reentrancy guard. A double-click on the send CTA — or any caller firing
   * a second send before the first resolves — would otherwise put two
   * signature prompts in flight for one intended transfer (and on Privy
   * embedded wallets, which auto-sign, two broadcast transactions). Same
   * pattern as SwapExecutionService's executeSwap guard, but rejecting via
   * the SendResult error channel instead of throwing.
   */
  private isExecuting = false;

  /** Uniform rejection for a send attempted while another is in flight. */
  private static readonly CONCURRENT_SEND_ERROR =
    'A send is already in progress. Wait for it to finish before starting another.';

  /**
   * Check if address is valid Ethereum address
   */
  isValidAddress(address: string): boolean {
    return isAddress(address);
  }

  /**
   * Check whether a recipient address is a smart contract (vs an EOA).
   *
   * Critical pre-flight for sends — sending ERC20/native to a contract that
   * doesn't implement a fallback, or to a token contract itself, is a common
   * way for first-time users to lose funds permanently. We surface a
   * confirmation in the UI before letting the user proceed.
   *
   * Returns `null` on RPC failure (don't block the user on transient errors;
   * fall through with a soft warning in the UI).
   */
  async isContractAddress(address: string, chainId: number): Promise<boolean | null> {
    if (!isAddress(address)) return null;
    const urls = PUBLIC_RPCS[chainId];
    if (!urls || urls.length === 0) return null;
    for (const url of urls) {
      try {
        const provider = new JsonRpcProvider(url);
        const code = await provider.getCode(address);
        return code !== '0x' && code !== '0x0';
      } catch {
        // try next RPC
      }
    }
    return null;
  }

  /**
   * Check if token is native (ETH, MATIC, etc.)
   */
  isNativeToken(token: Token): boolean {
    return token.address === '0x0000000000000000000000000000000000000000';
  }

  /**
   * Estimate gas for a send transaction
   */
  async estimateGas(
    token: Token,
    to: string,
    amount: string
  ): Promise<GasEstimate | null> {
    const provider = this.walletService.getProvider();
    const signer = this.walletService.getSigner();

    if (!provider || !signer) {
      return null;
    }

    try {
      const from = await signer.getAddress();
      let gasLimit: bigint;

      if (this.isNativeToken(token)) {
        // Native token transfer
        const value = parseEther(truncateDecimals(amount, 18));
        gasLimit = await provider.estimateGas({
          from,
          to,
          value,
        });
      } else {
        // ERC20 token transfer
        const contract = new Contract(token.address, ERC20_ABI, signer);
        const value = parseUnits(truncateDecimals(amount, token.decimals), token.decimals);
        gasLimit = await contract['transfer'].estimateGas(to, value);
      }

      // Get current gas price (EIP-1559 chains expose price via maxFeePerGas).
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? BigInt(0);

      // Calculate estimated cost in native token.
      const estimatedCostWei = gasLimit * gasPrice;
      const costInNative = Number(estimatedCostWei) / 1e18;

      // Native price comes from LI.FI proxy (with hardcoded fallback) so we
      // get the right number on Polygon (MATIC ≠ $2000) and don't lie about
      // the fee on chains where the native token is cheap.
      const nativePrice = await this.gasService.getNativeTokenPrice(token.chainId);
      // Keep sub-cent precision here — rounding to 2 decimals turned a real
      // L2 fee of a fraction of a cent into "0.00", which the review screen
      // then showed as a FREE transfer. The component formats it for display
      // ("<$0.01" / "~$1.23") via formatUsdFee.
      const estimatedCostUSD = (costInNative * nativePrice).toFixed(6);

      return {
        gasLimit,
        gasPrice,
        estimatedCostWei,
        estimatedCostUSD,
      };
    } catch (error) {
      console.error('Error estimating gas:', error);
      return null;
    }
  }

  /**
   * Send native token (ETH, MATIC, etc.)
   */
  async sendNativeToken(
    to: string,
    amount: string,
    chainId: number,
    onStatusChange?: (status: string, txHash?: string) => void
  ): Promise<SendResult> {
    if (this.isExecuting) {
      return { success: false, error: SendService.CONCURRENT_SEND_ERROR };
    }
    if (!this.walletService.getSigner()) {
      return { success: false, error: 'Wallet not connected' };
    }
    this.isExecuting = true;

    try {
      // Ensure correct chain FIRST
      onStatusChange?.('switching');
      const switched = await this.walletService.ensureCorrectChain(chainId);
      if (!switched) {
        return { success: false, error: 'Failed to switch network' };
      }

      // Get signer AFTER chain switch (signer is recreated for new chain)
      const signer = this.walletService.getSigner();
      if (!signer) {
        return { success: false, error: 'Wallet not connected after chain switch' };
      }

      // Send transaction
      onStatusChange?.('signing');
      const value = parseEther(truncateDecimals(amount, 18));
      // chainId pinned for the same reason as the swap path: a wallet that
      // silently reverted to another network must hard-fail the signature
      // instead of broadcasting value to the wrong chain.
      const tx = await signer.sendTransaction({
        to,
        value,
        chainId,
      });

      const txHash = tx.hash;
      const explorerUrl = getExplorerTxUrl(chainId, txHash);
      onStatusChange?.('pending', txHash);

      const confirmed = await this.confirmTransaction(signer.provider, txHash, chainId);
      if (confirmed === 'reverted') {
        return { success: false, error: "Couldn't complete on the network", txHash, explorerUrl };
      }
      onStatusChange?.('completed');

      return {
        success: true,
        txHash,
        explorerUrl,
      };
    } catch (error: any) {
      console.error('Send native token error:', error);

      // Handle user rejection
      if (error.code === 'ACTION_REJECTED' || error.code === 4001) {
        return { success: false, error: 'Transaction rejected by user' };
      }

      return { success: false, error: error.message || 'Transaction failed' };
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Send ERC20 token
   */
  async sendERC20Token(
    token: Token,
    to: string,
    amount: string,
    onStatusChange?: (status: string, txHash?: string) => void
  ): Promise<SendResult> {
    if (this.isExecuting) {
      return { success: false, error: SendService.CONCURRENT_SEND_ERROR };
    }
    if (!this.walletService.getSigner()) {
      return { success: false, error: 'Wallet not connected' };
    }
    this.isExecuting = true;

    try {
      // Ensure correct chain FIRST
      onStatusChange?.('switching');
      const switched = await this.walletService.ensureCorrectChain(token.chainId);
      if (!switched) {
        return { success: false, error: 'Failed to switch network' };
      }

      // Get signer AFTER chain switch (signer is recreated for new chain)
      const signer = this.walletService.getSigner();
      if (!signer) {
        return { success: false, error: 'Wallet not connected after chain switch' };
      }

      // Create contract instance with fresh signer
      const contract = new Contract(token.address, ERC20_ABI, signer);
      const value = parseUnits(truncateDecimals(amount, token.decimals), token.decimals);

      // Send transaction. chainId pinned for the same reason as
      // sendNativeToken above — hard-fail rather than broadcast to the
      // wrong network.
      onStatusChange?.('signing');
      const tx = await contract['transfer'](to, value, { chainId: token.chainId });

      const txHash = tx.hash;
      const explorerUrl = getExplorerTxUrl(token.chainId, txHash);
      onStatusChange?.('pending', txHash);

      const confirmed = await this.confirmTransaction(signer.provider, txHash, token.chainId);
      if (confirmed === 'reverted') {
        return { success: false, error: "Couldn't complete on the network", txHash, explorerUrl };
      }
      onStatusChange?.('completed');

      return {
        success: true,
        txHash,
        explorerUrl,
      };
    } catch (error: any) {
      console.error('Send ERC20 token error:', error);

      // Handle user rejection
      if (error.code === 'ACTION_REJECTED' || error.code === 4001) {
        return { success: false, error: 'Transaction rejected by user' };
      }

      return { success: false, error: error.message || 'Transaction failed' };
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Wait for the receipt and translate it into a coarse status.
   *
   * - `success`: receipt.status === 1 — tx confirmed and didn't revert.
   * - `reverted`: receipt.status === 0 — tx mined but reverted on-chain.
   *   Caller marks history as failed.
   * - `unknown`: both wallet provider and public-RPC fallback gave up.
   *   The tx was broadcast — we just don't know the outcome.
   *
   * Uses `fetchReceiptWithFallback` so Privy embedded wallets (which crash
   * ethers v6's receipt parser on `nonce: "undefined"`) don't always end up
   * as `unknown` — the public RPC fallback gives us a real verdict.
   */
  private async confirmTransaction(
    walletProvider: any,
    txHash: string,
    chainId: number,
  ): Promise<'success' | 'reverted' | 'unknown'> {
    const receipt = await fetchReceiptWithFallback(walletProvider, txHash, chainId);
    if (!receipt) return 'unknown';
    return receipt.status === 0 ? 'reverted' : 'success';
  }

  /**
   * Send token (auto-detects native vs ERC20)
   */
  async send(
    token: Token,
    to: string,
    amount: string,
    onStatusChange?: (status: string, txHash?: string) => void
  ): Promise<SendResult> {
    if (this.isNativeToken(token)) {
      return this.sendNativeToken(to, amount, token.chainId, onStatusChange);
    } else {
      return this.sendERC20Token(token, to, amount, onStatusChange);
    }
  }
}
