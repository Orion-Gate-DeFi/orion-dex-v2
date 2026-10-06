/**
 * =============================================================================
 * TOKEN SECURITY SERVICE
 * =============================================================================
 *
 * Service for checking token security using GoPlus Security API.
 * Detects honeypots, scams, and other risks before swap execution.
 *
 * API: https://docs.gopluslabs.io/
 *
 * @author Orion DEX Team
 * @version 1.4.0 — results carry a deterministic `hardBlock` flag for the
 *                  unsellable-token signals (honeypot / cannot_sell_all /
 *                  fake_token / sell tax > 50%) so the swap UI can disable
 *                  swapping outright instead of offering a risk checkbox.
 *                  Token address format is validated before the GoPlus URL
 *                  is composed.
 * @version 1.3.0 — trust-list fast path no longer masks hard scam flags
 *                  (honeypot / cannot_sell_all / fake_token / airdrop scam);
 *                  RWA-aware: issuer compliance controls on curated
 *                  real-world assets are reported as expected features,
 *                  not scam signals (market-integrity flags still escalate).
 */

import { Injectable, signal } from '@angular/core';
import { matchesRwaStockFamily, rwaPinVerdict } from '../models/token.model';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Risk level for transaction health
 */
export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical' | 'unknown';

/**
 * Individual risk item
 */
export interface RiskItem {
  type: 'critical' | 'high' | 'medium' | 'info' | 'good';
  icon: string;
  message: string;
  field?: string;
}

/**
 * Token security analysis result
 */
export interface TokenSecurityResult {
  /** Overall risk level */
  riskLevel: RiskLevel;
  /**
   * Deterministic "this token cannot be (fully) sold" verdict: honeypot,
   * counterfeit, cannot_sell_all, or a >50% sell tax. Unlike `riskLevel:
   * 'critical'` — which an informed user may acknowledge and proceed past —
   * a hard block means the swap is mechanically a loss and the UI must
   * disable swapping with no checkbox bypass.
   */
  hardBlock: boolean;
  /** Risk score 0-100 (higher = riskier) */
  riskScore: number;
  /** List of detected risks */
  risks: RiskItem[];
  /** Positive indicators */
  positives: RiskItem[];
  /** Raw API response for debugging */
  raw?: GoPlusTokenResponse;
  /** Whether token is verified/trusted */
  isTrusted: boolean;
  /** Holder count */
  holderCount?: number;
  /** Liquidity in USD */
  liquidityUSD?: number;
}

/**
 * GoPlus API response for token security
 */
interface GoPlusTokenResponse {
  is_open_source?: string;
  is_proxy?: string;
  is_mintable?: string;
  owner_address?: string;
  can_take_back_ownership?: string;
  owner_change_balance?: string;
  hidden_owner?: string;
  selfdestruct?: string;
  external_call?: string;
  gas_abuse?: string;
  is_in_dex?: string;
  buy_tax?: string;
  sell_tax?: string;
  cannot_buy?: string;
  cannot_sell_all?: string;
  slippage_modifiable?: string;
  is_honeypot?: string;
  transfer_pausable?: string;
  is_blacklisted?: string;
  is_whitelisted?: string;
  is_anti_whale?: string;
  anti_whale_modifiable?: string;
  trading_cooldown?: string;
  personal_slippage_modifiable?: string;
  token_name?: string;
  token_symbol?: string;
  holder_count?: string;
  total_supply?: string;
  owner_balance?: string;
  owner_percent?: string;
  creator_address?: string;
  creator_balance?: string;
  creator_percent?: string;
  lp_holder_count?: string;
  lp_total_supply?: string;
  is_airdrop_scam?: string;
  trust_list?: string;
  other_potential_risks?: string;
  note?: string;
  /** Docs shape: value 1 = counterfeit; true_token_address = the genuine
   *  asset (comma-separated when several). NOT {name,symbol,address}. */
  fake_token?: { true_token_address?: string; value?: number };
  /** Count of prior honeypots deployed by the same creator — one of the
   *  strongest scam predictors GoPlus exposes. */
  honeypot_with_same_creator?: string;
  /** Listed on major centralized exchanges — strong trust signal. */
  is_in_cex?: { listed?: string; cex_list?: string[] };
  dex?: Array<{
    name: string;
    liquidity: string;
    pair: string;
  }>;
}

/**
 * GoPlus API full response structure
 */
