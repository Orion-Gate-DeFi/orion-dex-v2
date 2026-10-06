/**
 * =============================================================================
 * SEND COMPONENT
 * =============================================================================
 *
 * Send tokens to another wallet address.
 * Designed for crypto beginners with clear, simple UI.
 *
 * Features:
 * - Token selection from user's portfolio
 * - Network selection
 * - Address validation
 * - Gas estimation
 * - Transaction status tracking
 *
 * @author Orion DEX Team
 * @version 1.1.0 — surface the 'switching' status on the status screen,
 *                  warn when a manually typed native amount leaves nothing
 *                  for gas ("Use safe max"), link the empty token state to
 *                  Receive.
 */

import { Component, ChangeDetectionStrategy, ElementRef, inject, signal, computed, viewChild, OnInit, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink, ActivatedRoute } from '@angular/router';
import { WalletService } from '../../core/services/wallet.service';
import { LifiService } from '../../core/services/lifi.service';
import { SendService, isBurnAddress, truncateDecimals } from '../../core/services/send.service';
import { ToastService } from '../../core/services/toast.service';
import { BalanceRefreshService } from '../../core/services/balance-refresh.service';
import { TransactionHistoryService } from '../../core/services/transaction-history.service';
import { AnalyticsService, AnalyticsProps } from '../../core/services/analytics.service';
import { TokenSelectorComponent } from '../swap/token-selector/token-selector.component';
import { NumericInputDirective } from '../../shared/directives/numeric-input.directive';
import { StatusIconComponent } from '../../shared/components/status-icon/status-icon.component';
import { Token } from '../../core/models/token.model';
import { presentError } from '../../core/utils/error-presenter';
import { formatUsdFee } from '../../core/utils/format-usd-fee';
import {
  NETWORKS,
  NetworkInfo,
  getNetworkName,
  getNetworkLogo,
  getExplorerTxUrl,
  getExplorerAddressUrl,
} from '../../core/constants';

// =============================================================================
// TYPES
// =============================================================================

type SendStep = 'form' | 'review' | 'status';
type TransactionStatus = 'idle' | 'switching' | 'signing' | 'pending' | 'completed' | 'failed';

interface PortfolioToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chainId: number;
  logoURI: string;
  priceUSD: string;
  balance: number;
  balanceUSD: number;
}

// =============================================================================
// COMPONENT
// =============================================================================

