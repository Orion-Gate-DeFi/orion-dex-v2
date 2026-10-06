import { ChangeDetectionStrategy, Component, ElementRef, inject, signal, computed, effect, untracked, viewChild, OnDestroy, NgZone, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { formatUnits, parseUnits } from 'ethers';
import { WalletService } from '../../core/services/wallet.service';
import { LifiService } from '../../core/services/lifi.service';
import { ActiveSwapHubService, isSwapSettled } from '../../core/services/swap/active-swap-hub.service';
import type { ActiveSwapPhase, ActiveSwapSummary } from '../../core/services/swap/active-swap-hub.service';
import { ToastService } from '../../core/services/toast.service';
import { SettingsService } from '../../core/services/settings.service';
import { BalanceRefreshService } from '../../core/services/balance-refresh.service';
import { TransactionHistoryService } from '../../core/services/transaction-history.service';
import { TokenSecurityService, RiskLevel } from '../../core/services/token-security.service';
import { AuthService } from '../../core/services/auth.service';
import { truncateDecimals } from '../../core/services/send.service';
import { AnalyticsService, AnalyticsProps, usdBand } from '../../core/services/analytics.service';
import { Token } from '../../core/models/token.model';
import { SwapQuote, TransactionStatus, TransactionTrackingState, AggregatorName } from '../../core/models/swap.model';
import { TokenSelectorComponent } from './token-selector/token-selector.component';
import { SettingsPanelComponent } from './settings-panel/settings-panel.component';
import { OrionAmountPanelComponent } from './orion/orion-amount-panel.component';
import { OrionSwapCenterComponent } from './orion/orion-swap-center.component';
import { OrionInfoStripComponent, InfoCell } from './orion/orion-info-strip.component';
import { OrionStepperComponent, StepperItem } from './orion/orion-stepper.component';
import { TransactionHealthComponent } from './transaction-health/transaction-health.component';
import { FocusTrapDirective } from '../../shared/directives/focus-trap.directive';
import { replaceWithLetterIcon } from '../../core/utils/token-icon';
import { formatUsdFee } from '../../core/utils/format-usd-fee';
import { fetchReceiptWithFallback } from '../../core/utils/fetch-receipt';
import { presentError, truncateErrorForCta } from '../../core/utils/error-presenter';
import {
  getNetworkById,
  getNetworkName,
  getNetworkLogo,
  getExplorerTxUrl,
  getExplorerAddressUrl,
} from '../../core/constants';
import { selectMinimumReceived } from '../../core/services/swap/quote.service';
import { SwapIntentService } from '../../core/services/swap/swap-intent.service';
import { StatusIconComponent } from '../../shared/components/status-icon/status-icon.component';

type SwapStep = 'swap' | 'review' | 'status';

/**
 * Hard ceiling on how much worse the silent pre-sign re-quote may be than the
 * price the user confirmed on review before execution aborts and an explicit
 * re-confirm is required (0.005 = 0.5%).
 */
export const REQUOTE_MAX_WORSENING = 0.005;

/**
 * Relative worsening between the destination amount the user confirmed and
 * the silently re-quoted one. Positive means the user would receive LESS
 * (0.01 = 1% worse), negative means an improvement, 0 means unchanged.
 * Non-numeric input or a non-positive previous amount returns 0 — the gate
 * fails open and the regular "price updated" toast still informs the user.
 */
export function computeQuoteWorsening(oldAmount: string, newAmount: string): number {
  const oldNum = parseFloat(oldAmount);
  const newNum = parseFloat(newAmount);
  if (!Number.isFinite(oldNum) || !Number.isFinite(newNum) || oldNum <= 0) {
    return 0;
  }
  return (oldNum - newNum) / oldNum;
}

/**
 * Normalize a typed or pasted amount. Commas are interpreted BEFORE invalid
 * characters are stripped — stripping first silently turned a European-style
 * paste like '1,5' into '15', a 10x amount. Disambiguation:
 *   - both ',' and '.' present → the rightmost is the decimal mark, the
 *     other is a thousands separator ('1,000.5' and '1.000,5' → 1000.5);
 *   - a single comma → decimal mark ('1,5' → 1.5). The interpretation is
 *     visible: the normalized value is written straight back into the input;
 *   - several commas, no dot → thousands separators ('1,000,000' → 1000000).
 * At most one dot survives, so garbage like '1.2.3' collapses to '1.23'
 * instead of keeping a second dot.
 */
export function sanitizeAmountInput(value: string): string {
  let normalized = value;
  const lastComma = normalized.lastIndexOf(',');
  if (lastComma !== -1) {
    const lastDot = normalized.lastIndexOf('.');
    if (lastDot !== -1) {
      normalized = lastComma > lastDot
        ? normalized.replace(/\./g, '').replace(/,/g, '.')
        : normalized.replace(/,/g, '');
    } else {
      const commaCount = (normalized.match(/,/g) ?? []).length;
      normalized = commaCount > 1
        ? normalized.replace(/,/g, '')
        : normalized.replace(/,/g, '.');
    }
  }
  normalized = normalized.replace(/[^0-9.]/g, '');
  const firstDot = normalized.indexOf('.');
  if (firstDot === -1) return normalized;
  return (
    normalized.slice(0, firstDot + 1) +
    normalized.slice(firstDot + 1).replace(/\./g, '')
  );
}

/**
 * Strictly grouped, dot-free amount ('1,000', '1,500', '1,000,000') — the
 * one comma shape that is genuinely ambiguous: US thousands grouping reads
 * '1,500' as 1500 while EU decimal notation reads it as 1.5. The sanitizer
 * would silently pick the decimal reading, so the input handler refuses
 * these outright instead of guessing. Such a value can only arrive via
 * paste: typed input never forms the pattern because the sanitizer's
 * write-back converts a lone comma to a dot on the very next keystroke and
 * the keydown filter blocks a second separator.
 */
export function isAmbiguousGroupedAmount(value: string): boolean {
  return /^\d{1,3}(,\d{3})+$/.test(value.trim());
}

/**
 * Numeric equality for human-unit amount strings — '5', '5.0' and '5.000'
 * are the same amount, so trailing zeros never count as a mismatch. A tiny
 * relative tolerance absorbs wei-level truncation an aggregator may apply
 * when echoing the requested amount; any difference a user could actually
 * type stays a mismatch. Unparseable input never equals anything.
 */
export function amountsNumericallyEqual(a: string, b: string): boolean {
  const aNum = parseFloat(a);
  const bNum = parseFloat(b);
  if (!Number.isFinite(aNum) || !Number.isFinite(bNum)) return false;
  if (aNum === bNum) return true;
  const scale = Math.max(Math.abs(aNum), Math.abs(bNum));
  return Math.abs(aNum - bNum) / scale < 1e-9;
}

/**
 * `percent` of a raw (wei) balance as a decimal string truncated — never
 * rounded — to `maxDecimals`. All math is bigint: the old float path
 * (`(usable * percent / 100).toFixed(p)`) rounds half-up, so MAX on a
 * balance of 1.999999995 produced '2.00000000' — more than the wallet
 * holds, i.e. a false 'Not enough X' right after pressing MAX or an
 * on-chain revert.
 */
export function percentOfRawBalance(
  raw: bigint,
  decimals: number,
  percent: number,
  maxDecimals: number,
): string {
  const pct = BigInt(Math.min(100, Math.max(0, Math.floor(percent))));
  const portion = (raw * pct) / 100n;
  if (portion <= 0n) return '0';
  return truncateDecimals(formatUnits(portion, decimals), maxDecimals);
}

/**
 * True when an execution error is the user declining the signature in their
 * wallet. The execution service normalizes ACTION_REJECTED/4001 to
 * 'Transaction was rejected by user'; the other patterns cover wallets whose
 * rejections reach us as raw provider messages without the ethers code
 * (MetaMask legacy 'User denied…', viem-style 'User rejected the request').
 * Rejection is a normal action, not a failure — the caller returns to review
 * instead of painting the red failure screen.
 */
export function isUserRejectionError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('rejected by user') ||
    m.includes('user rejected') ||
    m.includes('user denied')
  );
}

/**
 * Chain-aware gas-cost label. The flat L2 thresholds (<$1/<$1.5/<$2) made
 * every normal mainnet swap read 'Very High' — $5 of mainnet gas is an
 * ordinary Tuesday, not an alarm. Mainnet gets its own scale; L2s/Polygon
 * keep the tight one, where $2 genuinely is expensive.
 */
export function gasCostLabel(costUsd: number, chainId: number): string {
  if (!Number.isFinite(costUsd)) return 'Normal';
  if (chainId === 1) {
    if (costUsd < 3) return 'Cheap';
    if (costUsd < 8) return 'Medium';
    if (costUsd < 15) return 'High';
    return 'Very High';
  }
  if (costUsd < 1) return 'Cheap';
  if (costUsd < 1.5) return 'Medium';
  if (costUsd < 2) return 'High';
  return 'Very High';
}

/**
 * Best-effort estimate of the swap's gas cost in NATIVE units for the
 * review-step "can this wallet even pay for gas?" preflight. Sources, most
 * exact first:
 *   1. LI.FI quotes carry the gas cost in wei;
 *   2. backend aggregator quotes carry gas UNITS (`estimated_gas`) — convert
 *      with the live gas price (gwei);
 *   3. the quote's USD gas estimate over the native token's USD price.
 * Returns null when nothing can be derived — the preflight then fails OPEN
 * (no warning) rather than guessing.
 */
export function estimateNativeGasCost(
  q: SwapQuote,
  gasPriceGwei: number | null,
  nativeUsdPrice: number | null,
): number | null {
  const lifiWei = q._lifiRoute?.estimate?.gasCosts?.[0]?.amount;
  if (lifiWei) {
    const wei = Number(lifiWei);
    if (Number.isFinite(wei) && wei > 0) return wei / 1e18;
  }
  const units = Number(q._aggregatorData?.estimated_gas ?? NaN);
  if (Number.isFinite(units) && units > 0 && gasPriceGwei !== null && gasPriceGwei > 0) {
    return units * gasPriceGwei * 1e-9;
  }
  const usd = parseFloat(q.gasCostUSD);
  if (Number.isFinite(usd) && usd > 0 && nativeUsdPrice !== null && nativeUsdPrice > 0) {
    return usd / nativeUsdPrice;
  }
  return null;
}

/** localStorage flag for the one-time Flashbots Protect hint (mainnet, injected wallets). */
const MEV_HINT_DISMISSED_KEY = 'orion_mev_hint_dismissed';