interface GoPlusApiResponse {
  code: number;
  message: string;
  result: {
    [tokenAddress: string]: GoPlusTokenResponse;
  };
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** GoPlus API base URL */
const GOPLUS_API_URL = 'https://api.gopluslabs.io/api/v1/token_security';

/** Chain ID mapping for GoPlus API */
const CHAIN_ID_MAP: Record<number, string> = {
  1: '1',       // Ethereum
  42161: '42161', // Arbitrum
  8453: '8453',   // Base
  137: '137',     // Polygon
  10: '10',       // Optimism
  56: '56',       // BNB Chain
  43114: '43114', // Avalanche
};

/** Cache TTL in milliseconds (5 minutes) */
const CACHE_TTL = 5 * 60 * 1000;

/** Strict 0x-prefixed 20-byte hex address (input is lower-cased upstream). */
const HEX_ADDRESS_RE = /^0x[0-9a-f]{40}$/;

// =============================================================================
// SERVICE
// =============================================================================

@Injectable({
  providedIn: 'root',
})
export class TokenSecurityService {
  /** Cache for token security results */
  private cache = new Map<string, { result: TokenSecurityResult; timestamp: number }>();

  /** Loading state signal */
  isLoading = signal<boolean>(false);

  /** Last error signal */
  lastError = signal<string | null>(null);

  // ---------------------------------------------------------------------------
  // Public Methods
  // ---------------------------------------------------------------------------