@Component({
  selector: 'app-send',
  standalone: true,
  templateUrl: './send.component.html',
  imports: [CommonModule, FormsModule, RouterLink, TokenSelectorComponent, NumericInputDirective, StatusIconComponent],
  // Safe for OnPush despite the plain `amount` / `recipientAddress` fields:
  // they are only written from template event handlers (which mark the view
  // for check) or from async paths that also flip a template-read signal in
  // the same turn (parseUrlParams → onRecipientAddressChange sets
  // isCheckingRecipient/isSelfRecipient, applyUrlParams runs after
  // availableTokens.set). Keep that invariant when adding new writes.
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SendComponent implements OnInit {
  // Services
  walletService = inject(WalletService);
  private lifiService = inject(LifiService);
  private sendService = inject(SendService);
  private toastService = inject(ToastService);
  private balanceRefreshService = inject(BalanceRefreshService);
  private txHistoryService = inject(TransactionHistoryService);
  private analytics = inject(AnalyticsService);
  private route = inject(ActivatedRoute);

  /**
   * Funnel-event props for a send. Sends are single-chain, so from/to chain
   * are the same id; no amounts, no addresses — ever.
   */
  private sendAnalyticsProps(chainId: number): AnalyticsProps {
    return { from_chain: chainId, to_chain: chainId, cross_chain: false };
  }

  // Networks
  readonly networks = NETWORKS;

  // URL params for payment links
  private urlParams = {
    to: '',
    amount: '',
    token: '',
    tokenAddress: '',
    chain: 0,
  };

  // State
  currentStep = signal<SendStep>('form');
  selectedNetwork = signal<NetworkInfo | null>(NETWORKS[0]); // Default to Ethereum
  selectedToken = signal<PortfolioToken | null>(null);
  availableTokens = signal<PortfolioToken[]>([]);
  isLoadingTokens = signal(false);
  /** Balance load FAILED (network/proxy error) — distinct from a genuinely
   *  empty wallet, so the UI can offer Retry instead of "Receive first". */
  loadTokensError = signal(false);
  showTokenSelector = signal(false);

  // Form
  amount = '';
  recipientAddress = '';

  /** Input mode: 'token' = enter token amount, 'usd' = enter USD amount */
  inputMode = signal<'token' | 'usd'>('token');

  /** Whether recipient address is locked (from payment link) */
  isRecipientLocked = signal(false);

  /** Whether this is a payment link (locks network selection too) */
  isPaymentLink = signal(false);

  /** Flag to track if URL params have been applied */
  private urlParamsApplied = false;

  /**
   * Recipient classification (for smart-contract guard).
   * `null` = not yet checked (or RPC check failed — see `recipientCheckFailed`),
   * `false` = EOA (regular wallet),
   * `true` = smart contract (warn user).
   */
  isContractRecipient = signal<boolean | null>(null);
  isCheckingRecipient = signal(false);
  /** Contract-vs-EOA check ran but every RPC failed. Distinguishes "couldn't
   *  verify" from "not checked yet" so the UI can fail open WITH friction
   *  (visible warning + explicit acknowledgment) instead of silently. */
  recipientCheckFailed = signal(false);
  /** User has acknowledged that they're sending to a smart contract. */
  acknowledgedContract = signal(false);
  /** User has acknowledged sending to an address we couldn't verify (RPC failure). */
  acknowledgedUnverified = signal(false);
  /** Payment link carried an invalid `to` param — shown inline, field stays editable. */
  brokenPaymentLink = signal(false);

  /** Payment link requested a token the opener doesn't hold on this network.
   *  Surfaces an explicit banner instead of silently dropping it; the
   *  requested amount stays pre-filled. */
  linkTokenNotFound = signal(false);
  /** Recipient is the user's own connected address. We skip the
   *  smart-contract warning in this case — Privy embedded wallets and other
   *  AA flows surface as `code != 0x` on most L2s, which made the warning
   *  fire on the user's own wallet. They obviously know what's at their
   *  own address; warning is noise. */
  isSelfRecipient = signal(false);
  /** Cancellation token for in-flight contract-check (recipient may keep
   *  typing — only the latest check should win). */
  private contractCheckEpoch = 0;

  /** Real gas estimate populated when entering review step (replaces the
   *  hardcoded "$0.01 - $0.10" placeholder). `null` while loading or if the
   *  RPC failed; the template falls back to "Could not estimate" then. */
  gasEstimateUSD = signal<string | null>(null);
  isEstimatingGas = signal(false);

  // Transaction
  txStatus = signal<TransactionStatus>('idle');
  txHash = signal('');
  explorerUrl = signal('');
  txError = signal('');

  /** Active step's heading (`#stepHeading`, tabindex="-1") — exactly one
   *  renders at a time, so a single query covers all three steps. */
  private readonly stepHeading = viewChild<ElementRef<HTMLElement>>('stepHeading');

  /**
   * Move focus to the new step's heading after a form/review/status switch.
   * Without this the activated button is destroyed with the old step and
   * focus silently drops to <body> — keyboard users restart from the header,
   * screen-reader users get no signal that the screen changed. setTimeout
   * lets change detection render the new step before the query is read.
   */
  private focusStepHeading(): void {
    setTimeout(() => this.stepHeading()?.nativeElement.focus());
  }

  /** Review → form (back arrow / Cancel) with focus management. */
  backToForm(): void {
    this.currentStep.set('form');
    this.focusStepHeading();
  }

  /**
   * Calculate actual token amount to send (always in tokens)
   * Note: Using getter instead of computed because 'amount' is not a signal
   */
  tokenAmount(): number {
    const token = this.selectedToken();
    // `!(x > 0)` (not `=== 0`) so NaN from a bare '.' input reads as 0.
    if (!token || !(parseFloat(this.amount) > 0)) {
      return 0;
    }

    if (this.inputMode() === 'token') {
      return parseFloat(this.amount);
    } else {
      // Convert USD to token amount
      const priceUSD = parseFloat(token.priceUSD) || 0;
      if (priceUSD === 0) return 0;
      return parseFloat(this.amount) / priceUSD;
    }
  }

  /**
   * Get display value (opposite of input mode)
   * Note: Using getter instead of computed because 'amount' is not a signal
   */
  displayValue(): string {
    const token = this.selectedToken();
    // `!(x > 0)` so NaN ('.' input) renders the zero placeholder, not '$NaN'.
    if (!token || !(parseFloat(this.amount) > 0)) {
      return this.inputMode() === 'token' ? '$0.00' : `0 ${token?.symbol || ''}`;
    }

    const priceUSD = parseFloat(token.priceUSD) || 0;

    if (this.inputMode() === 'token') {
      // Show USD value
      const usd = parseFloat(this.amount) * priceUSD;
      return `$${usd.toFixed(2)}`;
    } else {
      // Show token amount
      if (priceUSD === 0) return `0 ${token.symbol}`;
      const tokens = parseFloat(this.amount) / priceUSD;
      return `~${tokens.toFixed(6)} ${token.symbol}`;
    }
  }

  constructor() {
    // Watch for wallet connection changes to load tokens
    effect(() => {
      const isConnected = this.walletService.isConnected();
      const address = this.walletService.address();

      if (isConnected && address && this.selectedNetwork()) {
        // Wallet just connected, load tokens
        this.loadTokensForNetwork();
      }
    }, { allowSignalWrites: true });
  }

  ngOnInit(): void {
    // Parse URL params for payment links
    this.parseUrlParams();

    // Load tokens for initial network if wallet already connected
    if (this.walletService.isConnected()) {
      this.loadTokensForNetwork();
    }
  }

  /**
   * Parse URL parameters for payment link support
   * Example: /send?to=0x123...&amount=100&token=USDC&chain=42161
   */
  private parseUrlParams(): void {
    this.route.queryParams.subscribe(params => {
      // Validate `to` up front — payment-link semantics (locked network
      // pills, trust chip, wallet auto-switch) only engage when the link's
      // recipient is actually usable. A malformed or burn `to` must leave
      // the form fully editable instead of latching locked-link UI onto a
      // broken link.
      const to = params['to'] ? String(params['to']) : '';
      const isUsableRecipient = !!to && this.sendService.isValidAddress(to) && !isBurnAddress(to);
      const hasPaymentLinkParams = isUsableRecipient && params['chain'] && params['token'];

      if (hasPaymentLinkParams) {
        this.isPaymentLink.set(true);
      }

      // Chain ID — set network FIRST so the recipient contract-check below
      // runs against the link's chain (contract status is chain-specific).
      if (params['chain']) {
        const chainId = parseInt(params['chain'], 10);
        this.urlParams.chain = chainId;
        const network = this.networks.find(n => n.id === chainId);
        if (network) {
          this.selectedNetwork.set(network);
          // Try to load tokens if wallet is connected
          if (this.walletService.isConnected()) {
            // Switch wallet to the correct network for payment links
            if (this.isPaymentLink()) {
              this.switchToPaymentLinkNetwork(chainId);
            }
            this.loadTokensForNetwork();
          }
        }
      }

      // Recipient address. Validate BEFORE locking — a truncated/forged `to`
      // would otherwise brick the form (locked field + forever-disabled
      // button). Burn addresses take the same broken-link path: locking one
      // in dead-ends on the hard "sending blocked" state with no way to
      // edit. Usable addresses go through onRecipientAddressChange so the
      // contract classification runs for payment links too.
      if (to) {
        if (isUsableRecipient) {
          this.urlParams.to = to;
          this.onRecipientAddressChange(to);
          this.isRecipientLocked.set(true); // Lock recipient when from payment link
        } else {
          this.brokenPaymentLink.set(true);
          this.toastService.error(
            'Broken payment link',
            'This payment link is broken — enter the recipient address manually.',
          );
        }
      }

      // Amount (optional). Only accept a finite positive decimal — `Infinity`
      // or scientific notation from a crafted link otherwise leaks through
      // `parseFloat` and breaks USD-conversion / display until the user
      // clears it manually.
      if (params['amount']) {
        const raw = String(params['amount']);
        const parsed = parseFloat(raw);
        if (Number.isFinite(parsed) && parsed > 0 && /^\d+(\.\d+)?$/.test(raw)) {
          this.urlParams.amount = raw;
        }
      }

      // Token symbol
      if (params['token']) {
        this.urlParams.token = params['token'].toUpperCase();
      }

      // Token contract address (counterfeit-resistant — symbols aren't unique).
      // Validate so a junk param can't poison the lookup; the symbol above is
      // kept as a legacy fallback for links generated before this param.
      if (params['tokenAddress']) {
        const addr = String(params['tokenAddress']);
        if (this.sendService.isValidAddress(addr)) {
          this.urlParams.tokenAddress = addr;
        }
      }
    });
  }

  /**
   * Apply URL params after tokens are loaded
   */
  private applyUrlParams(): void {
    // Only apply once
    if (this.urlParamsApplied) return;

    // Apply the requested amount FIRST, unconditionally. Previously this lived
    // inside the matched-token branch, so a link for a token the opener didn't
    // hold silently dropped BOTH the token AND the amount (audit finding). The
    // amount must survive even when the token can't be resolved.
    if (this.urlParams.amount) {
      this.amount = this.urlParams.amount;
    }

    if (!this.urlParams.token && !this.urlParams.tokenAddress) {
      this.urlParamsApplied = true;
      return;
    }

    const tokens = this.availableTokens();
    if (tokens.length === 0) return; // tokens not loaded yet — retry on next load

    // Resolve by contract ADDRESS first (counterfeit-resistant), then fall back
    // to the symbol for legacy links.
    const wantAddr = this.urlParams.tokenAddress.toLowerCase();
    const netId = this.selectedNetwork()?.id;
    const token =
      (wantAddr
        ? tokens.find(t => t.address.toLowerCase() === wantAddr && t.chainId === netId)
        : undefined) ??
      tokens.find(t => t.symbol.toUpperCase() === this.urlParams.token);

    if (token) {
      this.selectedToken.set(token);
      this.linkTokenNotFound.set(false);
    } else {
      // Requested token isn't in the opener's holdings — show a banner (the
      // amount stays pre-filled) instead of a silently empty form.
      this.linkTokenNotFound.set(true);
    }
    this.urlParamsApplied = true;
  }

  selectNetwork(network: NetworkInfo): void {
    // Don't allow network change for payment links
    if (this.isPaymentLink()) {
      this.toastService.warning('Network locked', 'Cannot change network for payment links');
      return;
    }

    this.selectedNetwork.set(network);
    this.selectedToken.set(null);
    this.amount = '';
    // Contract-status is chain-specific (an address can be a contract on
    // mainnet but an empty EOA on Polygon), so re-check after network swap.
    if (this.recipientAddress) {
      this.onRecipientAddressChange(this.recipientAddress);
    }
    this.loadTokensForNetwork();
  }

  /**
   * `opts.force` bypasses the balance TTL cache — passed by the post-success
   * reset so the reloaded form cannot validate the next send against the
   * pre-send balances a still-warm cache would serve.
   */
  async loadTokensForNetwork(opts?: { force?: boolean }): Promise<void> {
    const address = this.walletService.address();
    const network = this.selectedNetwork();

    if (!address || !network) {
      this.availableTokens.set([]);
      return;
    }

    this.isLoadingTokens.set(true);
    this.loadTokensError.set(false);

    try {
      const balances = await this.lifiService.getPortfolioBalances(address, undefined, opts);

      // Filter tokens for selected network
      const networkTokens = balances
        .filter((t) => t.chainId === network.id && t.balance > 0)
        .map((t) => ({
          address: t.address,
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals,
          chainId: t.chainId,
          logoURI: t.logoURI,
          priceUSD: t.priceUSD.toString(),
          balance: t.balance,
          balanceUSD: t.balanceUSD,
        }));

      this.availableTokens.set(networkTokens);

      // Auto-select first token if available (or apply URL params)
      if (networkTokens.length > 0) {
        if (this.urlParams.token || this.urlParams.tokenAddress || this.urlParams.amount) {
          // Apply URL params if this is a payment link
          this.applyUrlParams();
        } else if (!this.selectedToken()) {
          this.selectedToken.set(networkTokens[0]);
        }
      }
    } catch (error) {
      console.error('Error loading tokens:', error);
      this.availableTokens.set([]);
      this.loadTokensError.set(true);
    } finally {
      this.isLoadingTokens.set(false);
    }
  }

  selectToken(token: PortfolioToken): void {
    this.selectedToken.set(token);
    this.showTokenSelector.set(false);
  }

  /**
   * Bridge from the shared selector (emits a plain Token) back to Send's
   * balance-aware PortfolioToken — both lists come from the same balances
   * API, so the lookup cannot realistically miss.
   */
  onSelectorToken(token: Token): void {
    const match = this.availableTokens().find(
      (t) => t.address.toLowerCase() === token.address.toLowerCase() && t.chainId === token.chainId,
    );
    if (match) {
      this.selectToken(match);
    } else {
      this.showTokenSelector.set(false);
      this.toastService.warning('Token unavailable', 'That token has no balance on the selected network.');
    }
  }

  onAmountChange(value: string): void {
    // Sanitize: digits + single decimal point only. type="text" doesn't
    // protect us — paste of "1e10000" or "Infinity" would otherwise sneak
    // through into parseFloat and break USD-conversion display.
    const filtered = value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
    this.amount = filtered;
  }

  setPercentage(percent: number): void {
    const token = this.selectedToken();
    if (!token || token.balance <= 0) return;

    // MAX on a native token must leave gas behind — same rule the swap page
    // enforces. Sending value === balance predictably fails at signing with
    // a raw "insufficient funds" after the user already reached the status
    // screen.
    let usable = token.balance;
    const isNative = token.address === '0x0000000000000000000000000000000000000000';
    if (percent === 100 && isNative) {
      const reserve = this.getNativeGasReserve(token.chainId);
      usable = Math.max(0, token.balance - reserve);
      if (usable === 0) {
        this.toastService.warning(
          'Balance too small to send',
          `Need at least ${reserve} ${token.symbol} to cover gas on this network.`,
        );
        return;
      }
    }

    if (this.inputMode() === 'token') {
      // Clamp the fraction to the token's precision — toFixed(6) on a
      // decimals<6 token (e.g. GUSD) later blows up parseUnits with
      // 'too many decimals for format'. Truncated, never rounded: half-up
      // rounding on MAX could land a hair above the balance.
      this.amount = this.toAmountString((usable * percent) / 100, Math.min(6, token.decimals));
    } else {
      // In USD mode, calculate USD value of percentage
      const priceUSD = parseFloat(token.priceUSD) || 0;
      const tokenAmount = (usable * percent) / 100;
      this.amount = this.toAmountString(tokenAmount * priceUSD, 2);
    }
  }

  /**
   * Native amount kept aside on MAX so the send tx can pay its own gas.
   * Mirrors the swap page's per-chain reserve (L1 vs L2 fee scales differ
   * by orders of magnitude). Conservative: overshooting leaves cents of
   * dust, undershooting bounces the tx at the wallet.
   */
  private getNativeGasReserve(chainId: number): number {
    switch (chainId) {
      case 1: return 0.005;        // Ethereum mainnet
      case 137: return 0.05;       // Polygon
      case 42161: return 0.0005;   // Arbitrum
      case 8453: return 0.0005;    // Base
      case 10: return 0.0005;      // Optimism
      case 56: return 0.002;       // BNB Chain (~1-3 gwei, BNB-priced gas)
      case 43114: return 0.01;     // Avalanche (AVAX-priced, gwei-scale gas)
      default: return 0.005;
    }
  }

  /**
   * The gas reserve above is only applied by the MAX button — a manually
   * typed full native balance passes the balance check and dies at signing
   * with a raw "insufficient funds". Surface the same reserve as a warning
   * with a one-tap fix instead. Getter, not computed: `amount` is a plain
   * field (see tokenAmount).
   *
   * Returns the reserve to leave behind, or `null` when no warning applies
   * (non-native token, empty amount, or the amount already exceeds the
   * balance — the "Not enough" branch owns that case).
   */
  nativeGasWarning(): { reserve: number; symbol: string } | null {
    const token = this.selectedToken();
    if (!token || token.address !== '0x0000000000000000000000000000000000000000') return null;
    const amount = this.tokenAmount();
    if (!(amount > 0) || amount > token.balance) return null;
    const reserve = this.getNativeGasReserve(token.chainId);
    if (amount + reserve <= token.balance) return null;
    return { reserve, symbol: token.symbol };
  }

  /** One-tap fix for nativeGasWarning(): re-apply MAX, which holds the reserve back. */
  applySafeMax(): void {
    this.setPercentage(100);
  }

  /**
   * Number → amount string without ever rounding up. `toFixed` alone rounds
   * half-up, so MAX on an ERC-20 could produce a hair more than the balance
   * (and signing could exceed what the user confirmed on review). Render
   * with two extra digits, then truncate to the target precision — dust is
   * only ever dropped, never added.
   */
  private toAmountString(value: number, maxDecimals: number): string {
    return truncateDecimals(value.toFixed(maxDecimals + 2), maxDecimals);
  }

  toggleInputMode(): void {
    const token = this.selectedToken();
    if (!token) return;

    const priceUSD = parseFloat(token.priceUSD) || 0;
    const currentAmount = parseFloat(this.amount) || 0;

    if (this.inputMode() === 'token') {
      // Switching to USD mode
      this.inputMode.set('usd');
      if (currentAmount > 0 && priceUSD > 0) {
        this.amount = (currentAmount * priceUSD).toFixed(2);
      } else {
        this.amount = '';
      }
    } else {
      // Switching to token mode
      this.inputMode.set('token');
      if (currentAmount > 0 && priceUSD > 0) {
        this.amount = (currentAmount / priceUSD).toFixed(6);
      } else {
        this.amount = '';
      }
    }
  }

  isValidAddress(): boolean {
    return this.sendService.isValidAddress(this.recipientAddress);
  }

  /**
   * Recipient is a known burn address (zero address / 0x…dEaD). Hard block —
   * no acknowledgment path; anything sent there is lost forever.
   */
  isBurnRecipient(): boolean {
    return isBurnAddress(this.recipientAddress);
  }

  isInsufficientBalance(): boolean {
    const token = this.selectedToken();
    if (!token || !this.amount) return false;
    // Always compare in token amounts
    return this.tokenAmount() > token.balance;
  }

  /**
   * Form-button gate — the single source of truth for the recipient-safety
   * part of the Review button chain (the template's labelled disabled
   * branches exist only for messaging).
   *
   * - Burn address → hard block, no acknowledgment path.
   * - Check in flight → block until it resolves.
   * - Smart contract → requires the explicit contract acknowledgment.
   * - Check failed (all RPCs down) → fail-open WITH friction: requires the
   *   explicit unverified-address acknowledgment.
   * - Not checked at all (`null` without a failure) → fail closed.
   */
  canProceedToReview(): boolean {
    if (this.isBurnRecipient()) return false;
    if (this.isCheckingRecipient()) return false;
    const recipientType = this.isContractRecipient();
    if (recipientType === true) return this.acknowledgedContract();
    if (recipientType === null) {
      return this.recipientCheckFailed() && this.acknowledgedUnverified();
    }
    return true; // EOA → safe to proceed
  }

  /**
   * Re-run the contract-vs-EOA classification whenever the recipient changes.
   * Debounced via an epoch counter — late responses for stale addresses are
   * dropped instead of overwriting the latest result.
   */
  onRecipientAddressChange(value: string): void {
    // Invalidate any in-flight contract check FIRST — the early returns
    // below (invalid / burn / self) don't start a new check, so without
    // bumping the epoch here a stale response for the previous address
    // would pass the guard and overwrite the fresh state.
    this.contractCheckEpoch++;
    this.recipientAddress = value;
    this.brokenPaymentLink.set(false);
    this.acknowledgedContract.set(false);
    this.acknowledgedUnverified.set(false);
    this.recipientCheckFailed.set(false);
    this.isContractRecipient.set(null);
    this.isSelfRecipient.set(false);

    if (!this.sendService.isValidAddress(value)) {
      this.isCheckingRecipient.set(false);
      return;
    }

    // Burn addresses are hard-blocked in the UI — no point burning an RPC
    // round-trip classifying them (getCode returns '0x' and would paint a
    // misleading green "Wallet address" badge anyway).
    if (isBurnAddress(value)) {
      this.isCheckingRecipient.set(false);
      return;
    }

    // Sending to your own connected wallet — skip the contract check. With
    // Privy AA / smart-account setups the user's own address surfaces as a
    // contract on every L2 they've ever touched, and warning them about
    // their own wallet is just noise.
    const ownAddress = this.walletService.address();
    if (ownAddress && ownAddress.toLowerCase() === value.toLowerCase()) {
      this.isSelfRecipient.set(true);
      this.isContractRecipient.set(false);
      this.isCheckingRecipient.set(false);
      return;
    }

    // Like the early returns above, must clear the checking flag itself:
    // the epoch bump means a stale in-flight `.then` no longer does it.
    const network = this.selectedNetwork();
    if (!network) {
      this.isCheckingRecipient.set(false);
      return;
    }

    const epoch = this.contractCheckEpoch;
    this.isCheckingRecipient.set(true);

    this.sendService.isContractAddress(value, network.id).then((isContract) => {
      // Drop stale results — user kept typing, a newer check is in flight.
      if (epoch !== this.contractCheckEpoch) return;
      this.isContractRecipient.set(isContract);
      // `null` here means every RPC failed — surface it as a distinct state
      // so the UI warns and asks for acknowledgment instead of silently
      // enabling (or forever disabling) the Review button.
      this.recipientCheckFailed.set(isContract === null);
      this.isCheckingRecipient.set(false);
    });
  }

  async goToReview(): Promise<void> {
    // Defense in depth: the template's button chain already gates on this,
    // but the recipient-safety verdict must hold no matter how we got here.
    if (!this.canProceedToReview()) return;

    this.currentStep.set('review');
    this.focusStepHeading();

    // Kick off real gas estimate — replaces the hardcoded "$0.01 - $0.10"
    // placeholder. UI shows "Estimating…" while we wait, "Could not
    // estimate" if the RPC fails (same shape the simulation uses for swap).
    const token = this.selectedToken();
    if (!token || !this.amount) return;

    this.analytics.track('send_review_opened', this.sendAnalyticsProps(token.chainId));

    this.isEstimatingGas.set(true);
    this.gasEstimateUSD.set(null);
    try {
      const estimate = await this.sendService.estimateGas(
        token as unknown as Token,
        this.recipientAddress,
        // Clamp to the token's precision — `toString()` on a USD-derived
        // amount overflows parseUnits for decimals<18 tokens, which made
        // gas estimation always fail for USDC/USDT. Truncated so it matches
        // the exact amount executeSend will sign.
        this.toAmountString(this.tokenAmount(), Math.min(8, token.decimals)),
      );
      this.gasEstimateUSD.set(estimate?.estimatedCostUSD ?? null);
    } catch {
      this.gasEstimateUSD.set(null);
    } finally {
      this.isEstimatingGas.set(false);
    }
  }

  async executeSend(): Promise<void> {
    const portfolioToken = this.selectedToken();
    if (!portfolioToken) return;

    this.currentStep.set('status');
    this.txStatus.set('signing');
    this.txHash.set('');
    this.explorerUrl.set('');
    this.txError.set('');
    this.focusStepHeading();

    // Convert PortfolioToken to Token for SendService
    const token: Token = {
      address: portfolioToken.address,
      symbol: portfolioToken.symbol,
      name: portfolioToken.name,
      decimals: portfolioToken.decimals,
      chainId: portfolioToken.chainId,
      logoURI: portfolioToken.logoURI,
      priceUSD: portfolioToken.priceUSD,
    };

    // Always send in token amount, clamped to the token's precision — a
    // hard toFixed(8) overflows parseUnits ('too many decimals for format')
    // for decimals<8 tokens like USDC/USDT (6), especially in USD mode.
    // Truncated, never rounded: half-up rounding could sign more than the
    // user confirmed (or more than the balance after MAX).
    const sendAmount = this.toAmountString(this.tokenAmount(), Math.min(8, portfolioToken.decimals));
    const priceUSD = parseFloat(portfolioToken.priceUSD) || 0;
    const amountUSD = this.tokenAmount() * priceUSD;

    // Create transaction history record
    let txRecord: ReturnType<typeof this.txHistoryService.createSendTransaction> | null = null;
    try {
      txRecord = this.txHistoryService.createSendTransaction({
        token: {
          symbol: portfolioToken.symbol,
          name: portfolioToken.name,
          address: portfolioToken.address,
          chainId: portfolioToken.chainId,
          amount: sendAmount,
          amountUSD: amountUSD,
          logoURI: portfolioToken.logoURI,
        },
        toAddress: this.recipientAddress,
        chainId: portfolioToken.chainId,
      });
    } catch {
      // No wallet connected - skip history tracking
    }

    const result = await this.sendService.send(
      token,
      this.recipientAddress,
      sendAmount,
      (status, hash) => {
        // SendService switches the wallet's network first when needed —
        // without this branch the screen claims "Sign the transaction"
        // while the wallet is actually asking to approve a network change.
        if (status === 'switching') this.txStatus.set('switching');
        else if (status === 'signing') this.txStatus.set('signing');
        else if (status === 'pending') {
          this.txStatus.set('pending');
          // Surface the hash + explorer link to the UI as soon as the tx is
          // broadcast — but DO NOT mark history as success yet. The receipt
          // might come back reverted (status === 0); markSuccess belongs in
          // the result-handling block below, after confirmTransaction.
          if (hash) {
            this.txHash.set(hash);
            this.explorerUrl.set(getExplorerTxUrl(portfolioToken.chainId, hash));
          }
        }
        else if (status === 'completed') this.txStatus.set('completed');
      }
    );

    if (result.success) {
      // Update history if not already done in callback above
      if (txRecord) {
        this.txHistoryService.markSuccess(txRecord.id, result.txHash);
      }

      this.analytics.track('send_completed', this.sendAnalyticsProps(portfolioToken.chainId));
      this.txStatus.set('completed');
      this.txHash.set(result.txHash || '');
      this.explorerUrl.set(result.explorerUrl || '');
      this.toastService.success(
        'Sent!',
        `${this.tokenAmount().toFixed(6)} ${portfolioToken.symbol} sent successfully`,
        result.explorerUrl ? { text: 'View on explorer', url: result.explorerUrl } : undefined
      );

      // Trigger dashboard balance refresh
      this.balanceRefreshService.triggerRefresh();
    } else {
      const rawError = result.error || 'Transaction failed';

      // Update transaction history as failed — history keeps the RAW
      // message for support/debugging; only the UI surfaces are sanitized.
      if (txRecord) {
        this.txHistoryService.markFailed(txRecord.id, rawError);
      }

      // SendService maps ACTION_REJECTED/4001 to a "rejected"-bearing
      // message — same cheap discriminator the swap funnel uses.
      this.analytics.track('send_failed', {
        ...this.sendAnalyticsProps(portfolioToken.chainId),
        reason: rawError.toLowerCase().includes('rejected') ? 'rejected' : 'failed',
      });

      // Boundary sanitization: SendService passes raw provider/ethers
      // messages through on unmapped failures — the failure screen and
      // toast get calm copy; app-authored messages pass through verbatim.
      const presented = presentError(rawError, 'send');
      this.txStatus.set('failed');
      this.txError.set(presented.short);
      this.toastService.error('Send failed', presented.short);
    }
  }

  reset(): void {
    // Captured before txStatus is wiped below: a completed send changed
    // on-chain balances, so the reload must bypass the TTL cache — within
    // its 12 s window the cache still holds PRE-send balances and the form
    // would validate a second send against a phantom balance.
    const afterSuccessfulSend = this.txStatus() === 'completed';
    this.currentStep.set('form');
    this.amount = '';
    this.recipientAddress = '';
    this.inputMode.set('token');
    this.isRecipientLocked.set(false); // Unlock recipient for new transaction
    this.isPaymentLink.set(false); // No longer a payment link
    this.brokenPaymentLink.set(false);
    this.linkTokenNotFound.set(false);
    this.isContractRecipient.set(null);
    this.isCheckingRecipient.set(false);
    this.recipientCheckFailed.set(false);
    this.acknowledgedContract.set(false);
    this.acknowledgedUnverified.set(false);
    this.isSelfRecipient.set(false);
    this.urlParamsApplied = false;
    this.urlParams = { to: '', amount: '', token: '', tokenAddress: '', chain: 0 };
    this.txStatus.set('idle');
    this.txHash.set('');
    this.explorerUrl.set('');
    this.txError.set('');
    this.loadTokensForNetwork(afterSuccessfulSend ? { force: true } : undefined);
    this.focusStepHeading();
  }

  /**
   * Switch wallet to the required network for payment link
   */
  private async switchToPaymentLinkNetwork(chainId: number): Promise<void> {
    try {
      const currentChain = this.walletService.currentChain();
      const currentChainId = currentChain?.id;

      if (currentChainId !== chainId) {
        const network = this.networks.find(n => n.id === chainId);
        const networkName = network?.name || `Chain ${chainId}`;

        this.toastService.info('Switching network', `Switching to ${networkName}…`);

        const switched = await this.walletService.switchChain(chainId);

        if (switched) {
          this.toastService.success('Network switched', `Now on ${networkName}`);
          // Reload tokens after network switch
          await this.loadTokensForNetwork();
        } else {
          this.toastService.warning(
            'Network switch required',
            `Please switch to ${networkName} to complete this payment`
          );
        }
      }
    } catch (error) {
      console.error('Failed to switch network for payment link:', error);
      const network = this.networks.find(n => n.id === chainId);
      this.toastService.warning(
        'Network switch required',
        `Please switch to ${network?.name || 'the required network'} manually`
      );
    }
  }

  /**
   * Format the estimated network fee for display. Shows "<$0.01" for a real
   * sub-cent fee instead of rounding it to "$0.00" (which read as a free
   * transfer). Shared with the swap review via `formatUsdFee`.
   */
  formatFeeUsd(value: string): string {
    return formatUsdFee(value);
  }

  // Helpers
  getNetworkName = getNetworkName;
  getNetworkLogo = getNetworkLogo;
  getExplorerAddressUrl = getExplorerAddressUrl;
}