/** Read the MEV-hint dismissal flag; private browsing can throw on access. */
function readMevHintDismissed(): boolean {
  try {
    return localStorage.getItem(MEV_HINT_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Price impact (percent) at and above which Confirm is hard-blocked. */
export const EXTREME_IMPACT_PERCENT = 15;

/** Price impact (percent) at and above which an explicit ack is required. */
export const HIGH_IMPACT_PERCENT = 5;

/** Canonical reason strings emitted by `assessQuoteRisk` — the component maps
 *  them to user-facing checkbox copy in `quoteRiskAckLabel`. */
export const RISK_REASON_EXTREME_IMPACT = 'extreme price impact';
export const RISK_REASON_HIGH_IMPACT = 'high price impact';
export const RISK_REASON_IMPACT_UNKNOWN = 'price impact unknown';
export const RISK_REASON_USD_UNKNOWN = "couldn't estimate the USD value";

export interface QuoteRiskInput {
  /** Parsed price impact in percent; null = unknown (the info strip shows "—"). */
  priceImpact: number | null;
  /** From-side USD value; null = unknown (the quote sentinel '0' / unparseable). */
  fromAmountUSD: number | null;
  /** From-side token amount the quote was made for. */
  fromAmount: number;
  /** USD value at and above which the separate high-value ack applies. */
  highValueThreshold: number;
}

export interface QuoteRiskAssessment {
  /** Confirm stays disabled; no checkbox can bypass. */
  hardBlock: boolean;
  /** Confirm requires the single risk-ack checkbox. Always false when hard-blocked. */
  needsAck: boolean;
  /** Active risk reasons, in display order. */
  reasons: string[];
  /** The existing high-value acknowledgement applies (kept as its own checkbox). */
  highValue: boolean;
}

/**
 * Tiered confirmation gate for the review step. Pure so the boundary rules
 * (5% ack / 15% block / $1k high-value / unknown impact / unknown USD) are
 * unit-testable without TestBed. Callers only invoke this when a quote
 * exists — "impact unknown" therefore always means "we have a quote but
 * couldn't price its impact", which is exactly where bad trades hide.
 */
export function assessQuoteRisk(input: QuoteRiskInput): QuoteRiskAssessment {
  const reasons: string[] = [];
  let hardBlock = false;

  if (input.priceImpact === null) {
    reasons.push(RISK_REASON_IMPACT_UNKNOWN);
  } else if (input.priceImpact >= EXTREME_IMPACT_PERCENT) {
    hardBlock = true;
    reasons.push(RISK_REASON_EXTREME_IMPACT);
  } else if (input.priceImpact >= HIGH_IMPACT_PERCENT) {
    reasons.push(RISK_REASON_HIGH_IMPACT);
  }

  if (input.fromAmountUSD === null && input.fromAmount > 0) {
    reasons.push(RISK_REASON_USD_UNKNOWN);
  }

  return {
    hardBlock,
    needsAck: !hardBlock && reasons.length > 0,
    reasons,
    highValue:
      input.fromAmountUSD !== null && input.fromAmountUSD >= input.highValueThreshold,
  };
}

@Component({
  selector: 'app-swap',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    TokenSelectorComponent,
    SettingsPanelComponent,
    OrionAmountPanelComponent,
    OrionSwapCenterComponent,
    OrionInfoStripComponent,
    OrionStepperComponent,
    TransactionHealthComponent,
    FocusTrapDirective,
    StatusIconComponent,
  ],
  // Safe on OnPush: every template binding reads signals/computeds — directly
  // or through signal-backed getters (fromAmount) and methods over signals
  // (isCrossChain, getGasLabel…). The plain class fields (seq counters,
  // balanceCache, in-flight flags) are never template-bound, and all timer /
  // async callbacks write signals, which mark the view dirty themselves.
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './swap.component.html'
})
export class SwapComponent implements OnDestroy {
  walletService = inject(WalletService);
  lifiService = inject(LifiService);
  toastService = inject(ToastService);
  private activeSwapHub = inject(ActiveSwapHubService);
  settingsService = inject(SettingsService);
  private balanceRefreshService = inject(BalanceRefreshService);
  private txHistoryService = inject(TransactionHistoryService);
  private tokenSecurity = inject(TokenSecurityService);
  private authService = inject(AuthService);
  private analytics = inject(AnalyticsService);
  private ngZone = inject(NgZone);
  private swapIntent = inject(SwapIntentService);

  /**
   * Funnel-event props for a quote. Deliberately coarse — chain ids,
   * topology, token SYMBOLS, the winning aggregator, and a bucketed USD
   * band. Never exact amounts, never addresses (symbols are shared by
   * thousands of holders; a precise USD value + timestamp could be matched
   * to a public on-chain transaction and de-anonymize the wallet).
   */
  private swapAnalyticsProps(q: SwapQuote): AnalyticsProps {
    const props: AnalyticsProps = {
      from_chain: q.fromToken.chainId,
      to_chain: q.toToken.chainId,
      from_token: q.fromToken.symbol,
      to_token: q.toToken.symbol,
      cross_chain: q.fromToken.chainId !== q.toToken.chainId,
      usd_band: usdBand(q.fromAmountUSD),
    };
    if (q.aggregator) {
      props['aggregator'] = q.aggregator;
    }
    return props;
  }

  /** GoPlus-derived safety for the toToken (buy side is where scams live). */
  safetyLevel = signal<RiskLevel | null>(null);

  /**
   * Deterministic unsellable-token verdict for the toToken (honeypot,
   * counterfeit, cannot_sell_all, >50% sell tax — see
   * `TokenSecurityResult.hardBlock`). Same contract as `quoteRisk().hardBlock`:
   * swapping is disabled outright and NO acknowledgement checkbox can bypass
   * it — an "I understand" tick cannot make an unsellable token sellable.
   */
  hardBlockToken = signal<boolean>(false);

  /**
   * The user has explicitly acknowledged that the destination token has
   * elevated risk. Reset whenever the toToken changes — we never carry an
   * acknowledgement from one token onto another, even if both happen to be
   * "high" risk.
   */
  acknowledgedHighRisk = signal<boolean>(false);

  /** Threshold above which a swap requires an extra confirmation gate. */
  readonly HIGH_VALUE_USD = 1000;

  /**
   * Acknowledged for the *current* quote that the user understands the swap
   * is large. Re-asked whenever a fresh quote lands so the user can't
   * acknowledge a $100 swap and have it carry over to a $10k one.
   */
  acknowledgedHighValue = signal<boolean>(false);

  /**
   * Pre-sign simulation state for the review screen. `idle` outside review
   * (or no quote), `pending` while the eth_call is in flight, then
   * `success` / `revert` / `error`. The Confirm CTA reads this to gate
   * obviously-failing transactions before they cost gas.
   */
  simulationState = signal<{
    status: 'idle' | 'pending' | 'success' | 'revert' | 'error';
    reason?: string;
    /** 'inconclusive' is component-local: eth_call produced no verdict either
     *  way (e.g. "missing revert data") — rendered as "couldn't pre-check",
     *  never as a green pass. */
    kind?: 'allowance' | 'slippage' | 'transfer' | 'unknown' | 'inconclusive';
  }>({ status: 'idle' });

  /** Confirms the user understands the simulation reverted but wants to proceed anyway. */
  acknowledgedSimulationFailure = signal<boolean>(false);

  /**
   * Review-step native-gas preflight result. Non-null when the wallet's
   * native balance on the source chain can't cover the estimated network
   * fee (plus the swap amount itself for native swaps) — the honest move is
   * to block Confirm with the reason instead of letting the signature fail
   * with a confusing wallet error. Null = no shortfall detected OR the
   * check couldn't run (fails open: a flaky balance fetch must never block
   * a legitimate swap).
   */
  nativeGasShortfall = signal<{ nativeSymbol: string; requiredDisplay: string } | null>(null);

  /** Sequence guard for the async native-gas check — same race as fetchQuote. */
  private gasFundsCheckSeq = 0;

  /**
   * Swap broadcast but no receipt within the wait window — confirmation
   * unknown (same-chain: the swap itself; cross-chain: the SOURCE leg).
   * Drives the honest "sent, waiting for confirmation" presentation and
   * unlocks the "Start new swap" exit while the background receipt
   * re-poll keeps watching.
   */
  awaitingReceiptConfirmation = signal<boolean>(false);

  // Background receipt re-poll for an unconfirmed same-chain broadcast.
  // Fields (not consts) so specs can shrink the clock; fetchReceipt is an
  // indirection over the module util so specs can stub the network.
  private receiptRepollIntervalMs = 10_000;
  private receiptRepollWindowMs = 5 * 60_000;
  private fetchReceipt: typeof fetchReceiptWithFallback = fetchReceiptWithFallback;

  /**
   * True while `executeSwap()` is doing its pre-broadcast work — the silent
   * re-quote, simulation, signer dance — but hasn't yet flipped
   * `transactionStatus` to `'signing'`. Used to block double-clicks on
   * Confirm during that ~1-2s window where the UI otherwise looks frozen.
   */
  isExecutingPreflight = signal<boolean>(false);

  /**
   * Set when the pre-sign silent re-quote came back more than
   * `REQUOTE_MAX_WORSENING` worse than the price the user confirmed on
   * review. Execution is aborted, the fresh quote is applied, and this
   * drives the warning banner on the review screen until the user
   * re-confirms, cancels, or a new quote arrives.
   */
  requotePriceNotice = signal<{
    previousToAmount: string;
    newToAmount: string;
    toSymbol: string;
  } | null>(null);

  /**
   * "~0.6% less" suffix for the price-move banner. Fixed-decimal token
   * formatting can render the old and new amounts identically for small
   * worsenings (0.0005 vs 0.0004971 both display as "0.0005"), so the
   * banner always spells out the relative change too. Floored at 0.1% so
   * rounding can never print a "0.0%" that contradicts the warning.
   */
  readonly requotePriceDropLabel = computed<string>(() => {
    const notice = this.requotePriceNotice();
    if (!notice) return '';
    const worsening = computeQuoteWorsening(notice.previousToAmount, notice.newToAmount);
    if (worsening <= 0) return '';
    return `~${Math.max(0.1, worsening * 100).toFixed(1)}% less`;
  });

  /**
   * User ticked the single risk-ack checkbox for the *current* quote
   * (high/unknown price impact, unverifiable USD value). Reset whenever a
   * fresh quote lands or review is (re-)entered — never carried over.
   */
  acknowledgedQuoteRisk = signal<boolean>(false);

  /**
   * Parsed price impact for the risk gate, null = unknown. The quote
   * service returns '0' both as its "no USD leg available" sentinel AND
   * for a genuinely zero impact, so we discriminate on the actual
   * condition — the USD legs themselves: with BOTH legs priced the impact
   * is known (zero / favorable drift clamps to 0 — no ack), with a leg
   * missing it is unknown (ack required). The info strip reads this same
   * computed, so the gate and the "—" cell can never disagree.
   */
  readonly quoteRiskImpact = computed<number | null>(() => {
    const q = this.quote();
    if (!q) return null;
    const fromUsd = parseFloat(q.fromAmountUSD);
    const toUsd = parseFloat(q.toAmountUSD);
    const hasUsdLegs =
      Number.isFinite(fromUsd) && fromUsd > 0 && Number.isFinite(toUsd) && toUsd > 0;
    if (!hasUsdLegs) return null;
    const impact = parseFloat(q.priceImpact);
    return Number.isFinite(impact) ? Math.max(0, impact) : null;
  });

  /** Tiered confirmation gate for the current quote (see `assessQuoteRisk`). */
  readonly quoteRisk = computed<QuoteRiskAssessment>(() => {
    const q = this.quote();
    if (!q) {
      return { hardBlock: false, needsAck: false, reasons: [], highValue: false };
    }
    const usd = parseFloat(q.fromAmountUSD);
    const amount = parseFloat(q.fromAmount);
    return assessQuoteRisk({
      priceImpact: this.quoteRiskImpact(),
      // '0' is the quote-service sentinel for "no USD price available" —
      // anything non-positive is unknown, mirroring formatUsd's "—".
      fromAmountUSD: Number.isFinite(usd) && usd > 0 ? usd : null,
      fromAmount: Number.isFinite(amount) ? amount : 0,
      highValueThreshold: this.HIGH_VALUE_USD,
    });
  });

  /** Checkbox copy listing the active risk reasons in plain English. */
  readonly quoteRiskAckLabel = computed<string>(() => {
    const risk = this.quoteRisk();
    if (risk.reasons.length === 0) return '';
    const impact = this.quoteRiskImpact();
    const phrases = risk.reasons.map((reason) => {
      switch (reason) {
        case RISK_REASON_HIGH_IMPACT:
          return impact !== null
            ? `high price impact (${impact.toFixed(1)}%)`
            : 'high price impact';
        case RISK_REASON_IMPACT_UNKNOWN:
          return "the price impact of this swap couldn't be determined";
        case RISK_REASON_USD_UNKNOWN:
          return "the USD value of this swap couldn't be verified";
        default:
          return reason;
      }
    });
    return `I understand: ${phrases.join(', and ')}`;
  });

  /**
   * True when the from-side USD value crosses the high-value threshold —
   * fat-finger swaps at $5k/$50k are exactly where users want a moment of
   * pause and an explicit "yes I meant that". An unknown USD value (the
   * sentinel '0') no longer silently passes — the risk gate above asks for
   * its own acknowledgement instead.
   */
  readonly isHighValueSwap = computed(() => this.quoteRisk().highValue);

  /** True when the security provider reported `'critical'` for the destination
   *  token — proceed only with explicit user ack (deterministic scam flags
   *  escalate further to `hardBlockToken`, which no ack can bypass). */
  readonly isCriticalRiskToken = computed(() => this.safetyLevel() === 'critical');

  /** True for `'high'` — same flow as critical, different copy. */
  readonly isHighRiskToken = computed(() => this.safetyLevel() === 'high');

  /**
   * True when the security check produced NO verdict ('unknown': GoPlus
   * down, rate-limited, or no data for the contract). Fails closed: an
   * unverifiable token requires the same explicit risk ack as a high-risk
   * one — "we couldn't check" must never render as the absence of a gate,
   * because that's exactly the window a scam token would aim for.
   * `null` (check still in flight / no toToken) deliberately doesn't gate.
   */
  readonly isUnverifiedToken = computed(() => this.safetyLevel() === 'unknown');

  /**
   * The destination token needs the explicit risk acknowledgement before the
   * swap-step CTA unlocks. False while hard-blocked — the checkbox would
   * suggest a bypass that doesn't exist.
   */
  readonly requiresTokenRiskAck = computed(
    () =>
      !this.hardBlockToken() &&
      (this.isCriticalRiskToken() || this.isHighRiskToken() || this.isUnverifiedToken()),
  );

  /**
   * One-time MEV honesty hint: swaps broadcast to the public mempool, and
   * MetaMask-style injected wallets on Ethereum mainnet can opt into
   * Flashbots Protect themselves. Embedded (Privy) wallets can't change
   * their RPC, so the hint would only confuse — and L2 sequencers have no
   * public mempool to front-run, hence the chainId 1 condition on the
   * SOURCE chain (where the swap tx actually broadcasts).
   */
  readonly mevHintDismissed = signal<boolean>(readMevHintDismissed());

  readonly showMevHint = computed(
    () =>
      !this.mevHintDismissed() &&
      this.walletService.isConnected() &&
      !this.authService.isEmbeddedSession() &&
      this.fromToken()?.chainId === 1,
  );

  dismissMevHint(): void {
    this.mevHintDismissed.set(true);
    try {
      localStorage.setItem(MEV_HINT_DISMISSED_KEY, '1');
    } catch {
      // Private browsing: the in-memory signal still hides it for the session.
    }
  }

  ngOnDestroy(): void {
    if (this.quoteDebounceTimer) {
      clearTimeout(this.quoteDebounceTimer);
    }
    if (this.gasUpdateInterval) {
      clearInterval(this.gasUpdateInterval);
    }
    if (this.txElapsedTimer) {
      clearInterval(this.txElapsedTimer);
      this.txElapsedTimer = null;
    }
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.stopQuoteAutoRefresh();
    // Deliberately NO abort of cross-chain bridge tracking here: the loops
    // are owned by ActiveSwapHubService and survive navigation — the pill
    // and the history verdicts depend on them outliving this component.
  }

  /**
   * Close any open modal/panel when the user hits Escape — required for
   * keyboard-only navigation (and just polite UX). Order matters: we close
   * the *most recently opened* surface first so a user with the cross-chain
   * modal open doesn't accidentally drop the underlying token selector.
   *
   * Listener ordering: document listeners fire in registration order, and
   * this component mounts before any of its conditionally-rendered children
   * — so this handler always runs FIRST. When it consumes the Escape it
   * calls stopImmediatePropagation so later-registered child listeners
   * (settings panel, token selector) don't also close their layer — one
   * Escape closes exactly one layer. The settings popover is deliberately
   * NOT closed here: SettingsPanelComponent owns its own Escape so a press
   * with the slippage-confirm modal open closes only that modal instead of
   * destroying the whole panel (and the typed value) with it.
   */
  @HostListener('document:keydown.escape', ['$event'])
  handleEscape(event: KeyboardEvent): void {
    if (this.showCrossChainConfirm()) {
      this.showCrossChainConfirm.set(false);
      event.stopImmediatePropagation();
      return;
    }
    if (this.showTokenSelector()) {
      this.showTokenSelector.set(false);
      event.stopImmediatePropagation();
    }
  }

  /** Active step's heading (`#stepHeading`, tabindex="-1") — exactly one
   *  renders at a time, so a single query covers all three steps. */
  private readonly stepHeading = viewChild<ElementRef<HTMLElement>>('stepHeading');

  /**
   * Move focus to the new step's heading after a swap/review/status switch.
   * Without this the activated button is destroyed with the old step and
   * focus silently drops to <body> — keyboard users restart from the header,
   * screen-reader users get no signal that the screen changed. setTimeout
   * lets change detection render the new step before the query is read.
   * (Same pattern as the skip-link `<main tabindex="-1">` and the send page.)
   */
  private focusStepHeading(): void {
    setTimeout(() => this.stepHeading()?.nativeElement.focus());
  }

  // UI State
  currentStep = signal<SwapStep>('swap');
  showSettings = signal(false);
  showTokenSelector = signal(false);
  selectingFor = signal<'from' | 'to'>('from');

  // Swap State
  fromToken = signal<Token | null>(null);
  toToken = signal<Token | null>(null);
  /**
   * Typed pay-side amount. Signal-backed (the getter/setter pair keeps every
   * existing `this.fromAmount` call site and template binding intact) so
   * computeds like `quoteMatchesInput` re-evaluate on every keystroke — a
   * plain field left them blind during the 500 ms quote debounce.
   */
  private readonly fromAmountState = signal<string>('');
  get fromAmount(): string {
    return this.fromAmountState();
  }
  set fromAmount(value: string) {
    this.fromAmountState.set(value);
  }
  fromBalance = signal<number>(0);
  /**
   * Exact decimal balance string (the untouched formatUnits output) backing
   * `fromBalance`. Percent/MAX math runs on this raw value via bigint — the
   * float twin is for display and quick comparisons only and loses precision
   * beyond ~15 significant digits.
   */
  fromBalanceExact = signal<string>('0');
  toBalance = signal<number>(0);
  quote = signal<SwapQuote | null>(null);
  isLoading = signal(false);
  error = signal<string | null>(null);
  lastExchangeRate = signal<number>(0);

  /**
   * Pay-side entry unit. `fromAmount` ALWAYS holds the token amount (the
   * single value that drives the quote, MAX and quoteMatchesInput); USD mode
   * is purely an input convenience that converts the typed dollars to a token
   * amount before quoting. Lives on the swap step only — review is read-only,
   * so the frozen quote is never affected.
   */
  inputMode = signal<'token' | 'usd'>('token');

  /** Raw dollar string the user typed while in USD mode (display only). */
  usdInput = signal<string>('');

  /**
   * Get current slippage based on whether swap is cross-chain
   * Cross-chain swaps use higher slippage (1.5%) due to more price volatility
   * Same-chain swaps use lower slippage (0.5%)
   */
  get slippage(): number {
    return this.settingsService.getSlippageForSwap(this.isCrossChain());
  }

  // Approval State
  needsApproval = signal<boolean>(false);
  isApproving = signal<boolean>(false);

  // Transaction State
  transactionStatus = signal<TransactionStatus>('idle');
  txHash = signal<string>('');
  explorerUrl = signal<string>('');
  txError = signal<string>('');

  // Real elapsed time for the pending/confirming phase. Frozen when the tx
  // completes so the receipt can show "Completed in 18s".
  txStartedAt = signal<number | null>(null);
  txElapsedSeconds = signal<number>(0);
  txCompletedInSeconds = signal<number | null>(null);
  private txElapsedTimer: ReturnType<typeof setInterval> | null = null;

  // Cross-chain confirmation modal
  showCrossChainConfirm = signal(false);
  crossChainConfirmed = signal(false);

  // Transaction tracking state (used for progress)
  trackingState = signal<TransactionTrackingState | null>(null);

  /**
   * Outbound end-to-end tracker link for the bridge wait. Two sources feed
   * it: the backend /swap/status dispatcher reports `tracking_url` while
   * live tracking runs, and a hardcoded Axelarscan fallback covers routes
   * the dispatcher can't track (UNSUPPORTED / gave up) — Squid settles
   * through Axelar, so Axelarscan can follow the transfer by source tx hash
   * even when we can't. Null for other untrackable routes — those only get
   * the source-chain explorer link.
   */
  untrackedBridgeTrackingUrl = signal<string | null>(null);

  /**
   * Exit affordance for the bridge wait. Same-chain swaps confirm in
   * seconds, but a cross-chain 'confirming' honestly lasts 5-30 minutes
   * (indefinitely for untracked routes) — once the source tx is broadcast
   * the user must be able to start the next swap without pretending the
   * current one finished. Reads the executing quote, not the live token
   * selection, so it can't flip mid-flight.
   */
  readonly canStartNewSwapWhileBridging = computed(() => {
    if (this.transactionStatus() !== 'confirming') return false;
    // Same idea for a same-chain broadcast whose receipt hasn't shown up:
    // the background re-poll can take up to 5 minutes — don't hold the
    // user hostage on the waiting screen while it watches.
    if (this.awaitingReceiptConfirmation()) return true;
    const q = this.quote();
    return !!q && q.fromToken.chainId !== q.toToken.chainId;
  });

  /**
   * Monotonic token identifying the swap whose component-local async
   * callbacks (the receipt re-polls) may touch the live UI. "Start new
   * swap" resets the screen while those may still be running — bumping the
   * session detaches the stale callbacks from the UI, while history
   * verdicts and toasts still land. Cross-chain bridge tracking no longer
   * lives here: it is hub-owned (ActiveSwapHubService) and its screen
   * binding is `hubAttached` below.
   */
  private trackingSession = 0;

  /**
   * True while the status screen is bound to the hub's active cross-chain
   * swap — set at broadcast hand-over (startBridgeTracking) and on
   * restore-on-return, released by "Start new swap" / "Try again". While
   * set, the mirror effect (see constructor) repaints trackingState /
   * transactionStatus / tracker links from hub signals. This guards only
   * screen repaints — the hub keeps tracking (and lands history verdicts
   * and toasts) regardless.
   */
  private readonly hubAttached = signal<boolean>(false);

  // Gas price indicator state. `chainId` records which chain the value was
  // fetched for — consumers doing chain-specific math (the native-gas
  // preflight) must verify it matches their chain instead of assuming the
  // cached value follows the current selection (30s cadence; the
  // constructor primes chain 1).
  currentGasPrice = signal<{ chainId: number; gwei: number; level: 'cheap' | 'normal' | 'high' | 'very_high'; usd: string } | null>(null);
  private gasUpdateInterval: ReturnType<typeof setInterval> | null = null;

  // Quote auto-refresh (every 30s)
  private quoteRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private quoteCountdownInterval: ReturnType<typeof setInterval> | null = null;
  quoteCountdown = signal(30);

  /**
   * When the pay-amount field last CHANGED. The 30s auto-refresh defers
   * only while an edit is more recent than EDIT_DEFER_MS — the old check
   * deferred on mere focus, so a focused-but-idle field blocked the
   * refresh forever and the quote silently aged past its 45s validity.
   */
  private lastAmountEditAt = 0;
  private readonly EDIT_DEFER_MS = 2000;

  /**
   * One immediate refresh when the tab becomes visible again: both 30s
   * pollers (quote auto-refresh, gas price) skip their tick while
   * `document.hidden`, so the numbers on screen can be minutes stale at the
   * moment of return. Gated to the swap step with a quote present — review
   * deliberately keeps its frozen quote (freshness chip + manual refresh own
   * that), and the status step must not refetch at all. Arrow field so
   * add/removeEventListener share one reference.
   */
  private readonly onVisibilityChange = (): void => {
    if (document.hidden) return;
    if (this.currentStep() !== 'swap' || !this.quote()) return;
    this.updateGasPrice();
    // skipCache — the point is replacing data that aged while hidden. A
    // successful fetch restarts the auto-refresh timers (countdown back
    // to 30s), so the regular cadence resumes from now.
    this.fetchQuote(true);
  };

  // ---------------------------------------------------------------------------
  // Quote freshness on the review step
  // ---------------------------------------------------------------------------
  // Auto-refresh deliberately skips the review step (rewriting numbers the
  // user is checking is worse), but the execution service hard-rejects
  // quotes older than 45s. Without a visible countdown + refresh affordance,
  // a user who dwells on review (reading the explainer the page itself
  // encourages) hits a full "Swap failed" screen. `nowTick` is advanced by
  // the 1s countdown interval.
  private readonly QUOTE_TTL_SECONDS = 45;
  /** Refresh affordance appears a few seconds before the hard cutoff. */
  private readonly QUOTE_STALE_AT_SECONDS = 40;
  private readonly nowTick = signal(Date.now());

  readonly quoteAgeSeconds = computed(() => {
    const created = this.quote()?.createdAt;
    if (!created) return 0;
    return Math.max(0, Math.floor((this.nowTick() - created) / 1000));
  });

  readonly quoteSecondsLeft = computed(() =>
    Math.max(0, this.QUOTE_TTL_SECONDS - this.quoteAgeSeconds())
  );

  readonly reviewQuoteExpired = computed(
    () => this.quoteAgeSeconds() >= this.QUOTE_STALE_AT_SECONDS
  );

  /**
   * Re-fetch the displayed quote while staying on review. Safe with respect
   * to the "don't naively re-fetch after approve" rule: `executeSwap()` still
   * runs the silent re-quote that validates `approvalAddress` and bounces to
   * the swap step (fresh approve flow) if the spender changed.
   */
  refreshReviewQuote(): void {
    this.acknowledgedHighValue.set(false);
    this.acknowledgedSimulationFailure.set(false);
    this.acknowledgedQuoteRisk.set(false);
    this.fetchQuote(true);
  }

  /** Mirrors SwapExecutionService.validateQuoteAge so we can bail gracefully. */
  private isQuoteTooOld(q: SwapQuote): boolean {
    if (!q.createdAt) return false;
    return Date.now() - q.createdAt > this.QUOTE_TTL_SECONDS * 1000;
  }

  // Horizontal UI helpers
  activePercent = signal<number | null>(null);
  spinRefresh = signal(false);

  /** Which info-strip cell currently has its detail panel open, if any. */
  expandedInfoCell = signal<string | null>(null);

  toggleInfoCell(id: string): void {
    this.expandedInfoCell.update((current) => (current === id ? null : id));
  }

  // Computed values
  // The receive side is intentionally display-only: the get-panel renders a
  // read-only div (no input), so there is no exact-output ('to'-driven)
  // quote mode and the amount always comes from the quote.
  toAmount = computed(() => this.quote()?.toAmount || '');

  /**
   * What the receive panel actually renders. `toAmount()` stays the raw
   * full-precision formatUnits string for calculations (minimumReceived,
   * history, execution); the display gets the same significant-digit
   * rounding the review step uses so an 18-decimal amount can't overflow
   * the card.
   */
  toAmountDisplay = computed(() => {
    const raw = this.toAmount();
    if (!raw) return raw;
    return this.formatTokenAmount(raw);
  });

  /**
   * The quote on screen was fetched for the amount currently in the input.
   * During the 500 ms quote debounce the PREVIOUS quote is still displayed —
   * without this gate 'Review swap' stayed clickable and the user could
   * execute the old amount's quote (typed '5', swapped the quote for '1').
   * The CTA treats a mismatch as 'Getting quote…' from the first keystroke;
   * comparison is numeric so trailing zeros never read as a mismatch.
   *
   * Token identity must match too — amounts alone collide across a flip
   * ('1 ETH→USDC' vs '1 USDC→ETH'), so a late old-direction response that
   * slips past the seq gate must never enable Review for the wrong pair.
   */
  readonly quoteMatchesInput = computed<boolean>(() => {
    const q = this.quote();
    if (!q) return false;
    if (
      !this.isSameToken(this.fromToken(), q.fromToken) ||
      !this.isSameToken(this.toToken(), q.toToken)
    ) {
      return false;
    }
    return amountsNumericallyEqual(this.fromAmount, q.fromAmount);
  });

  /** Address+chainId token identity (addresses compared case-insensitively). */
  private isSameToken(a: Token | null, b: Token | null): boolean {
    return (
      !!a && !!b &&
      a.chainId === b.chainId &&
      a.address.toLowerCase() === b.address.toLowerCase()
    );
  }

  fromAmountUSD = computed(() => {
    const q = this.quote();
    return q ? this.formatUsd(q.fromAmountUSD) : '';
  });

  /**
   * USD price of one from-token, or null when unknown. Prefers the live
   * quote's implied price (reflects the actual route) and falls back to the
   * token-list `priceUSD`. Null hides the $/token toggle and disables USD
   * conversion — we never guess a price.
   */
  readonly fromUsdPrice = computed<number | null>(() => {
    const from = this.fromToken();
    if (!from) return null;
    const q = this.quote();
    if (q && this.isSameToken(from, q.fromToken)) {
      const fa = parseFloat(q.fromAmount);
      const fu = parseFloat(q.fromAmountUSD);
      if (Number.isFinite(fa) && fa > 0 && Number.isFinite(fu) && fu > 0) {
        // A denormal-tiny fa can overflow the ratio to Infinity — guard so a
        // degenerate quote never yields a non-finite "price".
        const price = fu / fa;
        if (Number.isFinite(price) && price > 0) return price;
      }
    }
    const p = parseFloat(from.priceUSD ?? '');
    return Number.isFinite(p) && p > 0 ? p : null;
  });

  /**
   * Dollar string for a token amount at a price, for the "$" field. Empty when
   * the product isn't a finite positive number — a pathological huge pasted
   * token amount (the field has no maxLength) would otherwise stringify to
   * "Infinity"/"NaN" in the input.
   */
  private tokenAmountToUsdInput(tokenAmount: number, price: number): string {
    const usd = tokenAmount * price;
    return Number.isFinite(usd) && usd > 0 ? usd.toFixed(2) : '';
  }

  /** The $/token toggle is offered only once a from-token + price are known. */
  readonly canToggleInputMode = computed<boolean>(
    () => !!this.fromToken() && this.fromUsdPrice() !== null,
  );

  /** What the pay field renders: the typed dollars in USD mode, else the token amount. */
  get payInputValue(): string {
    return this.inputMode() === 'usd' ? this.usdInput() : this.fromAmount;
  }

  /**
   * Sub-line under the pay field. In USD mode it shows the locked token
   * equivalent (the amount the quote is actually for); in token mode it keeps
   * the existing USD value from the quote.
   */
  readonly paySubLine = computed<string>(() => {
    if (this.inputMode() === 'usd') {
      const from = this.fromToken();
      const amt = this.fromAmount;
      const n = parseFloat(amt);
      if (from && Number.isFinite(n) && n > 0) {
        return `≈ ${this.formatTokenAmount(amt)} ${from.symbol}`;
      }
      return from ? `0 ${from.symbol}` : '';
    }
    return this.fromAmountUSD();
  });

  toAmountUSD = computed(() => {
    const q = this.quote();
    return q ? this.formatUsd(q.toAmountUSD) : '';
  });

  /**
   * "$1,234.56" for positive values, "—" otherwise. A literal "$0.00" under a
   * live amount reads as "this trade is worthless" — when we genuinely don't
   * know the USD value, say so instead of asserting zero.
   */
  formatUsd(value: string): string {
    const n = parseFloat(value);
    if (!Number.isFinite(n) || n <= 0) return '—';
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }


  providerLabel = computed<string | null>(() => {
    const q = this.quote();
    const tool = q?.route?.[0]?.protocol;
    return tool ? `via ${tool}` : null;
  });

  /**
   * Whether `quote().minimumReceived` is a floor the aggregator's calldata
   * actually enforces on-chain, or a client-side toAmount×(1−slippage)
   * estimate (ODOS sends no enforced floor by design). Drives the honesty
   * of the minimum-received copy — an estimate must never claim the
   * "swap cancels itself" guarantee. Mirrors the selection the quote
   * service performed by calling the same pure helper.
   */
  readonly minimumReceivedIsEnforced = computed<boolean>(() => {
    const q = this.quote();
    if (!q) return false;
    if (q._aggregatorData) {
      return selectMinimumReceived(
        q._aggregatorData.to_amount_min,
        q.toAmount,
        q.slippage,
        q.toToken.decimals,
      ).source === 'enforced';
    }
    // LI.FI SDK fallback path: estimate.toAmountMin is the server-computed
    // floor the calldata enforces; absent → hand-computed estimate.
    return Boolean(q._lifiRoute?.estimate?.toAmountMin);
  });

  /**
   * The contract the wallet will be asked to call, plus the aggregator that
   * produced it — the only human-verifiable surface before a tx is signed
   * (Privy embedded wallets auto-sign with no wallet UI of their own), so
   * the review step shows it as a muted, explorer-linked trust line.
   */
  readonly swapContractInfo = computed<{
    label: string;
    shortAddress: string;
    explorerUrl: string;
  } | null>(() => {
    const q = this.quote();
    if (!q) return null;
    const to = q._aggregatorData?.tx_request?.to || q._lifiRoute?.transactionRequest?.to;
    if (!to) return null;
    // Label names who routed the trade. The legacy SDK path's route[0] holds
    // the DEX tool (e.g. Uniswap), but the contract called is LI.FI's — name
    // LI.FI, not the tool, so the line matches what the explorer will show.
    const label = q.aggregator
      ? this.aggregatorDisplayName(q.aggregator)
      : q._lifiRoute ? 'LI.FI' : null;
    if (!label) return null;
    return {
      label,
      shortAddress: `${to.slice(0, 6)}…${to.slice(-4)}`,
      explorerUrl: getExplorerAddressUrl(q.fromToken.chainId, to),
    };
  });

  private aggregatorDisplayName(agg: AggregatorName): string {
    const names: Record<AggregatorName, string> = {
      zerox: '0x',
      paraswap: 'ParaSwap',
      odos: 'ODOS',
      lifi: 'LI.FI',
      squid: 'Squid',
    };
    return names[agg] ?? agg;
  }

  /**
   * 5-cell info strip shown under the main swap card.
   * Each cell is derived from the current quote; returns `[]` when we
   * don't have a quote yet so the strip collapses.
   */
  infoCells = computed<InfoCell[]>(() => {
    const q = this.quote();
    if (!q) return [];

    // '' / unparseable is the quote service's "couldn't estimate" sentinel
    // (RPC failure) — render "—", never "$0.00": an estimation failure must
    // not read as a free swap. A non-positive value is treated the same (gas
    // is never genuinely zero); a real sub-cent fee (gasCost > 0) is known and
    // gasCostDisplay renders it as "<$0.01" rather than rounding to "$0.00".
    const gasCost = parseFloat(q.gasCostUSD);
    const gasKnown = Number.isFinite(gasCost) && gasCost > 0;
    const gasLabel = this.getGasLabel();
    const gasTone = gasLabel === 'Cheap'
      ? 'success'
      : gasLabel === 'Very High' ? 'danger'
        : gasLabel === 'High' ? 'warning' : 'muted';

    // Slippage is read from the quote (frozen at fetch time), not from
    // settings (live). The aggregator's calldata is encoded with q.slippage,
    // so showing live settings here would lie about the floor that's
    // actually enforced on-chain.
    const quoteSlippage = q.slippage;
    const minReceived = parseFloat(q.minimumReceived);
    // Impact is computed from the quote's USD legs; when either leg is
    // unpriced it is unknown and the cell shows "—" instead of a fake
    // "0.00%". Reading quoteRiskImpact() keeps the strip and the review
    // risk gate in lockstep by construction (known zero renders 0.00%).
    const impact = this.quoteRiskImpact();
    const hasImpact = impact !== null;
    const impactTone = !hasImpact ? 'muted' : impact < 0.5 ? 'success' : impact < 3 ? 'muted' : 'warning';
    const impactSub = !hasImpact ? 'Not available' : impact < 0.5 ? 'Very low' : impact < 3 ? 'Moderate' : 'High';
    const impactValue = hasImpact ? `${impact.toFixed(2)}%` : '—';

    const isCross = this.isCrossChain();
    const timingValue = this.formatTimingEstimate(q.estimatedTime, isCross);
    const timingSub = `On ${this.getNetworkName(q.fromToken.chainId)}`;

    return [
      {
        // Phones hide the centre column (the rate's desktop home) — the
        // strip carries it there instead, including the freshness hint
        // that desktop shows under the centre column.
        label: 'Rate',
        value: q.exchangeRate,
        sub: `Updates in ${this.quoteCountdown()}s`,
        subTone: 'muted',
        mobileOnly: true,
      },
      {
        label: 'Network fee',
        value: gasKnown ? this.gasCostDisplay(q.gasCostUSD) : '—',
        sub: gasKnown ? gasLabel : 'Estimate unavailable',
        subTone: gasKnown ? gasTone : 'muted',
        tooltip: true,
        // Gas is paid in the source chain's NATIVE token, never in the
        // ERC-20 being swapped — naming fromToken here was factually wrong.
        tooltipText: gasKnown
          ? `What the ${this.getNetworkName(q.fromToken.chainId)} network charges to process this transaction. Paid in ${this.nativeSymbolFor(q.fromToken.chainId)}, not a platform fee.`
          : `We couldn't estimate the network fee right now (the network's RPC didn't answer). The fee is still charged in ${this.nativeSymbolFor(q.fromToken.chainId)} when you swap.`,
      },
      {
        label: 'Minimum received',
        value: `${minReceived.toFixed(4)} ${q.toToken.symbol}`,
        sub: `${quoteSlippage}% slippage`,
        subTone: 'muted',
        tooltip: true,
        // Two variants: the absolute "it cancels" guarantee is only honest
        // when the aggregator reported the floor its calldata enforces —
        // for the client-side estimate (ODOS) the copy stays a guide.
        tooltipText: this.minimumReceivedIsEnforced()
          ? `Your floor: if the price moves more than ${quoteSlippage}% before the swap is mined, it cancels instead of giving you less than this.`
          : `Estimated from your ${quoteSlippage}% slippage setting. This route doesn't report an enforced on-chain floor, so treat it as a guide, not a guarantee.`,
      },
      {
        label: 'Price impact',
        value: impactValue,
        sub: impactSub,
        subTone: impactTone,
        tooltip: true,
        tooltipText: 'How much your trade itself moves the market price. Large trades in small pools push the price against you.',
      },
      {
        label: 'Timing',
        value: timingValue,
        sub: timingSub,
        subTone: 'muted',
      },
      this.buildSafetyCell(),
    ];
  });

  /**
   * Same shape as `infoCells()` with unknown placeholders — rendered while
   * the FIRST quote for a pair is in flight so the strip's height is
   * reserved up front and the CTA doesn't jump down when the quote lands.
   * Subs are non-breaking spaces purely to hold the third text line.
   */
  readonly infoCellsPlaceholder: InfoCell[] = [
    { label: 'Rate', value: '—', sub: ' ', subTone: 'muted', mobileOnly: true },
    { label: 'Network fee', value: '—', sub: ' ', subTone: 'muted' },
    { label: 'Minimum received', value: '—', sub: ' ', subTone: 'muted' },
    { label: 'Price impact', value: '—', sub: ' ', subTone: 'muted' },
    { label: 'Timing', value: '—', sub: ' ', subTone: 'muted' },
    { label: 'Safety', value: 'Checking…', sub: 'Security check', subTone: 'muted' },
  ];

  /**
   * "$X.XX" (optionally "~"-prefixed) for a parseable gas estimate, "<$0.01"
   * for a real sub-cent fee (L2 gas is routinely fractions of a cent — the
   * old `.toFixed(2)` rounded those to "$0.00" and the swap read as FREE), and
   * "—" for the quote service's ''/unparseable unknown sentinel ("$0.00" must
   * never stand in for "we couldn't estimate" — an RPC failure isn't free).
   */
  gasCostDisplay(value: string, approx: boolean = true): string {
    return formatUsdFee(value, approx);
  }

  /** Template guard for the "paid in X" sub-lines next to the fee. */
  isGasEstimateKnown(value: string): boolean {
    return Number.isFinite(parseFloat(value));
  }

  /** Persistent 3-step indicator shown on every screen. */
  readonly stepperSteps: readonly StepperItem[] = [
    { id: 'setup', label: 'Set up your swap' },
    { id: 'review', label: 'Review' },
    { id: 'confirm', label: 'Confirm & send' },
  ];

  /**
   * Which step is visually active. `completed` status bumps the index past
   * the end so all three dots render as "done" on the success screen.
   */
  stepperActiveIndex = computed(() => {
    const step = this.currentStep();
    if (step === 'swap') return 0;
    if (step === 'review') return 1;
    return this.transactionStatus() === 'completed' ? 3 : 2;
  });

  /**
   * Steps to render in the "What's happening" timeline. Prefer the live
   * tracking state from LI.FI (cross-chain has 4 real steps); fall back to a
   * minimal Sign → Confirm pair while the tracker hasn't populated yet.
   */
  timelineSteps = computed(() => {
    const state = this.trackingState();
    if (state?.steps && state.steps.length > 0) {
      return state.steps;
    }
    const q = this.quote();
    const chainLabel = q ? this.getNetworkName(q.fromToken.chainId) : 'network';
    return [
      { id: 'signing', title: 'Sign in your wallet', description: 'Waiting for confirmation', status: 'in_progress' as const },
      { id: 'confirming', title: `Confirming on ${chainLabel}`, description: 'Broadcast to the network', status: 'pending' as const },
    ];
  });

  /**
   * Render the quote's `estimatedTime` (seconds) as a human label for the
   * info-strip Timing cell. Falls back to a coarse constant when the
   * aggregator didn't return a value, so the cell never shows "0s". The
   * cross-chain fallback is the same '5–30 min' range every other surface
   * promises — a tighter number here contradicted the confirm modal.
   */
  private formatTimingEstimate(seconds: number | undefined, isCrossChain: boolean): string {
    if (!seconds || seconds <= 0) {
      return isCrossChain ? '5–30 min' : '~15 seconds';
    }
    if (seconds < 60) return `~${seconds} seconds`;
    const minutes = Math.round(seconds / 60);
    return `~${minutes} min`;
  }

  formatElapsed(seconds: number): string {
    if (!seconds || seconds < 0) return '0s';
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }

  stepBackground(status: 'pending' | 'in_progress' | 'completed' | 'failed'): string {
    switch (status) {
      case 'completed': return 'var(--orion-success)';
      case 'failed': return 'var(--orion-danger)';
      case 'in_progress': return 'var(--orion-accent-tint)';
      default: return 'var(--orion-surface-3)';
    }
  }

  stepTitleColor(status: 'pending' | 'in_progress' | 'completed' | 'failed'): string {
    return status === 'pending' ? 'var(--orion-subtle)' : 'var(--orion-text)';
  }

  stepDescriptionColor(status: 'pending' | 'in_progress' | 'completed' | 'failed'): string {
    if (status === 'in_progress') return 'var(--orion-accent-text)';
    if (status === 'pending') return 'var(--orion-subtle)';
    return 'var(--orion-muted)';
  }

  /**
   * Maps GoPlus risk level to an info-strip cell.
   * "safe" / null-trusted → Verified. Anything else is surfaced so the user
   * sees elevated risk on the destination (buy-side) token. Cell is
   * clickable — tap expands the full transaction-health detail panel
   * below the strip.
   */
  private buildSafetyCell(): InfoCell {
    const expanded = this.expandedInfoCell() === 'safety';
    const level = this.safetyLevel();
    const base = { id: 'safety', label: 'Safety', clickable: true, expanded };
    // 3-tier visual language (API keeps 5 levels; high/critical still gate
    // the CTA): safe/low aren't a distinction the user can act on, and two
    // near-identical greens read as noise.
    switch (level) {
      case 'safe':
      case 'low':
        return { ...base, value: 'Looks safe', sub: 'No major flags', subTone: 'success' };
      case 'medium':
        return { ...base, value: 'Caution', sub: 'Review details', subTone: 'warning' };
      case 'high':
        return { ...base, value: 'High risk', sub: 'Read before trading', subTone: 'danger' };
      case 'critical':
        return { ...base, value: 'Critical risk', sub: 'Do not swap', subTone: 'danger' };
      case 'unknown':
        return { ...base, value: 'Not verified', sub: "Couldn't check token", subTone: 'warning' };
      default:
        return { ...base, value: 'Checking…', sub: 'Security check', subTone: 'muted' };
    }
  }

  private quoteDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Monotonic counter incremented on every `fetchQuote` invocation. The
   * fetch ignores its result if a newer request started while it was in
   * flight — without this, a slow USDC→ETH response can land *after* a fast
   * USDT→ETH response and the user reviews the wrong pair.
   */
  private quoteFetchSeq = 0;

  /**
   * Disown any in-flight quote fetch. Clearing `quote` alone is not enough:
   * a response still in flight passes the seq gate when it lands (nothing
   * bumped the counter), resurrecting a quote the user just navigated away
   * from — flip, cleared input, reset. The disowned fetch's finally block
   * no longer owns the seq, so the loading flag is released here instead.
   */
  private invalidatePendingQuote(): void {
    this.quoteFetchSeq++;
    this.isLoading.set(false);
  }

  /** Same idea for safety-check responses — a slow GoPlus reply for an old
   *  toToken must not overwrite the current token's verdict. */
  private safetyCheckSeq = 0;

  /** Sequence guard for the eth_call simulation — same race as fetchQuote. */
  private simulationSeq = 0;

  /**
   * Sequence guard for `fetchInitialRate` — bumped whenever the pair
   * direction changes (token switch, flip) so a 1-unit test quote still in
   * flight for the OLD direction can never write its rate over the new one.
   */
  private rateDirectionSeq = 0;

  /** Reset the displayed rate because the pair (or its direction) changed. */
  private resetExchangeRate(): void {
    this.lastExchangeRate.set(0);
    this.rateDirectionSeq++;
  }

  constructor() {
    // Tokens are not pre-selected - user must choose them
    // This provides a cleaner UX and avoids confusion

    // The AI assistant may arm a swap to pre-fill (SwapIntentService). An effect
    // (not a one-shot) so it fires whether /swap is freshly opened or already on
    // screen. It only fills the swap step + fetches a quote — never executes;
    // the user still reviews every gate and signs.
    effect(() => {
      const intent = this.swapIntent.pending();
      if (!intent) return;
      this.swapIntent.clear();
      this.fromToken.set(intent.fromToken);
      this.toToken.set(intent.toToken);
      this.fromAmount = intent.amount;
      this.currentStep.set('swap');
      void this.fetchQuote(true);
    }, { allowSignalWrites: true });

    effect(() => {
      const connected = this.walletService.isConnected();
      // Track address too — Privy flips isConnected before address() is populated,
      // so without this dep the first balance fetch sees null and caches 0 for 10s.
      const addr = this.walletService.address();
      const from = this.fromToken();
      const to = this.toToken();

      if (connected && addr && from) {
        this.updateFromBalance();
      }
      if (connected && addr && to) {
        this.updateToBalance();
      }
    }, { allowSignalWrites: true });

    effect(() => {
      const to = this.toToken();
      // Each new toToken resets both the cached risk and any prior
      // acknowledgement — a user who acknowledged risk on one scam token
      // mustn't carry that ack onto the next one they pick. Same logic
      // applies to the cross-chain ack: the warning is about *this pair*,
      // so a different destination token = new pair = re-ack.
      this.acknowledgedHighRisk.set(false);
      this.crossChainConfirmed.set(false);
      if (!to) {
        this.safetyLevel.set(null);
        this.hardBlockToken.set(false);
        return;
      }
      const seq = ++this.safetyCheckSeq;
      this.safetyLevel.set(null);
      this.hardBlockToken.set(false);
      this.tokenSecurity
        .checkTokenSecurity(to.chainId, to.address)
        .then((r) => {
          if (seq === this.safetyCheckSeq) {
            this.safetyLevel.set(r.riskLevel);
            this.hardBlockToken.set(r.hardBlock);
          }
        })
        .catch(() => {
          if (seq === this.safetyCheckSeq) {
            // Fail closed, not silent: a failed security check is an
            // 'unknown' verdict, which requires the explicit risk ack —
            // never the absence of a gate. (The service catches its own
            // errors, so this is belt-and-braces.)
            this.safetyLevel.set('unknown');
            this.hardBlockToken.set(false);
          }
        });
    }, { allowSignalWrites: true });

    // Drive the elapsed-time counter off transactionStatus transitions so the
    // pending/confirming screen can show a real "12s" instead of a static
    // "usually takes 10–20 seconds" copy.
    effect(() => {
      const status = this.transactionStatus();

      if (status === 'idle') {
        if (this.txElapsedTimer) {
          clearInterval(this.txElapsedTimer);
          this.txElapsedTimer = null;
        }
        this.txStartedAt.set(null);
        this.txElapsedSeconds.set(0);
        this.txCompletedInSeconds.set(null);
        return;
      }

      // Start the clock the moment the user sees the wallet prompt —
      // signing can take 10-30s on slow wallets and the user wants that in
      // the elapsed total, not a cold 0s that jumps once the tx broadcasts.
      if (status === 'signing' || status === 'pending' || status === 'confirming') {
        if (!this.txStartedAt()) {
          this.txStartedAt.set(Date.now());
          this.txElapsedSeconds.set(0);
        }
        if (!this.txElapsedTimer) {
          // 1s cadence — the display is whole seconds, so a faster tick only
          // doubled the change-detection churn without changing a pixel.
          this.txElapsedTimer = setInterval(() => {
            const start = this.txStartedAt();
            if (start) {
              this.txElapsedSeconds.set(Math.floor((Date.now() - start) / 1000));
            }
          }, 1000);
        }
        return;
      }

      if (status === 'completed' || status === 'failed') {
        if (this.txElapsedTimer) {
          clearInterval(this.txElapsedTimer);
          this.txElapsedTimer = null;
        }
        const start = this.txStartedAt();
        if (start && this.txCompletedInSeconds() === null) {
          this.txCompletedInSeconds.set(Math.floor((Date.now() - start) / 1000));
        }
      }
    }, { allowSignalWrites: true });

    // Run a pre-sign eth_call whenever the user reaches review with a fresh
    // quote. Re-runs if the quote object changes (silent re-quote, manual
    // refresh) so we always show the latest verdict next to the Confirm CTA.
    // The native-gas preflight rides the same trigger: both answer "will
    // this signature actually work?" before the user pays for finding out.
    effect(() => {
      const step = this.currentStep();
      const q = this.quote();
      if (step !== 'review' || !q) {
        this.simulationState.set({ status: 'idle' });
        this.acknowledgedSimulationFailure.set(false);
        this.nativeGasShortfall.set(null);
        return;
      }
      // This effect must key on (step, quote) ONLY. Both preflights read
      // other signals synchronously before their first await —
      // `currentGasPrice` in checkNativeGasFunds, wallet state inside the
      // balance fetch and the simulation service — and a tracked read there
      // turns every 30s gas tick (or balance refresh) into a full effect
      // re-run: the simulation re-churns to 'pending' and the user's
      // acknowledgements are wiped mid-review. `untracked` severs those
      // incidental dependencies.
      untracked(() => {
        this.runSimulation(q);
        this.checkNativeGasFunds(q);
      });
    }, { allowSignalWrites: true });

    // --- Active-swap hub mirror -------------------------------------------
    // Cross-chain tracking is owned by ActiveSwapHubService after broadcast
    // (it survives navigation); while this screen is bound to the hub's swap
    // (hubAttached), repaint the local status signals from hub state.
    // hubAttached is the screen-ownership guard: "Start new swap" / "Try
    // again" release the screen, so a swap the user walked away from can't
    // repaint a fresh swap's screen — the role trackingSession used to play
    // for the cross-chain path.
    effect(() => {
      const summary = this.activeSwapHub.activeSwap();
      const state = this.activeSwapHub.trackingState();
      if (!this.hubAttached() || !summary) return;
      untracked(() => this.paintFromHub(summary, state));
    }, { allowSignalWrites: true });

    // Restore-on-return: a hub-tracked cross-chain swap survives navigation
    // — re-entering /swap without a fresh quote flow (no armed intent)
    // lands back on the live status screen, so "Open swap" from the
    // floating pill arrives at a live view instead of a blank form.
    const hubSwap = this.activeSwapHub.activeSwap();
    if (hubSwap && !this.swapIntent.pending()) {
      this.restoreHubSwap(hubSwap);
    }

    this.startGasPriceUpdates();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  /** Screen status for a hub phase — untracked/timeout honestly stay 'confirming'. */
  private static statusForPhase(phase: ActiveSwapPhase): TransactionStatus {
    switch (phase) {
      case 'success':
        return 'completed';
      case 'failed':
      case 'partial':
        return 'failed';
      default:
        return 'confirming';
    }
  }

  /** One repaint of the local status-screen signals from hub state. */
  private paintFromHub(summary: ActiveSwapSummary, state: TransactionTrackingState | null): void {
    if (state) {
      this.trackingState.set(state);
    }
    // `undefined` = the hub doesn't know yet; `null` = explicitly none
    // (non-Squid untracked route) — only a known verdict repaints the link.
    if (summary.trackingUrl !== undefined) {
      this.untrackedBridgeTrackingUrl.set(summary.trackingUrl);
    }
    this.transactionStatus.set(SwapComponent.statusForPhase(summary.phase));
    if ((summary.phase === 'failed' || summary.phase === 'partial') && summary.errorMessage) {
      this.txError.set(summary.errorMessage);
    }
  }

  /**
   * Rebind a fresh component instance's status screen to the hub's active
   * swap (tracking already running). Restores the executing quote (the
   * summary/receipt cards read it), the tx identifiers and the elapsed
   * clock, then jumps straight to the status step — the mirror effect keeps
   * repainting from hub state afterwards.
   *
   * Only LIVE swaps restore: a settled one (success/failed/partial, or an
   * untracked/timed-out watch) must not hijack a fresh visit to /swap with
   * a stale outcome screen — the floating pill remains the surface for
   * settled outcomes until the user dismisses it.
   */
  private restoreHubSwap(summary: ActiveSwapSummary): void {
    if (isSwapSettled(summary.phase)) return;
    this.hubAttached.set(true);
    const q = this.activeSwapHub.activeQuote();
    if (q) {
      this.quote.set(q);
    }
    this.txHash.set(summary.txHash);
    this.explorerUrl.set(this.getExplorerUrl(summary.fromChainId, summary.txHash));
    // Elapsed continues from the real broadcast, not from re-entry (the
    // elapsed-time effect only seeds txStartedAt when it is null).
    this.txStartedAt.set(summary.startedAt);
    this.paintFromHub(summary, this.activeSwapHub.trackingState());
    this.currentStep.set('status');
  }

  private async runSimulation(q: SwapQuote): Promise<void> {
    const seq = ++this.simulationSeq;
    this.simulationState.set({ status: 'pending' });
    this.acknowledgedSimulationFailure.set(false);
    try {
      const res = await this.lifiService.simulateSwap(q);
      if (seq !== this.simulationSeq) return;
      if (res.ok) {
        // Pre-wired for the pending SimulationResult change: the execution
        // service currently collapses eth_call's "missing revert data"
        // outcome into a bare `{ ok: true }`, indistinguishable from a real
        // pass. Once it reports `{ ok: true, inconclusive: true }` instead,
        // this branch presents it honestly as "couldn't pre-check" rather
        // than a green "Simulation passed". Until then it never fires.
        const inconclusive = 'inconclusive' in res && res.inconclusive === true;
        this.simulationState.set(
          inconclusive ? { status: 'error', kind: 'inconclusive' } : { status: 'success' },
        );
      } else {
        // kind-mapped reasons (allowance/slippage/transfer) are already
        // friendly; an unknown revert carries the raw ethers dump —
        // presentError passes the former through and calms the latter.
        this.simulationState.set({
          status: 'revert',
          reason: presentError(res.reason, 'simulation').short,
          kind: res.kind,
        });
      }
    } catch (err: any) {
      if (seq !== this.simulationSeq) return;
      this.simulationState.set({ status: 'error', reason: err?.message || 'Simulation failed' });
    }
  }

  /**
   * Review-step preflight: does the wallet hold enough of the source
   * chain's NATIVE token to pay for gas (plus the swap amount itself when
   * the native token is being sold)? Without this, a USDC swap with zero
   * ETH dies at signing with a wallet error whose advice ("try a smaller
   * amount") can't possibly help. Best-effort: any gap in the data — no
   * gas estimate, balance fetch failure — fails open.
   */
  private async checkNativeGasFunds(q: SwapQuote): Promise<void> {
    const seq = ++this.gasFundsCheckSeq;
    this.nativeGasShortfall.set(null);

    const chainId = q.fromToken.chainId;
    // Only use the cached gwei when it was fetched for the QUOTE's chain —
    // right after a chain switch it can still belong to the previous chain,
    // and converting backend gas UNITS with another chain's gas price
    // silently mis-prices the preflight. On a mismatch
    // estimateNativeGasCost falls back to the USD estimate or fails open.
    const cachedGas = this.currentGasPrice();
    const gasNative = estimateNativeGasCost(
      q,
      cachedGas !== null && cachedGas.chainId === chainId ? cachedGas.gwei : null,
      this.nativeUsdPriceHint(q),
    );
    if (gasNative === null || gasNative <= 0) return;

    const isNativeSwap = this.lifiService.isNativeToken(q.fromToken);
    try {
      // STRICT read: `null` means "couldn't determine" (every RPC attempt
      // failed) — categorically different from getTokenBalance's silent
      // '0', which would hard-block Confirm for a user who merely hit
      // flaky RPCs. Unknown fails OPEN (no block, no banner); a genuine
      // '0' still blocks below — a wallet that truly holds nothing cannot
      // pay for gas.
      const balanceStr = await this.walletService.getNativeBalanceStrict(chainId);
      if (seq !== this.gasFundsCheckSeq) return;
      if (balanceStr === null) return;
      const balance = parseFloat(balanceStr);
      if (!Number.isFinite(balance)) return;
      const required = isNativeSwap ? parseFloat(q.fromAmount) + gasNative : gasNative;
      if (balance < required) {
        this.nativeGasShortfall.set({
          nativeSymbol: getNetworkById(chainId)?.nativeSymbol ?? 'ETH',
          requiredDisplay: this.formatTokenAmount(gasNative.toFixed(8)),
        });
      }
    } catch {
      // Balance fetch failed — infrastructure noise must never block Confirm.
    }
  }

  /**
   * Native-token USD price when one side of the pair IS the source chain's
   * native token (its quote-time priceUSD is exactly what we need). Used as
   * the last-resort divisor in `estimateNativeGasCost`.
   */
  private nativeUsdPriceHint(q: SwapQuote): number | null {
    for (const t of [q.fromToken, q.toToken]) {
      if (t.chainId === q.fromToken.chainId && this.lifiService.isNativeToken(t)) {
        const p = parseFloat(t.priceUSD ?? '');
        if (Number.isFinite(p) && p > 0) return p;
      }
    }
    return null;
  }

  /**
   * Start periodic gas price updates
   * Fetches current gas price every 30 seconds
   */
  private startGasPriceUpdates(): void {
    // Initial fetch
    this.updateGasPrice();

    // Update every 30 seconds. Hidden tabs skip the tick — users park DEX
    // tabs for hours and each fetch costs rate-limited public-RPC quota
    // (mirrors the transaction tracker's waitWhileHidden); the
    // visibilitychange handler refreshes once on return instead.
    this.gasUpdateInterval = setInterval(() => {
      if (document.hidden) return;
      this.updateGasPrice();
    }, 30000);
  }

  // Guard against overlapping gas requests: on slow RPCs the 30s tick fires
  // before the previous fetch returns, causing fan-out and a stale-last-write
  // hazard. One inflight at a time is enough for a read-only value.
  private gasUpdateInFlight = false;
  private gasUpdateInFlightSince = 0;
  /** If a gas fetch hasn't returned in this long, give up the lock so the next
   *  tick can try a different RPC instead of staying frozen forever. */
  private readonly GAS_UPDATE_TIMEOUT_MS = 25_000;

  /**
   * Fetch current gas price from the network. The inflight flag self-heals
   * after `GAS_UPDATE_TIMEOUT_MS` so a single hung RPC doesn't freeze the
   * gas display for the rest of the session.
   */
  private async updateGasPrice(): Promise<void> {
    if (this.gasUpdateInFlight) {
      const stuckFor = Date.now() - this.gasUpdateInFlightSince;
      if (stuckFor < this.GAS_UPDATE_TIMEOUT_MS) return;
      // Previous request appears wedged — log and reset so we can move on.
      console.warn('[Swap] Previous gas-price fetch hung for', stuckFor, 'ms; releasing lock.');
    }

    this.gasUpdateInFlight = true;
    this.gasUpdateInFlightSince = Date.now();
    try {
      const chainId = this.fromToken()?.chainId || 1;
      const gasPrice = await this.lifiService.getGasPrice(chainId);

      if (gasPrice) {
        // Tag the value with the chain it was fetched for — see the signal
        // declaration for why consumers must not assume it.
        this.currentGasPrice.set({ ...gasPrice, chainId });
      }
    } catch {
      // Silent failure — the strip will keep showing the last known value
      // and the next tick retries.
    } finally {
      this.gasUpdateInFlight = false;
    }
  }

  /**
   * Get gas level label for display
   */
  getGasPriceLabel(): string {
    const gas = this.currentGasPrice();
    if (!gas) return 'Loading…';

    switch (gas.level) {
      case 'cheap': return 'Cheap';
      case 'normal': return 'Normal';
      case 'high': return 'High';
      case 'very_high': return 'Very High';
      default: return 'Normal';
    }
  }

  /**
   * Get suggestion text based on gas level
   */
  getGasSuggestion(): string {
    const gas = this.currentGasPrice();
    if (!gas) return '';

    switch (gas.level) {
      case 'cheap': return 'Great time to swap!';
      case 'normal': return 'Normal gas prices';
      case 'high': return 'Consider waiting for lower gas';
      case 'very_high': return 'Gas is very expensive right now';
      default: return '';
    }
  }

  /**
   * Get CSS classes for gas level indicator
   */
  getGasLevelClasses(): { dot: string; text: string; bg: string } {
    const gas = this.currentGasPrice();
    if (!gas) return { dot: 'bg-slate-500', text: 'text-slate-400', bg: 'bg-slate-500/10' };

    switch (gas.level) {
      case 'cheap':
        return { dot: 'bg-emerald-500', text: 'text-emerald-400', bg: 'bg-emerald-500/10' };
      case 'normal':
        return { dot: 'bg-blue-500', text: 'text-blue-400', bg: 'bg-blue-500/10' };
      case 'high':
        return { dot: 'bg-amber-500', text: 'text-amber-400', bg: 'bg-amber-500/10' };
      case 'very_high':
        return { dot: 'bg-red-500', text: 'text-red-400', bg: 'bg-red-500/10' };
      default:
        return { dot: 'bg-slate-500', text: 'text-slate-400', bg: 'bg-slate-500/10' };
    }
  }

  // Balance cache. `exact` keeps the untouched formatUnits string alongside
  // the display float — MAX/percent math must run on the raw value.
  private balanceCache = new Map<string, { balance: number; exact: string; timestamp: number }>();
  private readonly BALANCE_CACHE_TTL = 10000;

  private getCacheKey(token: Token): string {
    return `${token.chainId}-${token.address}`;
  }

  private getCachedBalance(token: Token): { balance: number; exact: string } | null {
    const key = this.getCacheKey(token);
    const cached = this.balanceCache.get(key);
    if (cached && Date.now() - cached.timestamp < this.BALANCE_CACHE_TTL) {
      return { balance: cached.balance, exact: cached.exact };
    }
    return null;
  }

  private setCachedBalance(token: Token, balance: number, exact: string): void {
    const key = this.getCacheKey(token);
    this.balanceCache.set(key, { balance, exact, timestamp: Date.now() });
  }

  async updateFromBalance(): Promise<void> {
    const token = this.fromToken();
    if (!token) return;

    const cached = this.getCachedBalance(token);
    if (cached !== null) {
      this.fromBalance.set(cached.balance);
      this.fromBalanceExact.set(cached.exact);
      return;
    }

    try {
      const balance = await this.walletService.getTokenBalance(token.address, token.decimals, token.chainId);
      const parsedBalance = parseFloat(balance);
      // Cache under the FETCHED token's key regardless — the data is valid
      // for that token even if the selection moved on while we waited.
      this.setCachedBalance(token, parsedBalance, balance);
      // The from-token may have changed mid-fetch (flip, token switch) — a
      // stale write here hands MAX the OLD token's balance (money-path).
      if (!this.isSameToken(this.fromToken(), token)) return;
      this.fromBalance.set(parsedBalance);
      this.fromBalanceExact.set(balance);
    } catch (error) {
      console.error('Error updating from balance:', error);
    }
  }

  async updateToBalance(): Promise<void> {
    const token = this.toToken();
    if (!token) return;

    const cached = this.getCachedBalance(token);
    if (cached !== null) {
      this.toBalance.set(cached.balance);
      return;
    }

    try {
      const balance = await this.walletService.getTokenBalance(token.address, token.decimals, token.chainId);
      const parsedBalance = parseFloat(balance);
      this.setCachedBalance(token, parsedBalance, balance);
      // Same stale-write guard as updateFromBalance.
      if (!this.isSameToken(this.toToken(), token)) return;
      this.toBalance.set(parsedBalance);
    } catch (error) {
      console.error('Error updating to balance:', error);
    }
  }

  async forceRefreshBalances(): Promise<void> {
    const fromToken = this.fromToken();
    const toToken = this.toToken();

    if (fromToken) this.balanceCache.delete(this.getCacheKey(fromToken));
    if (toToken) this.balanceCache.delete(this.getCacheKey(toToken));

    await this.updateFromBalance();
    await new Promise(resolve => setTimeout(resolve, 500));
    await this.updateToBalance();
  }

  /** The ambiguous-paste warning fires once per session — not on every paste. */
  private warnedAmbiguousAmountPaste = false;

  /**
   * Slippage was confirmed in the settings panel. The frozen-quote pattern
   * encodes slippage into calldata at fetch time, and the pre-execution
   * silent re-quote reuses `quote().slippage` — so the on-screen quote must
   * be refetched NOW, not on the next 30s auto-refresh tick.
   */
  onSlippageCommitted(): void {
    if (this.fromToken() && this.toToken() && parseFloat(this.fromAmount) > 0) {
      this.fetchQuote(true);
    }
  }

  onFromAmountChange(value: string): void {
    // A strictly grouped, dot-free paste is genuinely ambiguous ('1,500' is
    // 1500 in US grouping, 1.5 in EU decimals) — refuse it instead of
    // guessing: keep the previous value and tell the user how to
    // disambiguate. Typed input can never form this shape (the sanitizer's
    // write-back converts a comma to a dot on the very next keystroke).
    if (isAmbiguousGroupedAmount(value)) {
      if (!this.warnedAmbiguousAmountPaste) {
        this.warnedAmbiguousAmountPaste = true;
        this.toastService.warning(
          'Ambiguous amount',
          'Use a dot as the decimal separator.',
        );
      }
      return;
    }

    // Normalize (',' → '.') and filter to numbers plus a single decimal dot.
    const filtered = sanitizeAmountInput(value);
    this.fromAmount = filtered;
    this.lastAmountEditAt = Date.now();
    this.error.set(null);
    this.activePercent.set(null);

    // Treat lone "." (and any other non-numeric residue) as empty so we don't
    // ship NaN into fetchQuote / parseUnits and waste an API round-trip on
    // an obviously invalid amount.
    const numeric = parseFloat(filtered);
    if (!filtered || !Number.isFinite(numeric) || numeric <= 0) {
      // Disown any fetch still in flight for the previous amount — its late
      // response would otherwise repaint the quote we just cleared.
      this.invalidatePendingQuote();
      this.quote.set(null);
      this.stopQuoteAutoRefresh();
      return;
    }

    if (this.quoteDebounceTimer) clearTimeout(this.quoteDebounceTimer);
    this.quoteDebounceTimer = setTimeout(() => {
      this.fetchQuote();
    }, 500);
  }

  /** Pay-field input — dispatches to the token or USD path by current mode. */
  onPayAmountChange(value: string): void {
    if (this.inputMode() === 'usd') {
      this.onUsdAmountChange(value);
    } else {
      this.onFromAmountChange(value);
    }
  }

  /**
   * USD-mode pay input. The typed dollars are converted to a token amount at
   * the current price and stored in `fromAmount` (the quote driver) — once
   * locked the token amount never drifts with later price ticks, so the
   * quote we fetch matches what the user saw. The raw dollars live in
   * `usdInput` for display. Mirrors `onFromAmountChange`'s validation/debounce.
   */
  private onUsdAmountChange(value: string): void {
    if (isAmbiguousGroupedAmount(value)) {
      if (!this.warnedAmbiguousAmountPaste) {
        this.warnedAmbiguousAmountPaste = true;
        this.toastService.warning('Ambiguous amount', 'Use a dot as the decimal separator.');
      }
      return;
    }

    const filtered = sanitizeAmountInput(value);
    this.usdInput.set(filtered);
    this.lastAmountEditAt = Date.now();
    this.error.set(null);
    this.activePercent.set(null);

    const price = this.fromUsdPrice();
    const usdNum = parseFloat(filtered);
    if (!price || !filtered || !Number.isFinite(usdNum) || usdNum <= 0) {
      this.fromAmount = '';
      this.invalidatePendingQuote();
      this.quote.set(null);
      this.stopQuoteAutoRefresh();
      return;
    }

    this.fromAmount = this.usdToTokenAmount(usdNum, price);

    if (this.quoteDebounceTimer) clearTimeout(this.quoteDebounceTimer);
    this.quoteDebounceTimer = setTimeout(() => {
      this.fetchQuote();
    }, 500);
  }

  /** Dollars → token-amount string, clamped to the token's precision so the
   *  downstream parseUnits never overflows. Truncated, never rounded up. */
  private usdToTokenAmount(usd: number, price: number): string {
    const from = this.fromToken();
    const precision = from ? Math.min(8, from.decimals) : 8;
    return truncateDecimals((usd / price).toFixed(precision + 2), precision);
  }

  /**
   * Flip the pay field between token and USD entry. Pure UI: the locked
   * `fromAmount` (token) is unchanged, so the quote is never refetched —
   * token→USD just seeds the dollar field from the current token amount, and
   * USD→token surfaces the already-converted token amount. No-op without a
   * price (the toggle is hidden then anyway).
   */
  toggleInputMode(): void {
    const price = this.fromUsdPrice();
    if (!this.fromToken() || price === null) return;
    if (this.inputMode() === 'token') {
      this.usdInput.set(this.tokenAmountToUsdInput(parseFloat(this.fromAmount), price));
      this.inputMode.set('usd');
    } else {
      this.inputMode.set('token');
    }
  }

  /**
   * Re-derive `fromAmount` from the typed dollars at the current price — used
   * when the from-token changes in USD mode so "$100" stays $100 of the NEW
   * token instead of carrying the old token's quantity across.
   */
  private recomputeFromAmountFromUsd(): void {
    const price = this.fromUsdPrice();
    const usdNum = parseFloat(this.usdInput());
    this.fromAmount =
      price && Number.isFinite(usdNum) && usdNum > 0
        ? this.usdToTokenAmount(usdNum, price)
        : '';
  }

  /**
   * Block non-numeric keyboard input for amount fields
   */
  onAmountKeydown(event: KeyboardEvent): void {
    // Allow: backspace, delete, tab, escape, enter
    if (['Backspace', 'Delete', 'Tab', 'Escape', 'Enter'].includes(event.key)) {
      return;
    }
    // Allow: Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+X
    if (event.ctrlKey || event.metaKey) {
      if (['a', 'c', 'v', 'x'].includes(event.key.toLowerCase())) {
        return;
      }
    }
    // Allow: home, end, left, right arrows
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return;
    }
    // Allow: decimal separator — dot or comma (at most one per value).
    // The comma keystroke is let through on purpose: the input handler's
    // sanitizer normalizes it to '.' immediately, so blocking it here only
    // punished locales whose keyboards type ',' for decimals.
    if (event.key === '.' || event.key === ',') {
      const input = event.target as HTMLInputElement;
      if (input.value.includes('.') || input.value.includes(',')) {
        event.preventDefault();
      }
      return;
    }
    // Block if not a number
    if (!/^[0-9]$/.test(event.key)) {
      event.preventDefault();
    }
  }

  async fetchQuote(skipCache: boolean = false): Promise<void> {
    const from = this.fromToken();
    const to = this.toToken();

    if (!from || !to || !this.fromAmount || parseFloat(this.fromAmount) === 0) {
      return;
    }

    if (!this.walletService.isConnected()) {
      return;
    }

    // Don't fetch quotes during swap execution - reduces unnecessary API calls
    if (this.currentStep() === 'status') {
      return;
    }

    const seq = ++this.quoteFetchSeq;
    this.isLoading.set(true);
    this.error.set(null);
    this.needsApproval.set(false);

    try {
      const quote = await this.lifiService.getSwapQuote(from, to, this.fromAmount, this.slippage, skipCache);

      // A newer fetch was kicked off (e.g. user changed token mid-flight) —
      // dropping the stale result avoids overwriting the newer quote.
      if (seq !== this.quoteFetchSeq) return;

      // getSwapQuote can RESOLVE null without throwing. Leaving quote=null
      // with no error parked the CTA in its stale/loading branch forever
      // ('Getting quote…' with no work happening) — surface the same
      // retryable error state as a thrown failure so the error-CTA takes
      // over, including the review bounce the catch block performs.
      if (!quote) {
        this.quote.set(null);
        this.error.set('Failed to get quote');
        this.stopQuoteAutoRefresh();
        if (this.currentStep() === 'review') {
          this.currentStep.set('swap');
          // Bounce transitions need the same focus hand-off as happy-path
          // ones — the review buttons are destroyed with the step.
          this.focusStepHeading();
          this.toastService.error('Quote refresh failed', 'Failed to get quote');
        }
        return;
      }

      // Funnel: count quote acquisitions, not refreshes. The 30s auto-refresh
      // and manual refresh replace a non-null quote, so only the null→non-null
      // transition (new pair / amount after a reset) emits the event.
      const isFirstQuoteShown = this.quote() === null;
      this.quote.set(quote);
      if (quote && isFirstQuoteShown) {
        this.analytics.track('swap_quote_received', this.swapAnalyticsProps(quote));
      }
      // A new quote replaces whatever numbers the price-move notice was
      // comparing — the warning would be stale (and wrong) if kept.
      this.requotePriceNotice.set(null);
      // Risk acknowledgements are per-quote: a fresh quote (auto-refresh,
      // token or amount change) must re-ask, never inherit a stale tick.
      // The high-value ack previously only reset on review entry / manual
      // refresh — resetting it here closes the new-quote gap too.
      this.acknowledgedQuoteRisk.set(false);
      this.acknowledgedHighValue.set(false);

      if (quote && parseFloat(quote.fromAmount) > 0) {
        const rate = parseFloat(quote.toAmount) / parseFloat(quote.fromAmount);
        this.lastExchangeRate.set(rate);
      }

      if (quote && !this.lifiService.isNativeToken(from)) {
        const approvalCheck = await this.lifiService.checkApproval(quote);
        if (seq === this.quoteFetchSeq) {
          this.needsApproval.set(approvalCheck.needsApproval);
        }
      }

      // Restart auto-refresh timer on successful quote
      if (quote && seq === this.quoteFetchSeq) {
        this.startQuoteAutoRefresh();
      }
    } catch (err: unknown) {
      // Same staleness guard for errors — don't clobber a successful newer
      // fetch with the failure message of an obsolete one.
      if (seq !== this.quoteFetchSeq) return;

      const errorCode = err instanceof Error ? err.message : '';

      if (errorCode === 'NO_LIQUIDITY') {
        this.error.set('No liquidity available for this pair');
      } else if (errorCode === 'AMOUNT_TOO_SMALL') {
        this.error.set('Amount too small for swap');
      } else {
        this.error.set(errorCode || 'Failed to get quote');
      }

      this.quote.set(null);
      this.stopQuoteAutoRefresh();

      // The review template only renders while a quote exists — nulling it
      // above would leave a failed "Refresh quote" on a blank page. Bounce
      // to the swap form (whose CTA renders `error()`) and say why.
      if (this.currentStep() === 'review') {
        this.currentStep.set('swap');
        this.focusStepHeading();
        this.toastService.error(
          'Quote refresh failed',
          presentError(this.error() ?? 'Failed to get quote', 'quote').short,
        );
      }
    } finally {
      if (seq === this.quoteFetchSeq) {
        this.isLoading.set(false);
      }
    }
  }

  async approveToken(): Promise<void> {
    const q = this.quote();
    if (!q) return;

    this.isApproving.set(true);

    try {
      const txHash = await this.lifiService.approveToken(q);
      const explorerUrl = this.getExplorerUrl(q.fromToken.chainId, txHash);
      this.toastService.success(
        'Approval confirmed',
        `${q.fromToken.symbol} has been approved for trading`,
        txHash ? { text: 'View transaction', url: explorerUrl } : undefined
      );
      this.needsApproval.set(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to approve token';
      // Declining the approval signature is a decision, not a failure —
      // nothing was broadcast. Mirror the swap path's neutral treatment
      // (same rejection detection) instead of a red "Approval failed".
      if (isUserRejectionError(message)) {
        this.toastService.info(
          'Approval cancelled',
          'No transaction was sent — you can approve again when ready.',
        );
      } else {
        // Boundary sanitization: raw provider/ethers dumps become calm copy
        // with a next step; already-friendly messages pass through.
        this.toastService.error('Approval failed', presentError(message, 'approve').short);
      }
    } finally {
      this.isApproving.set(false);
    }
  }

  refreshQuote(): void {
    // Skip cache to force fresh quote from API
    this.fetchQuote(true);
  }

  /**
   * Start auto-refreshing quote every 30 seconds.
   * Resets countdown on each call (e.g. after manual refresh or new quote).
   */
  private startQuoteAutoRefresh(): void {
    this.stopQuoteAutoRefresh();

    this.quoteCountdown.set(30);

    // Countdown ticker (every 1s) — also drives the review-step freshness
    // clock (`nowTick`), so the "Quote expires in Ns" chip stays live.
    this.quoteCountdownInterval = setInterval(() => {
      this.nowTick.set(Date.now());
      const current = this.quoteCountdown();
      if (current > 0) {
        this.quoteCountdown.set(current - 1);
      }
    }, 1000);

    // Actual refresh (every 30s)
    this.quoteRefreshInterval = setInterval(() => {
      // A hidden tab must not fan out /best-quote to every aggregator each
      // 30s — nobody is looking at the number it refreshes. The
      // visibilitychange handler does one immediate refresh on return.
      if (document.hidden) return;

      // Only refresh on the swap form screen, not during review or status.
      // Reset the countdown anyway: the swap-step freshness chip reads it,
      // and a return from review must not show a frozen "Updates in 0s".
      if (this.currentStep() !== 'swap' || !this.quote()) {
        this.quoteCountdown.set(30);
        return;
      }

      // Skip the tick only while the user is actively typing (the value
      // changed within the last couple of seconds) — overwriting `quote()`
      // mid-edit makes the receive-side number jump out from under the
      // user. Mere focus must NOT defer. Reset the countdown so the next
      // attempt happens 30s after the user stops, not 30s into
      // already-stale data.
      if (Date.now() - this.lastAmountEditAt < this.EDIT_DEFER_MS) {
        this.quoteCountdown.set(30);
        return;
      }

      this.quoteCountdown.set(30);
      this.fetchQuote(true);
    }, 30000);
  }

  private stopQuoteAutoRefresh(): void {
    if (this.quoteRefreshInterval) {
      clearInterval(this.quoteRefreshInterval);
      this.quoteRefreshInterval = null;
    }
    if (this.quoteCountdownInterval) {
      clearInterval(this.quoteCountdownInterval);
      this.quoteCountdownInterval = null;
    }
  }

  openTokenSelector(type: 'from' | 'to'): void {
    this.selectingFor.set(type);
    this.showTokenSelector.set(true);
  }

  onTokenSelected(token: Token): void {
    if (this.selectingFor() === 'from') {
      const prevFrom = this.fromToken();
      const currentTo = this.toToken();

      if (this.isSameToken(currentTo, token)) {
        // User picked the same token as toToken — swap them
        this.toToken.set(prevFrom);
      } else if (
        prevFrom && currentTo &&
        prevFrom.chainId === currentTo.chainId &&
        token.chainId !== currentTo.chainId
      ) {
        // Was same-chain swap, user switched fromToken to a different chain — reset toToken
        this.invalidatePendingQuote();
        this.toToken.set(null);
        this.quote.set(null);
        this.stopQuoteAutoRefresh();
      }
      this.fromToken.set(token);
    } else {
      if (this.isSameToken(this.fromToken(), token)) {
        this.fromToken.set(this.toToken());
      }
      this.toToken.set(token);
    }
    this.showTokenSelector.set(false);

    this.resetExchangeRate();

    // In USD mode, re-price the typed dollars against the (possibly new)
    // pay token so "$100" stays $100 of whatever is now on the pay side,
    // rather than carrying the previous token's quantity across. Idempotent
    // when the pay token didn't actually change. If the new pay token has no
    // price at all, USD entry is impossible — fall back to token entry so the
    // user isn't stranded in a "$" field that can't convert.
    if (this.inputMode() === 'usd') {
      if (this.fromUsdPrice() === null) {
        this.inputMode.set('token');
        this.usdInput.set('');
      } else {
        this.recomputeFromAmountFromUsd();
      }
    }

    // Only fetch rate/quote if both tokens are selected
    if (this.fromToken() && this.toToken()) {
      this.fetchInitialRate();

      if (this.fromAmount && parseFloat(this.fromAmount) > 0) {
        this.fetchQuote();
      }
    }
  }

  private async fetchInitialRate(): Promise<void> {
    const from = this.fromToken();
    const to = this.toToken();

    if (!from || !to) return;
    if (this.lastExchangeRate() > 0) return;

    const seq = this.rateDirectionSeq;
    try {
      const testAmount = '1';
      const quote = await this.lifiService.getSwapQuote(from, to, testAmount, this.slippage);

      // Re-check AFTER the await: while this 1-unit test quote was in
      // flight, a real quote may have set the rate (don't overwrite the
      // truth with an approximation) or the direction may have changed
      // (flip / token switch — this result belongs to the old pair).
      if (seq !== this.rateDirectionSeq) return;
      if (this.lastExchangeRate() > 0) return;

      if (quote) {
        const rate = parseFloat(quote.toAmount) / parseFloat(quote.fromAmount);
        this.lastExchangeRate.set(rate);
      }
    } catch {
      // Pre-flight rate is a UX nicety — the "Swap" click still works
      // without it, so we swallow the error rather than logging noise.
    }
  }

  swapTokens(): void {
    const from = this.fromToken();
    const to = this.toToken();
    this.fromToken.set(to);
    this.toToken.set(from);

    // Wipe the entire amount/quote state on flip. Keeping the previous
    // `fromAmount` would silently re-interpret it as an amount of the new
    // (formerly to) token — e.g. "0.5 ETH" suddenly becomes "0.5 USDC",
    // which is almost never what the user wanted. Clean slate forces a
    // deliberate re-entry. Disown any fetch still in flight FIRST — its
    // late OLD-direction response would otherwise pass the seq gate,
    // resurrect the pre-flip quote and repaint lastExchangeRate (after
    // which fetchInitialRate early-returns on rate>0 and the wrong rate
    // sticks).
    this.invalidatePendingQuote();
    this.quote.set(null);
    this.fromAmount = '';
    this.activePercent.set(null);
    this.error.set(null);
    this.stopQuoteAutoRefresh();
    // USD mode is pay-token-specific; the flip swaps in a new pay token, so
    // fall back to token entry and clear the dollar field (matches the
    // clean-slate intent above).
    this.inputMode.set('token');
    this.usdInput.set('');

    // The on-screen rate belongs to the OLD direction — without a reset the
    // card kept showing '1 USDC = 2500 ETH' after the flip. Reset and
    // re-prime for the new direction, exactly like onTokenSelected does.
    this.resetExchangeRate();
    if (from && to) {
      this.fetchInitialRate();
    }

    // The balance signals are bound to the previous token pair; the
    // wallet-watching effect will re-fetch them eventually but there's a
    // visible window where the new tokens render with the old balances.
    // Trigger refresh immediately so the swap card stays consistent.
    this.updateFromBalance();
    this.updateToBalance();
  }

  setPercentage(percent: number): void {
    const from = this.fromToken();
    if (!from || this.fromBalance() <= 0) return;

    // All math runs on the RAW balance in wei (bigint). The float balance
    // can't be trusted here: `(usable * percent / 100).toFixed(p)` rounds
    // half-up, so MAX on 1.999999995 produced '2.00000000' — more than the
    // wallet holds, i.e. a false 'Not enough X' or an execution revert.
    // truncateDecimals is a parseUnits safety net for a stale exact string
    // left by a previous token with more decimals.
    let raw: bigint;
    try {
      raw = parseUnits(truncateDecimals(this.fromBalanceExact(), from.decimals), from.decimals);
    } catch {
      raw = 0n;
    }
    if (raw <= 0n) return;

    // MAX on a native token has to leave something behind to pay the gas of
    // the same swap tx — sending value === balance lets the wallet reject
    // with "insufficient funds for gas" before broadcast (or, on permissive
    // RPCs, lets the on-chain tx revert). Reserve a chain-specific buffer.
    if (percent === 100 && this.lifiService.isNativeToken(from)) {
      const reserve = this.getNativeGasReserve(from.chainId);
      raw -= parseUnits(reserve.toString(), from.decimals);
      // If the buffer ate the whole balance, MAX produces 0 and the swap
      // CTA stays disabled with no explanation. Tell the user *why* — the
      // failure is "balance < gas reserve", not "amount is zero".
      if (raw <= 0n) {
        this.toastService.warning(
          'Balance too small for swap',
          `Need at least ${reserve} ${from.symbol} on ${this.getNetworkName(from.chainId)} to cover gas.`,
        );
        return;
      }
    }

    // Match precision to the token's decimals (capped at 8 to stay readable).
    // Hard-coding `.toFixed(6)` rounds dust amounts of 18-decimal tokens to
    // 0.000000 — the user sees "0" in the input and gets a "no quote" error.
    // Formatting TRUNCATES (never rounds) so the amount stays ≤ the balance.
    const precision = Math.min(8, from.decimals);
    const amount = percentOfRawBalance(raw, from.decimals, percent, precision);
    this.fromAmount = amount;
    // Always drive the quote off the token amount (onFromAmountChange is the
    // token path) — percentages are inherently token-relative.
    this.onFromAmountChange(amount);
    // Keep the visible dollar field in step when paying in USD.
    if (this.inputMode() === 'usd') {
      const price = this.fromUsdPrice();
      this.usdInput.set(price ? this.tokenAmountToUsdInput(parseFloat(amount), price) : '');
    }
    this.activePercent.set(percent);
  }

  /**
   * Native amount kept aside on MAX so the swap tx can pay its own gas.
   * Per-chain because L1 base fees and L2 native units differ by orders of
   * magnitude. Conservative — overshooting wastes a few cents of dust;
   * undershooting reverts the swap.
   */
  private getNativeGasReserve(chainId: number): number {
    switch (chainId) {
      case 1: return 0.005;        // Ethereum mainnet
      case 137: return 0.05;       // Polygon (MATIC trades much cheaper)
      case 42161: return 0.0005;   // Arbitrum
      case 8453: return 0.0005;    // Base
      case 10: return 0.0005;      // Optimism
      case 56: return 0.002;       // BNB Chain (~1-3 gwei, BNB-priced gas)
      case 43114: return 0.01;     // Avalanche (AVAX-priced, gwei-scale gas)
      default: return 0.005;
    }
  }

  refreshQuoteWithSpin(): void {
    this.spinRefresh.set(true);
    setTimeout(() => this.spinRefresh.set(false), 700);
    this.refreshQuote();
  }

  getHealthPercent(): number {
    const q = this.quote();
    if (!q) return 0;

    const impact = parseFloat(q.priceImpact);
    if (impact < 0.5) return 95;
    if (impact < 1) return 80;
    if (impact < 3) return 60;
    return 40;
  }

  getHealthLabel(): string {
    const percent = this.getHealthPercent();
    if (percent >= 90) return 'Excellent';
    if (percent >= 70) return 'Good';
    if (percent >= 50) return 'Fair';
    return 'Poor';
  }

  getGasLabel(): string {
    const q = this.quote();
    if (!q) return 'Normal';
    // Thresholds depend on the SOURCE chain — $5 of gas is cheap on mainnet
    // and an outrage on Base (see gasCostLabel).
    return gasCostLabel(parseFloat(q.gasCostUSD), q.fromToken.chainId);
  }

  getGasLabelClass(): string {
    const label = this.getGasLabel();
    switch (label) {
      case 'Cheap': return 'bg-emerald-500/20 text-emerald-400';
      case 'Medium': return 'bg-yellow-500/20 text-yellow-400';
      case 'High': return 'bg-orange-500/20 text-orange-400';
      case 'Very High': return 'bg-red-500/20 text-red-400';
      default: return 'bg-slate-500/20 text-slate-400';
    }
  }

  getStatusLabel(): string {
    switch (this.transactionStatus()) {
      case 'signing': return 'Awaiting signature';
      case 'pending': return 'Pending';
      case 'confirming': return 'Confirming';
      case 'completed': return 'Completed';
      case 'failed': return 'Failed';
      default: return 'Processing';
    }
  }

  getErrorMessage(): string {
    const err = this.error();
    if (!err) return '';

    if (err.includes('No liquidity')) {
      return 'No liquidity';
    }
    if (err.includes('Amount too small')) {
      return 'Amount too small';
    }
    // On-chain revert checks must run BEFORE the generic "network"/"chain"
    // bucket below — our friendly revert phrasing intentionally contains
    // the word "network" and would otherwise be shadowed into "Network
    // Error", which misrepresents an on-chain failure as a connectivity
    // issue.
    if (err.includes("Couldn't complete on the network") || err.includes('reverted')) {
      return "Couldn't complete on the network";
    }
    if (err.includes('network') || err.includes('chain')) {
      return 'Network error';
    }
    // No mapping matched — pass through; the CTA bounds it via
    // truncateErrorForCta and carries the full text in its title attribute.
    return err;
  }

  /**
   * Both tokens picked and a positive amount typed — everything a quote
   * fetch needs. Gates the error-CTA retry and the centre refresh button:
   * a failed fetch nulls `quote()`, and keying the refresh affordances off
   * the quote alone left the error state with no way out but retyping.
   */
  readonly hasValidQuoteInputs = computed<boolean>(() => {
    const amount = parseFloat(this.fromAmount);
    return (
      !!this.fromToken() &&
      !!this.toToken() &&
      Number.isFinite(amount) &&
      amount > 0
    );
  });

  /**
   * Label for the quote-error CTA: the (bounded, single-line) message plus
   * an explicit "Tap to retry" when a retry is actually possible. Full raw
   * text lives in the button's title attribute.
   */
  readonly quoteErrorCta = computed<string>(() => {
    const message = this.getErrorMessage();
    if (!message) return '';
    const presented = presentError(message, 'quote');
    if (presented.detail) {
      // Technical garbage was replaced — the calm copy already names the
      // retry step, so appending "Tap to retry" would stutter.
      return presented.short;
    }
    const bounded = truncateErrorForCta(presented.short);
    return this.hasValidQuoteInputs() ? `${bounded} — Tap to retry` : bounded;
  });

  /** Click handler for the quote-error CTA — force-refresh past the cache. */
  retryQuote(): void {
    if (!this.hasValidQuoteInputs()) return;
    this.fetchQuote(true);
  }

  goToReview(): void {
    const q = this.quote();
    // Unsellable destination token: the swap-step CTA never renders Review
    // in this state, but a programmatic call must hit the same wall — no
    // path may carry a hard-blocked token into review.
    if (this.hardBlockToken()) return;
    // Same wall for the soft risk tier (high / critical / unknown): an
    // elevated-risk destination token may not enter review unacknowledged —
    // mirrors the swap-step CTA gate so a late-resolving verdict (or a
    // programmatic call) can't carry a risky token past the ack.
    if (this.requiresTokenRiskAck() && !this.acknowledgedHighRisk()) return;
    // Mirror of the CTA gate: a quote fetched for a DIFFERENT amount than
    // the one currently typed (the 500 ms debounce window) must never reach
    // review, even if a click bypasses the disabled CTA branch.
    if (q && this.quoteMatchesInput()) {
      // Reset the ack signals on each entry — a different quote may be
      // shown by the time we land here (auto-refresh, silent re-quote, or
      // a sim that ran on a now-stale quote).
      this.acknowledgedHighValue.set(false);
      this.acknowledgedSimulationFailure.set(false);
      this.acknowledgedQuoteRisk.set(false);
      this.currentStep.set('review');
      this.focusStepHeading();
      this.analytics.track('swap_review_opened', this.swapAnalyticsProps(q));
    }
  }

  /** Leave review for the swap form; a pending price-move notice is stale. */
  cancelReview(): void {
    this.requotePriceNotice.set(null);
    this.currentStep.set('swap');
    this.focusStepHeading();
  }

  /**
   * Single source of truth for the review Confirm CTA. The template binds
   * `[disabled]="!canConfirmSwap()"` and `handleReviewConfirm()` early-returns
   * on the same computed, so a click that bypasses the disabled attribute
   * (programmatic, stale DOM) can never be more permissive than the visible
   * button state. The boolean chain is the former inline [disabled]
   * expression, verbatim.
   */
  readonly canConfirmSwap = computed<boolean>(() => {
    const risk = this.quoteRisk();
    const sim = this.simulationState();
    return !(
      this.isExecutingPreflight() ||
      this.transactionStatus() !== 'idle' ||
      risk.hardBlock ||
      // Unsellable destination token (honeypot & co): the swap-step gate
      // normally stops this earlier, but a verdict that lands while the
      // user is already on review must still kill Confirm.
      this.hardBlockToken() ||
      // Destination-token soft-risk gate (high / critical / unknown, not
      // hard-blocked): the swap-step CTA enforces this, but a GoPlus verdict
      // that lands AFTER the user reached review must still keep Confirm
      // disabled until acknowledged. `requiresTokenRiskAck` is already false
      // when hard-blocked, so this composes with the line above without
      // double-gating. Closes the audit "unknown fails open on confirm" hole.
      (this.requiresTokenRiskAck() && !this.acknowledgedHighRisk()) ||
      // The wallet can't pay the network fee — the signature WILL fail.
      // Blocking with the reason (banner on review) beats letting the
      // wallet reject with advice that doesn't apply.
      this.nativeGasShortfall() !== null ||
      (risk.needsAck && !this.acknowledgedQuoteRisk()) ||
      (this.isHighValueSwap() && !this.acknowledgedHighValue()) ||
      sim.status === 'pending' ||
      (sim.status === 'revert' && sim.kind === 'allowance') ||
      (sim.status === 'revert' && !this.acknowledgedSimulationFailure())
    );
  });

  handleReviewConfirm(): void {
    // Full mirror of the Confirm [disabled] state — risk gate, high-value
    // ack, simulation pending/revert and in-flight execution all block here
    // too, even if the disabled attribute is somehow bypassed.
    if (!this.canConfirmSwap()) {
      return;
    }
    // The bridge acknowledgement is a SAFETY gate, not an educational tip —
    // it must not silently disappear when the user turns Smart Tips off.
    if (this.isCrossChain()) {
      // Don't reset `crossChainConfirmed` here. The ack lives as long as the
      // user keeps the same token pair (an effect resets it when fromToken
      // or toToken changes). Resetting on every modal-open meant a user who
      // dismissed the modal accidentally lost their checkbox state — which
      // is exactly what C6 was about.
      this.showCrossChainConfirm.set(true);
    } else {
      this.executeSwap();
    }
  }

  confirmCrossChainSwap(): void {
    this.showCrossChainConfirm.set(false);
    this.crossChainConfirmed.set(false);
    this.executeSwap();
  }

  async executeSwap(): Promise<void> {
    let q = this.quote();
    if (!q) return;

    // Component-level reentrancy guard. The service has its own as a
    // backstop, but throwing from there used to bubble all the way up to
    // Angular's global error handler and render the "Something went wrong"
    // page on a benign double-click. Catching it here keeps the UX as a
    // simple toast.
    if (this.isExecutingPreflight() || this.transactionStatus() !== 'idle') {
      this.toastService.warning(
        'Swap in progress',
        'Please wait for the current swap to finish before starting a new one.',
      );
      return;
    }
    this.isExecutingPreflight.set(true);

    // A fresh Confirm supersedes any previous price-move notice; if the
    // re-quote below trips the gate again it sets a fresh one.
    this.requotePriceNotice.set(null);

    // Stop refreshing quotes during swap execution
    this.stopQuoteAutoRefresh();

    // Silent re-quote: between the user's initial getQuote() and this click,
    // the backend can pick a different aggregator — whose approvalAddress may
    // differ. If it did, the allowance the user just signed points at the
    // wrong spender and the swap would revert. Bounce them back to review
    // and force a re-approve instead of burning a failed tx.
    let refresh: Awaited<ReturnType<typeof this.lifiService.refreshQuoteBeforeExecute>>;
    try {
      refresh = await this.lifiService.refreshQuoteBeforeExecute(q);
    } finally {
      // Preflight ends as soon as we know the route. From here on, either
      // we bail out or we transition to `'signing'` — both states have their
      // own visible feedback.
      this.isExecutingPreflight.set(false);
    }
    if (refresh.networkError) {
      // The backend was unreachable / returned nothing on a quote that does
      // carry aggregator data. We can't validate that the cached calldata
      // and approvalAddress are still correct — block instead of risking a
      // revert (or, worse, a swap against a now-different spender contract).
      this.currentStep.set('swap');
      this.focusStepHeading();
      this.toastService.error(
        'Couldn\'t validate route',
        'We could not verify the latest swap route. Please refresh the quote and try again.',
      );
      this.startQuoteAutoRefresh();
      return;
    }
    if (refresh.refreshed) {
      if (refresh.approvalAddressChanged) {
        this.quote.set(refresh.quote);
        this.needsApproval.set(true);
        // Approve button only renders on the 'swap' step — bouncing to
        // 'review' would leave the user staring at a "please approve again"
        // toast with no Approve button visible.
        this.currentStep.set('swap');
        this.focusStepHeading();
        this.toastService.error(
          'Route changed',
          'A better route was found but it needs a new approval. Please approve again.',
        );
        this.startQuoteAutoRefresh();
        return;
      }
      // Same spender, maybe different price — swap calldata/minReceived
      // into the quote so we execute the freshest numbers.
      const previousToAmount = q.toAmount;
      q = refresh.quote;
      this.quote.set(q);
      if (refresh.priceChanged) {
        const worsening = computeQuoteWorsening(previousToAmount, q.toAmount);
        if (worsening > REQUOTE_MAX_WORSENING) {
          // The user confirmed different numbers on review — never sign a
          // materially worse trade behind their back. The fresh quote is
          // already applied above, so review shows the updated numbers next
          // to the price-move banner; an explicit new Confirm is required.
          this.requotePriceNotice.set({
            previousToAmount,
            newToAmount: q.toAmount,
            toSymbol: q.toToken.symbol,
          });
          // The ticked acks belonged to the numbers the user confirmed
          // before the re-quote replaced them — the forced re-confirm must
          // re-ask against the quote actually on screen.
          this.acknowledgedQuoteRisk.set(false);
          this.acknowledgedHighValue.set(false);
          this.currentStep.set('review');
          this.startQuoteAutoRefresh();
          return;
        }
        // Improvement or sub-threshold drift: proceed on the fresh numbers.
        this.toastService.info('Quote refreshed', 'Price updated to the latest rate.');
      }
    }

    // Expiry guard BEFORE any state transition. On the LI.FI fallback path
    // (refreshed=false) the execution service throws on quotes >45s old —
    // letting that happen painted a "Swap failed" screen and wrote a phantom
    // failed record into history for what is just a stale review screen.
    if (!refresh.refreshed && this.isQuoteTooOld(q)) {
      this.currentStep.set('review');
      this.startQuoteAutoRefresh();
      this.toastService.warning(
        'Quote expired',
        'Rates moved on while you were reviewing. Refresh the quote to continue.',
      );
      return;
    }

    // Re-simulate the bytes we're ACTUALLY about to sign. A successful silent
    // re-quote (refreshed=true) can swap in fresh calldata — new route
    // internals, a new deadline, a different aggregator's encoding — that the
    // review-screen eth_call never saw. Signing it unchecked re-opens the very
    // hole the review simulation closes: a definitively-reverting tx burns gas
    // for nothing. Bounce a hard revert back to review, where the (step, quote)
    // effect re-runs the sim and renders the failure banner + explicit ack.
    // Inconclusive results and infra errors are NOT verdicts — fail OPEN, just
    // like the review-path simulation.
    if (refresh.refreshed) {
      // Re-assert the preflight guard across this await: resetting it after
      // refreshQuoteBeforeExecute (above) would otherwise leave a window where
      // a second Confirm click re-enters executeSwap mid-simulation.
      this.isExecutingPreflight.set(true);
      let resimReverts = false;
      try {
        const resim = await this.lifiService.simulateSwap(q);
        resimReverts = !resim.ok;
      } catch {
        // Infra noise (RPC down, timeout) is not a revert verdict — fail open.
      } finally {
        this.isExecutingPreflight.set(false);
      }
      if (resimReverts) {
        this.currentStep.set('review');
        this.focusStepHeading();
        this.startQuoteAutoRefresh();
        this.toastService.warning(
          'Route changed',
          'The refreshed route didn\'t pass our safety pre-check. Please review the details before confirming.',
        );
        return;
      }
    }

    // Every preflight gate passed — the swap is actually starting. Capture
    // the props once so the terminal completed/failed events (which may fire
    // long after `quote()` was reset) describe the same swap.
    const analyticsProps = this.swapAnalyticsProps(q);
    this.analytics.track('swap_confirmed', analyticsProps);

    this.currentStep.set('status');
    this.focusStepHeading();
    // The status screen now belongs to THIS swap — detach it from any
    // previous hub-tracked swap (whose pill keeps living elsewhere).
    this.hubAttached.set(false);
    this.transactionStatus.set('signing');
    this.txHash.set('');
    this.explorerUrl.set('');
    this.txError.set('');
    this.untrackedBridgeTrackingUrl.set(null);

    // Setup tracking state for progress display
    const isCrossChain = q.fromToken.chainId !== q.toToken.chainId;
    this.trackingState.set({
      progress: 5,
      currentStep: 0,
      steps: isCrossChain
        ? [
          {
            id: 'signing',
            title: 'Sign Transaction',
            description: 'Please confirm in your wallet',
            status: 'in_progress'
          },
          {
            id: 'source-confirm',
            title: `Confirming on ${this.getNetworkName(q.fromToken.chainId)}`,
            description: 'Waiting for blockchain confirmation',
            status: 'pending'
          },
          {
            id: 'bridging',
            title: 'Bridging tokens',
            description: `Transferring from ${this.getNetworkName(q.fromToken.chainId)} to ${this.getNetworkName(q.toToken.chainId)}`,
            status: 'pending'
          },
          {
            id: 'dest-confirm',
            title: `Receiving on ${this.getNetworkName(q.toToken.chainId)}`,
            description: 'Tokens arriving at destination',
            status: 'pending'
          },
        ]
        : [
          {
            id: 'signing',
            title: 'Sign Transaction',
            description: 'Please confirm in your wallet',
            status: 'in_progress'
          },
          {
            id: 'confirming',
            title: 'Confirming swap',
            description: `Swapping on ${this.getNetworkName(q.fromToken.chainId)}`,
            status: 'pending'
          },
        ],
      isTracking: true,
      // Cross-chain deliberately gets NO numeric ETA: a "~3m remaining"
      // countdown next to copy promising 5–30 minutes reads as a hang the
      // moment it expires. The status template shows the honest range
      // instead; same-chain keeps its short, realistic estimate.
      estimatedTimeRemaining: isCrossChain ? undefined : 30,
    });

    // Create transaction history record
    let txRecord: ReturnType<typeof this.txHistoryService.createSwapTransaction> | null = null;
    try {
      txRecord = this.txHistoryService.createSwapTransaction({
        fromToken: {
          symbol: q.fromToken.symbol,
          name: q.fromToken.name,
          address: q.fromToken.address,
          chainId: q.fromToken.chainId,
          amount: q.fromAmount,
          amountUSD: parseFloat(q.fromAmountUSD),
          logoURI: q.fromToken.logoURI,
        },
        toToken: {
          symbol: q.toToken.symbol,
          name: q.toToken.name,
          address: q.toToken.address,
          chainId: q.toToken.chainId,
          amount: q.toAmount,
          amountUSD: parseFloat(q.toAmountUSD),
          logoURI: q.toToken.logoURI,
        },
        chainId: q.fromToken.chainId,
        tool: q.route[0]?.protocol,
        // '' is the "couldn't estimate" sentinel — record no fee rather
        // than NaN (which JSON-serializes to null in stored history).
        gasUSD: Number.isFinite(parseFloat(q.gasCostUSD)) ? parseFloat(q.gasCostUSD) : undefined,
        // Persisted so a future rehydration pass can resume bridge tracking
        // through the backend /swap/status dispatcher.
        aggregator: q.aggregator,
        trackingQuoteId: q._aggregatorData?.tracking_quote_id,
        trackingRequestId: q._aggregatorData?.tracking_request_id,
      });
    } catch {
      // No wallet connected - skip history tracking
    }

    try {
      // ⚠️ CRITICAL: Use existing quote, do NOT fetch fresh quote here!
      //
      // Why: Each getQuote() can return a DIFFERENT route with DIFFERENT approvalAddress.
      // User approved tokens for THIS quote's approvalAddress. If we fetch a new quote,
      // the new route's approvalAddress might be different → swap REVERTS.
      //
      // This bug took 2 days to fix. See lifi.service.ts executeSwap() for full explanation.
      // console.log('Executing swap with existing quote:', {
      //   from: `${q.fromAmount} ${q.fromToken.symbol}`,
      //   to: `${q.toAmount} ${q.toToken.symbol}`,
      //   slippage: `${q.slippage}%`,
      // });

      const quoteToExecute = q;
      // The execution service emits 'completed' ONLY after a receipt with
      // status 1; a null receipt (broadcast ok, confirmation unknown) emits
      // 'confirming' instead. Capture the terminal emission so the
      // post-await code can tell a confirmed same-chain swap from an
      // unconfirmed broadcast without widening the facade's return type.
      let sourceConfirmed = false;
      const result = await this.lifiService.executeSwap(quoteToExecute, (status, hash) => {
        if (status === 'completed') {
          sourceConfirmed = true;
        }
        // Cross-chain: the execution service emits 'completed' as soon as the
        // SOURCE-chain receipt lands, but tokens are still mid-bridge for
        // 5-30 minutes. Downgrade it to 'confirming' here — the final
        // 'completed' may only come from the LI.FI tracker's DONE verdict in
        // startTransactionTracking (untrackable routes honestly stay
        // 'confirming' via setUntrackableBridgeState). `isCrossChain` is
        // captured from the quote being executed, not re-read from mutable
        // component state.
        this.transactionStatus.set(
          isCrossChain && status === 'completed' ? 'confirming' : status,
        );

        if (hash) {
          this.txHash.set(hash);
          this.explorerUrl.set(this.getExplorerUrl(quoteToExecute.fromToken.chainId, hash));
        }

        // Update tracker state based on swap status
        const currentState = this.trackingState();
        if (currentState) {
          const updatedSteps = [...currentState.steps];

          if (status === 'pending' || status === 'confirming') {
            // Signing complete, now confirming
            updatedSteps[0] = { ...updatedSteps[0], status: 'completed' };
            updatedSteps[1] = { ...updatedSteps[1], status: 'in_progress' };
            this.trackingState.set({
              ...currentState,
              progress: 50,
              currentStep: 1,
              steps: updatedSteps,
            });
          } else if (status === 'completed' && !isCrossChain) {
            // Transaction confirmed - immediately update UI for same-chain swaps
            updatedSteps[0] = { ...updatedSteps[0], status: 'completed' };
            updatedSteps[1] = {
              ...updatedSteps[1],
              status: 'completed',
              explorerLink: hash ? this.getExplorerUrl(quoteToExecute.fromToken.chainId, hash) : undefined
            };
            this.trackingState.set({
              ...currentState,
              progress: 100,
              currentStep: 1,
              steps: updatedSteps,
              isTracking: false,
              estimatedTimeRemaining: 0,
            });
          } else if (status === 'completed') {
            // Cross-chain source receipt: signing + source-confirm are done,
            // the bridge leg starts now. Progress stays well below 100 and
            // isTracking stays true — only the tracker's DONE (or the
            // untrackable-bridge state) may declare the endgame.
            updatedSteps[0] = { ...updatedSteps[0], status: 'completed' };
            updatedSteps[1] = {
              ...updatedSteps[1],
              status: 'completed',
              explorerLink: hash ? this.getExplorerUrl(quoteToExecute.fromToken.chainId, hash) : undefined
            };
            if (updatedSteps[2]) {
              updatedSteps[2] = { ...updatedSteps[2], status: 'in_progress' };
            }
            this.trackingState.set({
              ...currentState,
              progress: 60,
              currentStep: 2,
              steps: updatedSteps,
            });
          }
        }
      }, { skipSimulationGate: this.acknowledgedSimulationFailure() });

      // History/UI side-effects branch by chain topology:
      //
      //   Same-chain: source-confirm IS the final outcome — mark success now.
      //   Cross-chain: source-confirm only means "tokens left source chain".
      //     Destination delivery is async and tracked via LI.FI Status API.
      //     Marking history as success here would zero-out a swap that's
      //     still mid-bridge; defer to the tracker's final DONE/FAILED.
      //
      // Either way, `sourceConfirmed === false` means NO receipt exists yet
      // — nothing downstream (success toast, bridging toast, bridge
      // trackers) may pretend one does.
      if (!sourceConfirmed) {
        if (isCrossChain) {
          // Broadcast ok, but the SOURCE receipt never arrived in the wait
          // window. "Bridging now" would be a guess — the source tx may
          // still revert. Settle the source receipt first; the re-poll
          // hands over to the bridge tracker only on a status-1 receipt.
          this.presentUnconfirmedCrossChainBroadcast(quoteToExecute, result, txRecord?.id, analyticsProps);
        } else {
          // Same-chain: never markSuccess here — show the honest "sent,
          // waiting" state and keep watching in the background. The
          // history record stays pending until a receipt settles it.
          this.presentUnconfirmedBroadcast(quoteToExecute, result, txRecord?.id, analyticsProps);
        }
      } else if (!isCrossChain) {
        if (txRecord) {
          this.txHistoryService.markSuccess(txRecord.id, result.hash);
        }
        this.analytics.track('swap_completed', analyticsProps);
        this.toastService.success(
          'Swap completed!',
          `Successfully swapped ${quoteToExecute.fromAmount} ${quoteToExecute.fromToken.symbol} for ${quoteToExecute.toAmount} ${quoteToExecute.toToken.symbol}`,
          result.explorerUrl ? { text: 'View on explorer', url: result.explorerUrl } : undefined
        );
        // Haptic confirmation on supported devices — only when the swap is
        // truly finalised, not at the source-confirm step of a bridge.
        this.triggerSuccessHaptic();
      } else {
        this.toastService.info(
          'Swap sent, bridging now',
          `Source tx confirmed on ${this.getNetworkName(quoteToExecute.fromToken.chainId)}. Tracking destination delivery…`,
          result.explorerUrl ? { text: 'View source tx', url: result.explorerUrl } : undefined
        );
      }

      // Start transaction tracking for cross-chain swaps only — and only
      // once the source receipt actually confirmed; for an unconfirmed
      // broadcast the source re-poll above owns the hand-over. (The LI.FI
      // Status API doesn't work for same-chain swaps — returns "Not an EVM
      // Transaction".)
      if (isCrossChain && sourceConfirmed) {
        this.startBridgeTracking(
          quoteToExecute,
          result.hash,
          result.explorerUrl,
          txRecord?.id,
          analyticsProps,
        );
      } else if (!isCrossChain && sourceConfirmed) {
        // For same-chain swaps, immediately mark as complete. An
        // unconfirmed broadcast already painted its own "sent, waiting"
        // state above — overwriting it with "Swap Complete" would be the
        // exact false-success this branch is gated against.
        this.trackingState.set({
          progress: 100,
          currentStep: 1,
          steps: [
            {
              id: 'signing',
              title: 'Sign Transaction',
              description: 'Transaction signed',
              status: 'completed'
            },
            {
              id: 'confirming',
              title: 'Swap Complete',
              description: `Swapped on ${this.getNetworkName(quoteToExecute.fromToken.chainId)}`,
              status: 'completed',
              explorerLink: result.explorerUrl
            },
          ],
          isTracking: false,
          estimatedTimeRemaining: 0,
        });
      }

      this.balanceRefreshService.triggerRefresh();

      setTimeout(() => {
        this.forceRefreshBalances();
        this.walletService.updateBalance();
      }, 2000);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Transaction failed';

      // Reentrancy from the service-side guard manifests as this exact
      // string. Bounce back to review with a toast — we never broadcast,
      // there's nothing to mark "failed" in history.
      if (message.includes('A swap is already in progress')) {
        this.transactionStatus.set('idle');
        this.currentStep.set('review');
        this.focusStepHeading();
        this.toastService.warning('Swap in progress', 'Please wait for the current swap to finish.');
        return;
      }

      // The user declined the signature in their wallet — a decision, not a
      // failure: nothing was broadcast. Mirror the reentrancy bounce:
      // return to review (the silent re-quote just refreshed the numbers,
      // so the quote on screen is live), delete the pending history record
      // created before signing — a swap that never left the wallet must not
      // appear as 'failed' — and restart the countdown ticker that drives
      // the review expiry chip.
      if (isUserRejectionError(message)) {
        if (txRecord) {
          this.txHistoryService.deleteTransaction(txRecord.id);
        }
        this.analytics.track('swap_failed', { ...analyticsProps, reason: 'rejected' });
        this.transactionStatus.set('idle');
        this.trackingState.set(null);
        this.currentStep.set('review');
        this.focusStepHeading();
        this.toastService.info(
          'Signature cancelled',
          'No transaction was sent — your quote stays live.',
        );
        this.startQuoteAutoRefresh();
        return;
      }

      // Update transaction history as failed
      if (txRecord) {
        this.txHistoryService.markFailed(txRecord.id, message);
      }

      // The execution service normalizes ACTION_REJECTED/4001 to a message
      // containing "rejected" — cheap, stable discriminator for the funnel.
      this.analytics.track('swap_failed', {
        ...analyticsProps,
        reason: message.toLowerCase().includes('rejected') ? 'rejected' : 'failed',
      });

      this.transactionStatus.set('failed');
      // Boundary sanitization: the failure screen, toast and timeline banner
      // show calm copy for technical dumps; history keeps the raw message.
      const presented = presentError(message, 'swap');
      this.txError.set(presented.short);
      this.toastService.error('Swap failed', presented.short);

      // Update tracker to show failure
      const currentState = this.trackingState();
      if (currentState) {
        const updatedSteps = currentState.steps.map(step => {
          if (step.status === 'in_progress') {
            return { ...step, status: 'failed' as const };
          }
          return step;
        });
        this.trackingState.set({
          ...currentState,
          steps: updatedSteps,
          isTracking: false,
          error: presented.short,
        });
      }
    }
  }

  /**
   * Hand the confirmed cross-chain swap over to ActiveSwapHubService, which
   * dispatches to whichever tracker can actually see the transfer (LI.FI
   * Status API / backend /swap/status dispatcher / honest untracked
   * presentation) and OWNS the loop from here — tracking, history verdicts
   * and toasts all survive this component being destroyed. Called from
   * executeSwap right after a CONFIRMED source receipt, or from the
   * source-receipt re-poll once a late receipt settles — never before one
   * exists. The mirror effect (see constructor) repaints this screen from
   * hub state while the user stays on it.
   */
  private startBridgeTracking(
    q: SwapQuote,
    txHash: string,
    explorerUrl: string,
    historyRecordId: string | undefined,
    analyticsProps: AnalyticsProps,
  ): void {
    // Take UI ownership for this swap: mute any older component-local
    // callbacks (receipt re-polls) and bind the screen to the hub's state.
    this.trackingSession++;
    this.hubAttached.set(true);
    this.activeSwapHub.startCrossChainTracking({
      quote: q,
      txHash,
      explorerUrl,
      historyRecordId,
      analyticsProps,
    });
  }

  /**
   * Honest presentation for a same-chain broadcast whose receipt never
   * arrived in the execution wait window: the tx is on the network but we
   * don't know whether it mined. Shows "sent — waiting for confirmation"
   * with the explorer link, leaves the history record pending, and starts
   * the bounded background receipt re-poll that will settle it either way.
   */
  private presentUnconfirmedBroadcast(
    q: SwapQuote,
    result: { hash: string; explorerUrl: string },
    historyRecordId: string | undefined,
    analyticsProps: AnalyticsProps,
  ): void {
    const chainName = this.getNetworkName(q.fromToken.chainId);
    this.awaitingReceiptConfirmation.set(true);
    this.transactionStatus.set('confirming');
    this.trackingState.set({
      progress: 75,
      currentStep: 1,
      steps: [
        {
          id: 'signing',
          title: 'Sign Transaction',
          description: 'Transaction signed',
          status: 'completed',
        },
        {
          id: 'confirming',
          title: 'Transaction sent — waiting for confirmation',
          description: `Broadcast to ${chainName}, but the network hasn't confirmed it yet. We'll keep checking for a few minutes.`,
          status: 'in_progress',
          explorerLink: result.explorerUrl,
        },
      ],
      isTracking: true,
    });
    this.toastService.info(
      'Transaction sent',
      `Waiting for ${chainName} to confirm. We'll keep checking in the background.`,
      result.explorerUrl ? { text: 'View on explorer', url: result.explorerUrl } : undefined,
    );
    void this.repollSameChainReceipt(result.hash, q, historyRecordId, analyticsProps, result.explorerUrl);
  }

  /**
   * Bounded background receipt re-poll (default: every 10s for 5 minutes)
   * for an unconfirmed same-chain broadcast.
   *   - receipt.status 1 → finalize success (history, toast, completed UI);
   *   - receipt.status 0 → finalize failure honestly;
   *   - window closes with nothing → stay 'confirming' with honest copy and
   *     leave the record pending — for same-chain, pending IS the truth
   *     until a receipt exists (no 60-min normalization applies).
   * Like the bridge trackers, history verdicts always land; the screen is
   * only repainted while the user hasn't started a new swap (session guard).
   */
  private async repollSameChainReceipt(
    hash: string,
    q: SwapQuote,
    historyRecordId: string | undefined,
    analyticsProps: AnalyticsProps,
    explorerUrl: string,
  ): Promise<void> {
    const session = this.trackingSession;
    const chainId = q.fromToken.chainId;
    const deadline = Date.now() + this.receiptRepollWindowMs;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.receiptRepollIntervalMs));
      let receipt: Awaited<ReturnType<typeof fetchReceiptWithFallback>> = null;
      try {
        // null wallet provider → straight to the public-RPC fallback; a
        // short per-attempt window keeps each probe cheap.
        receipt = await this.fetchReceipt(null, hash, chainId, 8_000);
      } catch {
        // Transient RPC failure — keep polling until the window closes.
      }
      if (!receipt) continue;

      const uiLive = session === this.trackingSession;
      if (receipt.status === 0) {
        const reason = "Couldn't complete on the network";
        if (historyRecordId) {
          this.txHistoryService.markFailed(historyRecordId, reason);
        }
        this.analytics.track('swap_failed', { ...analyticsProps, reason: 'failed' });
        if (uiLive) {
          this.awaitingReceiptConfirmation.set(false);
          this.transactionStatus.set('failed');
          this.txError.set(reason);
          const current = this.trackingState();
          if (current) {
            this.trackingState.set({
              ...current,
              steps: current.steps.map((step) =>
                step.status === 'in_progress' ? { ...step, status: 'failed' as const } : step,
              ),
              isTracking: false,
              error: reason,
            });
          }
        }
        // The user may have moved on minutes ago — an anonymous "Swap
        // Failed" wouldn't say WHICH swap. Mirror the success toast's
        // identification (amounts + symbols).
        this.toastService.error(
          'Swap failed',
          `Your swap of ${q.fromAmount} ${q.fromToken.symbol} → ${q.toAmount} ${q.toToken.symbol} couldn't complete on the network.`,
          explorerUrl ? { text: 'View on explorer', url: explorerUrl } : undefined,
        );
      } else {
        if (historyRecordId) {
          this.txHistoryService.markSuccess(historyRecordId, hash);
        }
        this.analytics.track('swap_completed', analyticsProps);
        if (uiLive) {
          this.awaitingReceiptConfirmation.set(false);
          this.transactionStatus.set('completed');
          this.trackingState.set({
            progress: 100,
            currentStep: 1,
            steps: [
              {
                id: 'signing',
                title: 'Sign Transaction',
                description: 'Transaction signed',
                status: 'completed',
              },
              {
                id: 'confirming',
                title: 'Swap Complete',
                description: `Swapped on ${this.getNetworkName(chainId)}`,
                status: 'completed',
                explorerLink: explorerUrl,
              },
            ],
            isTracking: false,
            estimatedTimeRemaining: 0,
          });
        }
        this.toastService.success(
          'Swap completed!',
          `Successfully swapped ${q.fromAmount} ${q.fromToken.symbol} for ${q.toAmount} ${q.toToken.symbol}`,
          explorerUrl ? { text: 'View on explorer', url: explorerUrl } : undefined,
        );
        this.triggerSuccessHaptic();
        this.balanceRefreshService.triggerRefresh();
      }
      return;
    }

    // Gave up: confirmation still unknown. Keep the honest 'confirming'
    // presentation, surface the give-up copy, and leave history pending.
    if (session === this.trackingSession) {
      const current = this.trackingState();
      if (current) {
        this.trackingState.set({
          ...current,
          isTracking: false,
          error:
            "We couldn't confirm this transaction within 5 minutes. It may still complete — check the explorer for the final status.",
        });
      }
    }
  }

  /**
   * Honest presentation for a CROSS-CHAIN broadcast whose SOURCE receipt
   * never arrived in the execution wait window. Bridging has not started
   * until the source tx mined with status 1 — claiming "bridging now" (or
   * seeding a bridge tracker) on a tx that may still revert would present
   * a possible failure as progress. Shows "sent — waiting for the source
   * chain", leaves history pending, and starts the bounded source-receipt
   * re-poll that either hands over to the bridge tracker or fails honestly.
   */
  private presentUnconfirmedCrossChainBroadcast(
    q: SwapQuote,
    result: { hash: string; explorerUrl: string },
    historyRecordId: string | undefined,
    analyticsProps: AnalyticsProps,
  ): void {
    const fromChainName = this.getNetworkName(q.fromToken.chainId);
    const toChainName = this.getNetworkName(q.toToken.chainId);
    this.awaitingReceiptConfirmation.set(true);
    this.transactionStatus.set('confirming');
    this.trackingState.set({
      progress: 40,
      currentStep: 1,
      steps: [
        {
          id: 'signing',
          title: 'Sign Transaction',
          description: 'Transaction signed',
          status: 'completed',
        },
        {
          id: 'source-confirm',
          title: `Sent — waiting for ${fromChainName} to confirm`,
          description: `Broadcast to ${fromChainName}, but the network hasn't confirmed it yet. Bridging starts once it does — we'll keep checking for a few minutes.`,
          status: 'in_progress',
          explorerLink: result.explorerUrl,
        },
        {
          id: 'bridging',
          title: 'Bridging tokens',
          description: `Transferring from ${fromChainName} to ${toChainName}`,
          status: 'pending',
        },
        {
          id: 'dest-confirm',
          title: `Receiving on ${toChainName}`,
          description: 'Tokens arriving at destination',
          status: 'pending',
        },
      ],
      isTracking: true,
    });
    this.toastService.info(
      'Transaction sent',
      `Waiting for ${fromChainName} to confirm the source transaction. We'll keep checking in the background.`,
      result.explorerUrl ? { text: 'View on explorer', url: result.explorerUrl } : undefined,
    );
    void this.repollCrossChainSourceReceipt(result.hash, q, historyRecordId, analyticsProps, result.explorerUrl);
  }

  /**
   * Bounded background SOURCE-receipt re-poll for a cross-chain broadcast
   * (same clock as repollSameChainReceipt):
   *   - receipt.status 1 → only now is "bridging" honest: bridging toast +
   *     hand-over to the bridge tracker, which owns the final verdict
   *     (history stays pending until the destination settles);
   *   - receipt.status 0 → finalize failure honestly — the bridge never
   *     saw the funds;
   *   - window closes with nothing → stay 'confirming' with honest copy
   *     and leave the record pending.
   * Session guard mirrors repollSameChainReceipt: history verdicts and
   * toasts always land; the screen is only repainted while the user hasn't
   * started a new swap. The bridge tracker is additionally only attached
   * to a screen we still own — starting one takes UI ownership (it bumps
   * the tracking session) and would hijack a fresh swap's screen.
   */
  private async repollCrossChainSourceReceipt(
    hash: string,
    q: SwapQuote,
    historyRecordId: string | undefined,
    analyticsProps: AnalyticsProps,
    explorerUrl: string,
  ): Promise<void> {
    const session = this.trackingSession;
    const chainId = q.fromToken.chainId;
    const deadline = Date.now() + this.receiptRepollWindowMs;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.receiptRepollIntervalMs));
      let receipt: Awaited<ReturnType<typeof fetchReceiptWithFallback>> = null;
      try {
        // null wallet provider → straight to the public-RPC fallback; a
        // short per-attempt window keeps each probe cheap.
        receipt = await this.fetchReceipt(null, hash, chainId, 8_000);
      } catch {
        // Transient RPC failure — keep polling until the window closes.
      }
      if (!receipt) continue;

      const uiLive = session === this.trackingSession;
      if (receipt.status === 0) {
        // The source tx reverted — the bridge never started. Same failure
        // treatment as the same-chain re-poll.
        const reason = "Couldn't complete on the network";
        if (historyRecordId) {
          this.txHistoryService.markFailed(historyRecordId, reason);
        }
        this.analytics.track('swap_failed', { ...analyticsProps, reason: 'failed' });
        if (uiLive) {
          this.awaitingReceiptConfirmation.set(false);
          this.transactionStatus.set('failed');
          this.txError.set(reason);
          const current = this.trackingState();
          if (current) {
            this.trackingState.set({
              ...current,
              steps: current.steps.map((step) =>
                step.status === 'in_progress' ? { ...step, status: 'failed' as const } : step,
              ),
              isTracking: false,
              error: reason,
            });
          }
        }
        this.toastService.error(
          'Swap failed',
          `Your swap of ${q.fromAmount} ${q.fromToken.symbol} → ${q.toAmount} ${q.toToken.symbol} couldn't complete on the network.`,
          explorerUrl ? { text: 'View on explorer', url: explorerUrl } : undefined,
        );
        return;
      }

      // Status 1 — the source leg is real; bridging genuinely starts now.
      this.toastService.info(
        'Swap sent, bridging now',
        `Source tx confirmed on ${this.getNetworkName(chainId)}. Tracking destination delivery…`,
        explorerUrl ? { text: 'View source tx', url: explorerUrl } : undefined,
      );
      if (uiLive) {
        this.awaitingReceiptConfirmation.set(false);
        this.transactionStatus.set('confirming');
        this.startBridgeTracking(q, hash, explorerUrl, historyRecordId, analyticsProps);
      }
      // Not uiLive: the user already started a new swap — attaching a
      // tracker would repaint their fresh screen. History stays pending
      // and the 60-min read-time normalization in TransactionHistoryService
      // resolves it, exactly like other untracked bridges.
      this.balanceRefreshService.triggerRefresh();
      return;
    }

    // Gave up: source confirmation still unknown. Keep the honest
    // 'confirming' presentation and leave history pending.
    if (session === this.trackingSession) {
      const current = this.trackingState();
      if (current) {
        this.trackingState.set({
          ...current,
          isTracking: false,
          error:
            "We couldn't confirm the source transaction within 5 minutes. It may still complete — check the explorer for the final status.",
        });
      }
    }
  }

  resetSwap(): void {
    // Detach any in-flight bridge tracker from the UI. The transfer keeps
    // executing (hub-owned) and its history record stays pending until the
    // tracker's real verdict — only the screen is released for a new swap.
    this.trackingSession++;
    this.hubAttached.set(false);
    this.currentStep.set('swap');
    this.focusStepHeading();
    // Same in-flight hazard as swapTokens: a quote fetch still pending from
    // before the reset must not repaint the cleared state when it lands.
    this.invalidatePendingQuote();
    this.quote.set(null);
    this.requotePriceNotice.set(null);
    this.fromAmount = '';
    this.transactionStatus.set('idle');
    this.txHash.set('');
    this.explorerUrl.set('');
    this.txError.set('');
    // Reset tracker state
    this.trackingState.set(null);
    this.untrackedBridgeTrackingUrl.set(null);
    this.awaitingReceiptConfirmation.set(false);
    this.stopQuoteAutoRefresh();
  }

  /**
   * After a failed swap, send the user back to the form to retry —
   * keeping their amount and quote so they don't have to re-enter
   * everything. Critical: status must transition through `'idle'` for the
   * elapsed-time effect to clear `txStartedAt`/`txCompletedInSeconds`,
   * otherwise the next attempt's pending screen shows inflated elapsed
   * carried over from the failed attempt.
   */
  tryAgain(): void {
    this.trackingSession++;
    this.hubAttached.set(false);
    this.transactionStatus.set('idle');
    this.txHash.set('');
    this.explorerUrl.set('');
    this.txError.set('');
    this.trackingState.set(null);
    this.untrackedBridgeTrackingUrl.set(null);
    this.awaitingReceiptConfirmation.set(false);
    this.currentStep.set('swap');
    this.focusStepHeading();
    // The quote on screen is by definition >45s old (a failed tx round-trip
    // just happened) and the auto-refresh timer was stopped when execution
    // started. Without an immediate refetch the user retries straight into
    // the "Quote expired" rejection.
    if (this.fromToken() && this.toToken() && this.fromAmount && parseFloat(this.fromAmount) > 0) {
      this.fetchQuote(true);
    }
  }

  isZeroAmount(value: string): boolean {
    return !value || parseFloat(value) === 0;
  }

  /**
   * Check if user has insufficient balance for the swap
   */
  isInsufficientBalance(): boolean {
    const balance = this.fromBalance();
    const amount = parseFloat(this.fromAmount);
    return !isNaN(amount) && amount > 0 && amount > balance;
  }

  /**
   * Get progress percentage based on transaction status
   * Used when trackingState is not available
   */
  formatTokenAmount(value: string): string {
    const num = parseFloat(value);
    if (isNaN(num)) return value;
    if (num === 0) return '0';
    // For very small numbers keep more precision
    if (num < 0.00001) return num.toFixed(8);
    return parseFloat(num.toFixed(5)).toString();
  }

  getStatusProgress(): number {
    switch (this.transactionStatus()) {
      case 'signing': return 10;
      case 'pending': return 40;
      case 'confirming': return 70;
      case 'completed': return 100;
      case 'failed': return 0;
      default: return 0;
    }
  }

  getNetworkLogo = getNetworkLogo;
  getNetworkName = getNetworkName;

  /**
   * Native (gas) token symbol of a chain — same source the gas preflight
   * uses. Gas is always paid in the source chain's native token, never in
   * the ERC-20 being swapped, so every "paid in …" label must read this
   * instead of fromToken.symbol (Polygon's is 'POL' now, not MATIC).
   */
  nativeSymbolFor(chainId: number): string {
    return getNetworkById(chainId)?.nativeSymbol ?? 'ETH';
  }

  isCrossChain(): boolean {
    const from = this.fromToken();
    const to = this.toToken();
    return from && to ? from.chainId !== to.chainId : false;
  }

  private getExplorerUrl(chainId: number, txHash: string): string {
    return getExplorerTxUrl(chainId, txHash);
  }

  /**
   * Vibrate-on-success helper. Browsers that don't expose the Vibration
   * API (or refuse it without a user gesture) silently no-op so the
   * caller doesn't need its own try/catch.
   */
  private triggerSuccessHaptic(): void {
    try {
      if ('vibrate' in navigator) {
        navigator.vibrate([30, 50, 30]);
      }
    } catch {
      // Some browsers throw on vibrate without prior gesture; ignore.
    }
  }

  /**
   * Label for the external bridge-tracker link, derived from the URL host.
   * The dispatcher may hand back trackers other than Axelarscan as
   * aggregators are added — naming the wrong site is worse than a generic
   * label.
   */
  trackingLinkLabel(url: string): string {
    try {
      const host = new URL(url).hostname;
      return host === 'axelarscan.io' || host.endsWith('.axelarscan.io')
        ? 'Track on Axelarscan'
        : 'Track transfer';
    } catch {
      return 'Track transfer';
    }
  }

  /**
   * Broken token logo → generated letter tile (data URI, can't 404-loop).
   * Real logos are untouched; this only fires when loading fails.
   */
  onImageError(event: Event): void {
    replaceWithLetterIcon(event);
  }
}