  /**
   * Check token security using GoPlus API
   *
   * @param chainId - Chain ID (1, 42161, 8453, etc.)
   * @param tokenAddress - Token contract address
   * @returns Security analysis result
   */
  async checkTokenSecurity(
    chainId: number,
    tokenAddress: string
  ): Promise<TokenSecurityResult> {
    // Normalize address
    const address = tokenAddress.toLowerCase();
    const cacheKey = `${chainId}-${address}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.result;
    }

    // Skip native tokens (ETH, MATIC, etc.)
    if (this.isNativeToken(address)) {
      const nativeResult = this.createSafeResult();
      nativeResult.positives.push({
        type: 'good',
        icon: 'verified',
        message: 'Native network token',
      });
      return nativeResult;
    }

    // Check if chain is supported
    const goPlusChainId = CHAIN_ID_MAP[chainId];
    if (!goPlusChainId) {
      console.warn('[TokenSecurity] Unsupported chain:', chainId);
      return this.createUnknownResult();
    }

    // The address is interpolated into the GoPlus request — refuse anything
    // that isn't a plain hex address so a crafted "address" can't smuggle
    // extra query parameters or path segments into the URL.
    if (!HEX_ADDRESS_RE.test(address)) {
      console.warn('[TokenSecurity] Malformed token address:', tokenAddress);
      return this.createUnknownResult('Invalid token address.');
    }

    this.isLoading.set(true);
    this.lastError.set(null);

    try {
      const query = new URLSearchParams({ contract_addresses: address });
      const response = await fetch(
        `${GOPLUS_API_URL}/${goPlusChainId}?${query.toString()}`,
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`GoPlus API error: ${response.status}`);
      }

      const data: GoPlusApiResponse = await response.json();

      // Docs (api-status-code): 1 = complete, 2 = PARTIAL data (rest ready
      // in ~15s — still usable, just don't pin it in cache), 4029 = rate
      // limited, 2021 = no info for contract. Conflating these painted a
      // rate-limited honeypot as a green "Low Risk".
      if (data.code === 4029) {
        return this.createUnknownResult('Security check rate-limited. Try again in a minute.');
      }
      if ((data.code !== 1 && data.code !== 2) || !data.result || !data.result[address]) {
        console.warn('[TokenSecurity] No data for token:', address, 'code:', data.code);
        return this.createUnknownResult('No security data available for this token.');
      }

      const tokenData = data.result[address];
      const result = this.analyzeToken(tokenData, chainId, address);

      // Cache complete results only — partial (code 2) responses become
      // complete server-side within ~15s, so the next call should re-fetch.
      if (data.code === 1) {
        this.cache.set(cacheKey, { result, timestamp: Date.now() });
      }

      return result;
    } catch (error: any) {
      console.error('[TokenSecurity] Error:', error);
      this.lastError.set(error.message);
      return this.createUnknownResult();
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Check both tokens in a swap pair
   */
  async checkSwapPairSecurity(
    fromChainId: number,
    fromTokenAddress: string,
    toChainId: number,
    toTokenAddress: string
  ): Promise<{
    fromToken: TokenSecurityResult;
    toToken: TokenSecurityResult;
    overallRisk: RiskLevel;
  }> {
    const [fromToken, toToken] = await Promise.all([
      this.checkTokenSecurity(fromChainId, fromTokenAddress),
      this.checkTokenSecurity(toChainId, toTokenAddress),
    ]);

    // Overall risk is the higher of the two
    const overallRisk = this.getHigherRisk(fromToken.riskLevel, toToken.riskLevel);

    return { fromToken, toToken, overallRisk };
  }

  /**
   * Clear cache for a specific token or all tokens
   */
  clearCache(chainId?: number, tokenAddress?: string): void {
    if (chainId && tokenAddress) {
      this.cache.delete(`${chainId}-${tokenAddress.toLowerCase()}`);
    } else {
      this.cache.clear();
    }
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Analyze token data and calculate risk
   *
   * SCORING PHILOSOPHY:
   * - Critical risks CANNOT be offset by positives
   * - Positives only reduce score when there are NO critical/high risks
   * - Low liquidity is one of the most dangerous signals
   */
  private analyzeToken(data: GoPlusTokenResponse, chainId?: number, address?: string): TokenSecurityResult {
    // -------------------------------------------------------------------------
    // TRUST LIST CHECK - GoPlus verified mainstream tokens
    // If token is in trust_list, return safe immediately.
    // Tokens like USDT, USDC have "risky" features (blacklist, pause)
    // but they are legitimate and operated by regulated entities.
    //
    // Exception: hard scam signals are NEVER masked by the trust list. A
    // poisoned or mislabeled trust_list entry must not buy a honeypot a
    // "safe" badge — if any of these flags is set, fall through to the full
    // analysis. Genuine trust-listed tokens never carry them, so the fast
    // path is preserved for USDT/USDC.
    // -------------------------------------------------------------------------
    const hasHardScamFlag =
      data.is_honeypot === '1' ||
      data.cannot_sell_all === '1' ||
      data.is_airdrop_scam === '1' ||
      !!data.fake_token;

    if (data.trust_list === '1' && !hasHardScamFlag) {
      return {
        riskLevel: 'safe',
        hardBlock: false,
        riskScore: 0,
        risks: [],
        positives: [{
          type: 'good',
          icon: 'verified',
          message: 'Verified mainstream token',
          field: 'trust_list',
        }],
        raw: data,
        isTrusted: true,
      };
    }

    const risks: RiskItem[] = [];
    const positives: RiskItem[] = [];
    let riskScore = 0;
    let hasCriticalRisk = false;
    let hasHighRisk = false;

    // Curated real-world assets (PAXG, XAUT, ONDO, …) are issued by regulated
    // entities whose contracts NEED mint/pause/blacklist powers — the same
    // powers GoPlus trust-lists USDT/USDC for. Flagging them as scam signals
    // produced "PAXG is high risk" nonsense. Centralization flags below are
    // downgraded to informational for these symbols; market-integrity flags
    // (honeypot, taxes, fake_token, liquidity, concentration) are NOT
    // softened — a squatter naming itself "PAXG" still gets caught by those.
    // Curated commodities/treasuries by symbol, tokenized stocks by family
    // shape (symbol+name; price isn't part of the GoPlus payload). Both are
    // regulated issuances whose compliance controls are expected features.
    // A pinned flagship symbol with the WRONG contract address is an
    // impostor — it must get the full hostile scoring, never the carve-out.
    const pinVerdict =
      chainId != null && address
        ? rwaPinVerdict(data.token_symbol || '', chainId, address)
        : 'unpinned';
    // Carve-out applies ONLY to an address-verified pin (pinVerdict==='match')
    // OR a family-shaped token on a chain where that family actually issues
    // (chain-enforced via the strict guard). A family-shaped name on the WRONG
    // chain, or a flagship SYMBOL with no address pin, gets NO carve-out — that
    // was the hole: a fake "xStock" on an unrelated chain previously scored low.
    const isCuratedRwa =
      pinVerdict === 'match' ||
      (chainId != null &&
        matchesRwaStockFamily(data.token_symbol || '', data.token_name || '', { chainId }) !== null);
    let hasIssuerControls = false;

    // Renounced ownership: docs say owner-gated functionality is "most
    // likely disabled" when the owner is empty or a black-hole address.
    // Without this, PEPE (owner = 0x0, $9.8M liquidity, 559k holders)
    // scored "High Risk" purely for a dead blacklist function.
    const owner = (data.owner_address || '').toLowerCase();
    const isRenounced =
      (owner === '' ||
        owner === '0x0000000000000000000000000000000000000000' ||
        owner === '0x000000000000000000000000000000000000dead') &&
      data.hidden_owner !== '1' &&
      data.can_take_back_ownership !== '1';

    // -------------------------------------------------------------------------
    // CRITICAL RISKS - These are deal-breakers
    // -------------------------------------------------------------------------

    if (data.is_honeypot === '1') {
      risks.push({
        type: 'critical',
        icon: 'block',
        message: 'Honeypot detected - you will NOT be able to sell',
        field: 'is_honeypot',
      });
      riskScore += 100;
      hasCriticalRisk = true;
    }

    if (data.cannot_sell_all === '1') {
      risks.push({
        type: 'critical',
        icon: 'lock',
        message: 'Cannot sell all tokens - partial rug pull risk',
        field: 'cannot_sell_all',
      });
      riskScore += 80;
      hasCriticalRisk = true;
    }

    if (data.fake_token?.value === 1) {
      risks.push({
        type: 'critical',
        icon: 'warning',
        message: `SCAM: counterfeit of ${data.token_symbol || 'a known token'}${data.fake_token.true_token_address ? ` (genuine: ${data.fake_token.true_token_address})` : ''}`,
        field: 'fake_token',
      });
      riskScore += 100;
      hasCriticalRisk = true;
    }

    // Prior honeypots by the same deployer — serial-scammer fingerprint.
    if (parseInt(data.honeypot_with_same_creator || '0', 10) > 0) {
      risks.push({
        type: 'high',
        icon: 'person_alert',
        message: 'Creator has deployed honeypot tokens before',
        field: 'honeypot_with_same_creator',
      });
      riskScore += 45;
      hasHighRisk = true;
    }

    if (data.gas_abuse === '1') {
      risks.push({
        type: 'high',
        icon: 'local_gas_station',
        message: 'Gas abuse: interactions mint assets at your expense',
        field: 'gas_abuse',
      });
      riskScore += 40;
      hasHighRisk = true;
    }

    if (data.cannot_buy === '1') {
      risks.push({
        type: 'medium',
        icon: 'remove_shopping_cart',
        message: 'Token cannot be bought - the swap may revert',
        field: 'cannot_buy',
      });
      riskScore += 15;
    }

    if (data.is_anti_whale === '1' && data.anti_whale_modifiable === '1') {
      risks.push({
        type: 'medium',
        icon: 'tune',
        message: 'Modifiable anti-whale limit - owner can block all trades',
        field: 'anti_whale_modifiable',
      });
      riskScore += 10;
    }

    if (data.is_airdrop_scam === '1') {
      risks.push({
        type: 'critical',
        icon: 'dangerous',
        message: 'Known airdrop scam - do NOT interact',
        field: 'is_airdrop_scam',
      });
      riskScore += 100;
      hasCriticalRisk = true;
    }

    // -------------------------------------------------------------------------
    // LIQUIDITY CHECK - Critical for new/unknown tokens
    // -------------------------------------------------------------------------

    let liquidityUSD = 0;
    if (data.dex && data.dex.length > 0) {
      liquidityUSD = data.dex.reduce((sum, d) => sum + parseFloat(d.liquidity || '0'), 0);
    }

    // Liquidity < $1000 is CRITICAL regardless of other factors
    if (liquidityUSD > 0 && liquidityUSD < 1000) {
      risks.push({
        type: 'critical',
        icon: 'water_drop',
        message: `Only $${liquidityUSD.toFixed(0)} liquidity - extremely high rug pull risk`,
        field: 'dex',
      });
      riskScore += 80;
      hasCriticalRisk = true;
    } else if (liquidityUSD >= 1000 && liquidityUSD < 10000) {
      risks.push({
        type: 'high',
        icon: 'water_drop',
        message: `Low liquidity: $${liquidityUSD.toFixed(0)} - high slippage & rug risk`,
        field: 'dex',
      });
      riskScore += 40;
      hasHighRisk = true;
    } else if (liquidityUSD >= 10000 && liquidityUSD < 50000) {
      risks.push({
        type: 'medium',
        icon: 'water_drop',
        message: `Moderate liquidity: $${(liquidityUSD / 1000).toFixed(1)}K`,
        field: 'dex',
      });
      riskScore += 15;
    }
    // Good liquidity ($50K+) will be added to positives later

    // -------------------------------------------------------------------------
    // HIGH RISKS
    // -------------------------------------------------------------------------

    if (data.is_open_source === '0') {
      risks.push({
        type: 'high',
        icon: 'visibility_off',
        message: 'Unverified contract - cannot audit code',
        field: 'is_open_source',
      });
      riskScore += 35;
      hasHighRisk = true;
    }

    if (data.owner_change_balance === '1') {
      if (isRenounced && !isCuratedRwa) {
        risks.push({
          type: 'info',
          icon: 'edit',
          message: 'Balance-modify function exists but ownership is renounced',
          field: 'owner_change_balance',
        });
        riskScore += 5;
      } else if (pinVerdict === 'match') {
        // Theft-flag downgrade requires an ADDRESS-VERIFIED pin, not just a
        // chain-shaped family match: "owner can modify balances" is direct
        // loss-of-funds, so a non-pinned family-shaped token keeps the critical
        // verdict below. (Other, non-theft carve-outs stay keyed on isCuratedRwa.)
        risks.push({
          type: 'info',
          icon: 'account_balance',
          message: 'Issuer can freeze or seize balances (regulatory power, standard for custodial assets)',
          field: 'owner_change_balance',
        });
        riskScore += 10;
        hasIssuerControls = true;
      } else {
        risks.push({
          type: 'critical',
          icon: 'edit',
          message: 'Owner can steal your tokens (modify balances)',
          field: 'owner_change_balance',
        });
        riskScore += 80;
        hasCriticalRisk = true;
      }
    }

    if (data.hidden_owner === '1') {
      risks.push({
        type: 'high',
        icon: 'person_off',
        message: 'Hidden owner - suspicious contract structure',
        field: 'hidden_owner',
      });
      riskScore += 40;
      hasHighRisk = true;
    }

    if (data.selfdestruct === '1') {
      risks.push({
        type: 'high',
        icon: 'delete_forever',
        message: 'Contract can self-destruct (destroy all tokens)',
        field: 'selfdestruct',
      });
      riskScore += 35;
      hasHighRisk = true;
    }

    if (data.is_blacklisted === '1') {
      if (isRenounced && !isCuratedRwa) {
        risks.push({
          type: 'info',
          icon: 'block',
          message: 'Blacklist function exists but ownership is renounced (cannot be invoked)',
          field: 'is_blacklisted',
        });
        riskScore += 3;
      } else if (isCuratedRwa) {
        risks.push({
          type: 'info',
          icon: 'policy',
          message: 'Compliance blacklist (sanctions screening, standard for regulated issuers)',
          field: 'is_blacklisted',
        });
        riskScore += 5;
        hasIssuerControls = true;
      } else {
        risks.push({
          type: 'high',
          icon: 'block',
          message: 'Blacklist function - you could be blocked from selling',
          field: 'is_blacklisted',
        });
        riskScore += 30;
        hasHighRisk = true;
      }
    }

    // Check taxes. Docs: '' means UNKNOWN (not zero) — flag it on tokens
    // that do trade on a DEX, where a tax read should have been possible.
    const buyTax = parseFloat(data.buy_tax || '0');
    const sellTax = parseFloat(data.sell_tax || '0');

    if (data.sell_tax === '' && data.is_in_dex === '1') {
      risks.push({
        type: 'info',
        icon: 'payments',
        message: 'Sell tax could not be determined',
        field: 'sell_tax',
      });
      riskScore += 5;
    }

    if (sellTax > 0.5) {
      // >50% sell tax is essentially a honeypot
      risks.push({
        type: 'critical',
        icon: 'payments',
        message: `${(sellTax * 100).toFixed(0)}% sell tax - effectively unsellable`,
        field: 'sell_tax',
      });
      riskScore += 80;
      hasCriticalRisk = true;
    } else if (sellTax > 0.1) {
      risks.push({
        type: 'high',
        icon: 'payments',
        message: `High sell tax: ${(sellTax * 100).toFixed(1)}%`,
        field: 'sell_tax',
      });
      riskScore += 30;
      hasHighRisk = true;
    } else if (sellTax > 0.05) {
      risks.push({
        type: 'medium',
        icon: 'payments',
        message: `Sell tax: ${(sellTax * 100).toFixed(1)}%`,
        field: 'sell_tax',
      });
      riskScore += 15;
    }

    if (buyTax > 0.1) {
      risks.push({
        type: 'high',
        icon: 'payments',
        message: `High buy tax: ${(buyTax * 100).toFixed(1)}%`,
        field: 'buy_tax',
      });
      riskScore += 20;
      hasHighRisk = true;
    }

    // -------------------------------------------------------------------------
    // MEDIUM RISKS
    // -------------------------------------------------------------------------

    if (data.is_mintable === '1') {
      if (isRenounced && !isCuratedRwa) {
        risks.push({
          type: 'info',
          icon: 'add_circle',
          message: 'Mint function exists but ownership is renounced',
          field: 'is_mintable',
        });
        riskScore += 3;
      } else if (isCuratedRwa) {
        risks.push({
          type: 'info',
          icon: 'add_circle',
          message: 'Mintable: supply grows as the issuer tokenizes new reserves',
          field: 'is_mintable',
        });
        riskScore += 3;
        hasIssuerControls = true;
      } else {
        risks.push({
          type: 'medium',
          icon: 'add_circle',
          message: 'Mintable - supply can be inflated',
          field: 'is_mintable',
        });
        riskScore += 15;
      }
    }

    if (data.is_proxy === '1') {
      if (isCuratedRwa) {
        risks.push({
          type: 'info',
          icon: 'swap_horiz',
          message: 'Upgradeable contract (issuer-managed, common for regulated assets)',
          field: 'is_proxy',
        });
        riskScore += 3;
        hasIssuerControls = true;
      } else {
        risks.push({
          type: 'medium',
          icon: 'swap_horiz',
          message: 'Proxy contract - code can be changed',
          field: 'is_proxy',
        });
        riskScore += 20;
      }
    }

    if (data.slippage_modifiable === '1') {
      if (isRenounced) {
        risks.push({
          type: 'info',
          icon: 'tune',
          message: 'Fee-modify function exists but ownership is renounced',
          field: 'slippage_modifiable',
        });
        riskScore += 3;
      } else {
        risks.push({
          type: 'high',
          icon: 'tune',
          message: 'Owner can increase fees at any time',
          field: 'slippage_modifiable',
        });
        riskScore += 30;
        hasHighRisk = true;
      }
    }

    if (data.transfer_pausable === '1') {
      if (isRenounced && !isCuratedRwa) {
        risks.push({
          type: 'info',
          icon: 'pause_circle',
          message: 'Pause function exists but ownership is renounced',
          field: 'transfer_pausable',
        });
        riskScore += 3;
      } else if (isCuratedRwa) {
        risks.push({
          type: 'info',
          icon: 'pause_circle',
          message: 'Issuer can pause transfers (regulatory circuit breaker)',
          field: 'transfer_pausable',
        });
        riskScore += 5;
        hasIssuerControls = true;
      } else {
        risks.push({
          type: 'high',
          icon: 'pause_circle',
          message: 'Transfers can be frozen by owner',
          field: 'transfer_pausable',
        });
        riskScore += 25;
        hasHighRisk = true;
      }
    }

    if (data.can_take_back_ownership === '1') {
      if (isCuratedRwa) {
        risks.push({
          type: 'info',
          icon: 'undo',
          message: 'Issuer retains administrative ownership controls',
          field: 'can_take_back_ownership',
        });
        riskScore += 3;
        hasIssuerControls = true;
      } else {
        risks.push({
          type: 'medium',
          icon: 'undo',
          message: 'Ownership can be reclaimed',
          field: 'can_take_back_ownership',
        });
        riskScore += 15;
      }
    }

    if (data.personal_slippage_modifiable === '1') {
      if (isRenounced) {
        risks.push({
          type: 'info',
          icon: 'person_pin',
          message: 'Per-address tax function exists but ownership is renounced',
          field: 'personal_slippage_modifiable',
        });
        riskScore += 3;
      } else {
        risks.push({
          type: 'high',
          icon: 'person_pin',
          message: 'Owner can set custom tax for your address',
          field: 'personal_slippage_modifiable',
        });
        riskScore += 30;
        hasHighRisk = true;
      }
    }

    if (data.trading_cooldown === '1') {
      risks.push({
        type: 'info',
        icon: 'timer',
        message: 'Trading cooldown between transactions',
        field: 'trading_cooldown',
      });
      riskScore += 5;
    }

    // Holder concentration (GoPlus returns decimal: 0.1 = 10%, 1.0 = 100%)
    const ownerPercent = parseFloat(data.owner_percent || '0');
    const creatorPercent = parseFloat(data.creator_percent || '0');
    const concentrationPercent = Math.max(ownerPercent, creatorPercent);

    if (concentrationPercent > 0.8) {
      risks.push({
        type: 'critical',
        icon: 'pie_chart',
        message: `${(concentrationPercent * 100).toFixed(0)}% held by one wallet - rug pull imminent`,
        field: 'owner_percent',
      });
      riskScore += 60;
      hasCriticalRisk = true;
    } else if (concentrationPercent > 0.5) {
      risks.push({
        type: 'high',
        icon: 'pie_chart',
        message: `${(concentrationPercent * 100).toFixed(0)}% held by one wallet`,
        field: 'owner_percent',
      });
      riskScore += 30;
      hasHighRisk = true;
    } else if (concentrationPercent > 0.2) {
      risks.push({
        type: 'medium',
        icon: 'pie_chart',
        message: `${(concentrationPercent * 100).toFixed(0)}% holder concentration`,
        field: 'owner_percent',
      });
      riskScore += 10;
    }

    // Low holder count is risky
    const holderCount = parseInt(data.holder_count || '0', 10);
    if (holderCount > 0 && holderCount < 50) {
      risks.push({
        type: 'high',
        icon: 'group',
        message: `Only ${holderCount} holders - very new/risky token`,
        field: 'holder_count',
      });
      riskScore += 25;
      hasHighRisk = true;
    } else if (holderCount >= 50 && holderCount < 200) {
      risks.push({
        type: 'medium',
        icon: 'group',
        message: `Only ${holderCount} holders`,
        field: 'holder_count',
      });
      riskScore += 10;
    }

    // -------------------------------------------------------------------------
    // POSITIVE INDICATORS - only shown, NOT reducing score if critical/high risks
    // -------------------------------------------------------------------------

    const isTrusted = data.trust_list === '1';

    if (isTrusted) {
      positives.push({
        type: 'good',
        icon: 'verified',
        message: 'Verified mainstream token',
        field: 'trust_list',
      });
      // Only reduce score if no critical/high risks
      if (!hasCriticalRisk && !hasHighRisk) {
        riskScore = Math.max(0, riskScore - 40);
      }
    }

    // Verified source is expected, not a bonus - only show if no risks
    if (data.is_open_source === '1' && !hasCriticalRisk) {
      positives.push({
        type: 'good',
        icon: 'code',
        message: 'Contract source verified',
        field: 'is_open_source',
      });
    }

    // Good liquidity is a positive
    if (liquidityUSD >= 100000) {
      positives.push({
        type: 'good',
        icon: 'water_drop',
        message: `$${(liquidityUSD / 1000).toFixed(0)}K liquidity`,
        field: 'dex',
      });
      if (!hasCriticalRisk && !hasHighRisk) {
        riskScore = Math.max(0, riskScore - 10);
      }
    } else if (liquidityUSD >= 50000) {
      positives.push({
        type: 'good',
        icon: 'water_drop',
        message: `$${(liquidityUSD / 1000).toFixed(0)}K liquidity`,
        field: 'dex',
      });
    }

    // High holder count is good
    if (holderCount >= 10000) {
      positives.push({
        type: 'good',
        icon: 'groups',
        message: `${holderCount.toLocaleString()} holders`,
        field: 'holder_count',
      });
      if (!hasCriticalRisk && !hasHighRisk) {
        riskScore = Math.max(0, riskScore - 10);
      }
    } else if (holderCount >= 1000) {
      positives.push({
        type: 'good',
        icon: 'groups',
        message: `${holderCount.toLocaleString()} holders`,
        field: 'holder_count',
      });
    }

    // Curated RWA context: tell the user WHY the flags above are framed as
    // expected instead of leaving an unexplained mix of info rows.
    if (isCuratedRwa && hasIssuerControls && !hasCriticalRisk) {
      positives.push({
        type: 'good',
        icon: 'account_balance',
        message: 'Recognized real-world asset: issuer compliance controls are expected for this asset class',
      });
    }

    // Active DEX market (note: is_in_dex is a DEX field, not CEX)
    if (data.is_in_dex === '1' && liquidityUSD >= 50000) {
      positives.push({
        type: 'good',
        icon: 'swap_calls',
        message: 'Active DEX trading',
        field: 'is_in_dex',
      });
    }

    // Major-CEX listing — docs call this "widely trusted within the
    // industry, with relatively low risk"; the recommended trust signal
    // to combine with trust_list.
    if (data.is_in_cex?.listed === '1') {
      const cexNames = (data.is_in_cex.cex_list || []).slice(0, 3).join(', ');
      positives.push({
        type: 'good',
        icon: 'account_balance',
        message: cexNames ? `Listed on major exchanges (${cexNames})` : 'Listed on major exchanges',
        field: 'is_in_cex',
      });
      if (!hasCriticalRisk && !hasHighRisk) {
        riskScore = Math.max(0, riskScore - 15);
      }
    }

    if (isRenounced) {
      positives.push({
        type: 'good',
        icon: 'lock_open',
        message: 'Ownership renounced - owner-only functions are disabled',
        field: 'owner_address',
      });
    }

    // -------------------------------------------------------------------------
    // FINAL RISK LEVEL CALCULATION
    // Critical risks ALWAYS result in critical level
    // -------------------------------------------------------------------------

    let riskLevel: RiskLevel;
    if (hasCriticalRisk) {
      riskLevel = 'critical';
      riskScore = Math.max(riskScore, 80); // Ensure score matches
    } else if (hasHighRisk) {
      riskLevel = 'high';
      riskScore = Math.max(riskScore, 50);
    } else {
      riskLevel = this.calculateRiskLevel(riskScore);
    }

    // Deterministic unsellable-token verdict. Narrower than `critical` on
    // purpose: critical also covers heuristics an informed user may accept
    // (liquidity, concentration); these four flags mean GoPlus *observed*
    // the token cannot be (fully) sold — no acknowledgement makes that swap
    // anything but a loss, so the UI hard-disables it.
    const hardBlock =
      data.is_honeypot === '1' ||
      data.cannot_sell_all === '1' ||
      data.fake_token?.value === 1 ||
      sellTax > 0.5;

    return {
      riskLevel,
      hardBlock,
      riskScore: Math.min(100, riskScore),
      risks,
      positives,
      raw: data,
      isTrusted,
      holderCount,
      liquidityUSD,
    };
  }

  /**
   * Calculate risk level from score
   */
  private calculateRiskLevel(score: number): RiskLevel {
    if (score >= 80) return 'critical';
    if (score >= 50) return 'high';
    if (score >= 25) return 'medium';
    if (score >= 10) return 'low';
    return 'safe';
  }

  /**
   * Get higher of two risk levels
   */
  private getHigherRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
    const order: RiskLevel[] = ['safe', 'low', 'unknown', 'medium', 'high', 'critical'];
    return order.indexOf(a) > order.indexOf(b) ? a : b;
  }

  /**
   * Check if address is native token
   */
  private isNativeToken(address: string): boolean {
    const addr = address.toLowerCase();
    return (
      addr === '0x0000000000000000000000000000000000000000' ||
      addr === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    );
  }

  /**
   * Create a safe result for trusted tokens
   */
  private createSafeResult(): TokenSecurityResult {
    return {
      riskLevel: 'safe',
      hardBlock: false,
      riskScore: 0,
      risks: [],
      positives: [],
      isTrusted: true,
    };
  }

  /**
   * Honest "could not verify" result. Deliberately NOT 'low': a rate-limited
   * check of a honeypot must not render as a calming green — 'unknown' maps
   * to the neutral/caution visual tier and never gates as safe.
   */
  private createUnknownResult(message: string = 'Security data not available'): TokenSecurityResult {
    return {
      riskLevel: 'unknown',
      // No verdict ≠ proven scam: 'unknown' fails closed at the ACK tier
      // (the swap UI requires an explicit risk acknowledgement), not at the
      // hard-block tier — hard blocks are reserved for observed facts.
      hardBlock: false,
      riskScore: 0,
      risks: [{
        type: 'info',
        icon: 'help',
        message,
      }],
      positives: [],
      isTrusted: false,
    };
  }

  // ---------------------------------------------------------------------------
  // UI Helpers
  // ---------------------------------------------------------------------------

  /**
   * Get display info for risk level
   */
  getRiskLevelInfo(level: RiskLevel): {
    label: string;
    color: string;
    bgColor: string;
    borderColor: string;
    icon: string;
  } {
    switch (level) {
      case 'safe':
        return {
          label: 'Safe',
          color: 'text-emerald-400',
          bgColor: 'bg-emerald-500/10',
          borderColor: 'border-emerald-500/20',
          icon: 'verified_user',
        };
      case 'low':
        return {
          label: 'Low Risk',
          color: 'text-green-400',
          bgColor: 'bg-green-500/10',
          borderColor: 'border-green-500/20',
          icon: 'check_circle',
        };
      case 'medium':
        return {
          label: 'Medium Risk',
          color: 'text-yellow-400',
          bgColor: 'bg-yellow-500/10',
          borderColor: 'border-yellow-500/20',
          icon: 'warning',
        };
      case 'high':
        return {
          label: 'High Risk',
          color: 'text-orange-400',
          bgColor: 'bg-orange-500/10',
          borderColor: 'border-orange-500/20',
          icon: 'error',
        };
      case 'critical':
        return {
          label: 'Critical Risk',
          color: 'text-red-400',
          bgColor: 'bg-red-500/10',
          borderColor: 'border-red-500/20',
          icon: 'dangerous',
        };
      case 'unknown':
        return {
          label: 'Not verified',
          color: 'text-slate-400',
          bgColor: 'bg-slate-500/10',
          borderColor: 'border-slate-500/20',
          icon: 'help',
        };
    }
  }
}
