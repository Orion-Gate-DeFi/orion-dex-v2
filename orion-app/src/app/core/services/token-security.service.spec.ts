/**
 * =============================================================================
 * TOKEN SECURITY SERVICE TESTS
 * =============================================================================
 *
 * Unit tests for TokenSecurityService that integrates with GoPlus API
 * to detect honeypots, scams, and other token risks.
 *
 * Test categories:
 * - getRiskLevelInfo: UI display helpers for risk levels
 * - checkTokenSecurity: Native tokens and API integration
 * - Risk Scoring Logic: Critical, high, medium risks detection
 * - checkSwapPairSecurity: Checking both tokens in a swap
 * - Cache management
 */

import { TestBed } from '@angular/core/testing';
import { TokenSecurityService, TokenSecurityResult, RiskLevel } from './token-security.service';

describe('TokenSecurityService', () => {
  let service: TokenSecurityService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [TokenSecurityService]
    });
    service = TestBed.inject(TokenSecurityService);
    service.clearCache();
  });

  describe('getRiskLevelInfo', () => {
    it('should return correct info for safe level', () => {
      const info = service.getRiskLevelInfo('safe');
      expect(info.label).toBe('Safe');
      expect(info.icon).toBe('verified_user');
      expect(info.color).toContain('emerald');
    });

    it('should return correct info for low level', () => {
      const info = service.getRiskLevelInfo('low');
      expect(info.label).toBe('Low Risk');
      expect(info.icon).toBe('check_circle');
    });

    it('should return correct info for medium level', () => {
      const info = service.getRiskLevelInfo('medium');
      expect(info.label).toBe('Medium Risk');
      expect(info.icon).toBe('warning');
    });

    it('should return correct info for high level', () => {
      const info = service.getRiskLevelInfo('high');
      expect(info.label).toBe('High Risk');
      expect(info.icon).toBe('error');
    });

    it('should return correct info for critical level', () => {
      const info = service.getRiskLevelInfo('critical');
      expect(info.label).toBe('Critical Risk');
      expect(info.icon).toBe('dangerous');
      expect(info.color).toContain('red');
    });
  });

  describe('checkTokenSecurity - Native Tokens', () => {
    it('should return safe result for native token (zero address)', async () => {
      const result = await service.checkTokenSecurity(1, '0x0000000000000000000000000000000000000000');
      expect(result.riskLevel).toBe('safe');
      expect(result.isTrusted).toBe(true);
      expect(result.positives.length).toBeGreaterThan(0);
      expect(result.positives[0].message).toContain('Native');
    });

    it('should return safe result for native token (0xeee address)', async () => {
      const result = await service.checkTokenSecurity(42161, '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
      expect(result.riskLevel).toBe('safe');
      expect(result.isTrusted).toBe(true);
    });
  });

  describe('checkTokenSecurity - Unsupported Chain', () => {
    it('should return unknown result for unsupported chain', async () => {
      const result = await service.checkTokenSecurity(999999, '0x1234567890123456789012345678901234567890');
      // Intended behaviour change (docs audit): failures are an honest
      // 'unknown', never a calming green 'low'.
      expect(result.riskLevel).toBe('unknown');
      expect(result.risks[0].message).toContain('not available');
    });
  });

  describe('checkTokenSecurity - API Integration', () => {
    it('should handle API errors gracefully', async () => {
      // Mock fetch to simulate 500 error
      spyOn(window, 'fetch').and.returnValue(
        Promise.resolve({
          ok: false,
          status: 500,
        } as Response)
      );

      const result = await service.checkTokenSecurity(1, '0x1234567890123456789012345678901234567890');

      // Should return "unknown" result with low risk
      expect(result.riskLevel).toBe('unknown');
      expect(result.risks.length).toBeGreaterThan(0);
    });

    it('should cache results', async () => {
      const mockResponse = {
        code: 1,
        message: 'OK',
        result: {
          '0x1234567890123456789012345678901234567890': {
            is_open_source: '1',
            is_honeypot: '0',
            trust_list: '1',
            holder_count: '10000',
            dex: [{ name: 'Uniswap', liquidity: '1000000', pair: '0x...' }],
          }
        }
      };

      const fetchSpy = spyOn(window, 'fetch').and.returnValue(
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        } as Response)
      );

      // First call - should fetch from API
      await service.checkTokenSecurity(1, '0x1234567890123456789012345678901234567890');
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Second call - should use cache (no additional fetch)
      await service.checkTokenSecurity(1, '0x1234567890123456789012345678901234567890');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Risk Scoring Logic', () => {
    let analyzeToken: (data: any) => TokenSecurityResult;

    beforeEach(() => {
      // Access private method for testing
      analyzeToken = (service as any).analyzeToken.bind(service);
    });

    it('should mark honeypot as critical', () => {
      const result = analyzeToken({ is_honeypot: '1' });
      expect(result.riskLevel).toBe('critical');
      expect(result.risks.some(r => r.message.toLowerCase().includes('honeypot'))).toBe(true);
    });

    it('should mark very low liquidity (<$1000) as critical', () => {
      const result = analyzeToken({
        dex: [{ name: 'Uniswap', liquidity: '500', pair: '0x...' }]
      });
      expect(result.riskLevel).toBe('critical');
      expect(result.risks.some(r => r.message.includes('500'))).toBe(true);
    });

    it('should mark low liquidity ($1000-$10000) as high risk', () => {
      const result = analyzeToken({
        dex: [{ name: 'Uniswap', liquidity: '5000', pair: '0x...' }]
      });
      expect(result.riskLevel).toBe('high');
    });

    it('should mark fake token as critical', () => {
      // Docs shape: { value: 1, true_token_address } — not name/symbol.
      const result = analyzeToken({
        token_symbol: 'USDT',
        fake_token: { value: 1, true_token_address: '0xdac17f958d2ee523a2206206994597c13d831ec7' },
      });
      expect(result.riskLevel).toBe('critical');
      expect(result.risks.some(r => r.message.toLowerCase().includes('scam') || r.message.toLowerCase().includes('counterfeit'))).toBe(true);
    });

    it('should mark airdrop scam as critical', () => {
      const result = analyzeToken({ is_airdrop_scam: '1' });
      expect(result.riskLevel).toBe('critical');
    });

    it('should mark owner_change_balance as critical', () => {
      // Owner-gated flags need a live owner — empty owner_address means
      // renounced per GoPlus docs and is deliberately downgraded.
      const result = analyzeToken({ owner_address: '0x1111111111111111111111111111111111111111', owner_change_balance: '1' });
      expect(result.riskLevel).toBe('critical');
      expect(result.risks.some(r => r.message.toLowerCase().includes('steal') || r.message.toLowerCase().includes('balance'))).toBe(true);
    });

    it('should mark unverified contract as high risk', () => {
      const result = analyzeToken({ is_open_source: '0' });
      expect(result.riskLevel).toBe('high');
    });

    describe('hardBlock (deterministic unsellable-token flags)', () => {
      it('sets hardBlock for each of the four unsellable signals', () => {
        expect(analyzeToken({ is_honeypot: '1' }).hardBlock).toBeTrue();
        expect(analyzeToken({ cannot_sell_all: '1' }).hardBlock).toBeTrue();
        expect(analyzeToken({ fake_token: { value: 1 } }).hardBlock).toBeTrue();
        expect(analyzeToken({ sell_tax: '0.6' }).hardBlock).toBeTrue();
      });

      it('keeps hardBlock false for acknowledgeable critical heuristics', () => {
        // Critical-but-arguable signals (low liquidity, concentration,
        // airdrop list) stay at the ack tier — hardBlock is reserved for
        // "you mechanically cannot sell this".
        const lowLiquidity = analyzeToken({
          dex: [{ name: 'Uniswap', liquidity: '500', pair: '0x...' }],
        });
        expect(lowLiquidity.riskLevel).toBe('critical');
        expect(lowLiquidity.hardBlock).toBeFalse();

        const concentrated = analyzeToken({ owner_percent: '0.85' });
        expect(concentrated.riskLevel).toBe('critical');
        expect(concentrated.hardBlock).toBeFalse();
      });

      it('does not hard-block on a sub-threshold sell tax', () => {
        expect(analyzeToken({ sell_tax: '0.15' }).hardBlock).toBeFalse();
      });

      it('hard-blocks a honeypot even when GoPlus trust-lists it', () => {
        // A poisoned trust_list entry must not buy a honeypot a safe badge
        // (the fast path falls through on hard scam flags).
        const result = analyzeToken({ trust_list: '1', is_honeypot: '1' });
        expect(result.hardBlock).toBeTrue();
        expect(result.riskLevel).toBe('critical');
      });
    });

    it('should mark high sell tax (>50%) as critical', () => {
      const result = analyzeToken({ sell_tax: '0.6' });
      expect(result.riskLevel).toBe('critical');
      expect(result.risks.some(r => r.message.includes('60%'))).toBe(true);
    });

    it('should mark medium sell tax (10-50%) as high risk', () => {
      const result = analyzeToken({ sell_tax: '0.15' });
      expect(result.riskLevel).toBe('high');
    });

    it('should mark high holder concentration (>80%) as critical', () => {
      // GoPlus returns decimal: 0.85 = 85%
      const result = analyzeToken({ owner_percent: '0.85' });
      expect(result.riskLevel).toBe('critical');
      expect(result.risks.some(r => r.message.includes('85%'))).toBe(true);
    });

    it('should mark low holder count (<50) as high risk', () => {
      const result = analyzeToken({ holder_count: '25' });
      expect(result.riskLevel).toBe('high');
      expect(result.risks.some(r => r.message.includes('25 holders'))).toBe(true);
    });

    it('should mark blacklist function as high risk', () => {
      const result = analyzeToken({ owner_address: '0x1111111111111111111111111111111111111111', is_blacklisted: '1' });
      expect(result.riskLevel).toBe('high');
    });

    it('should mark transfer_pausable as high risk', () => {
      const result = analyzeToken({ owner_address: '0x1111111111111111111111111111111111111111', transfer_pausable: '1' });
      expect(result.riskLevel).toBe('high');
    });

    it('should downgrade owner-gated flags when ownership is renounced', () => {
      const result = analyzeToken({
        owner_address: '0x0000000000000000000000000000000000000000',
        is_blacklisted: '1',
        transfer_pausable: '1',
        is_mintable: '1',
      });
      // PEPE-class token: dead owner functions must not paint "High Risk".
      expect(['safe', 'low']).toContain(result.riskLevel);
      expect(result.positives.some(p => p.message.toLowerCase().includes('renounced'))).toBe(true);
    });

    it('should NOT apply the renounce downgrade when ownership can be reclaimed', () => {
      const result = analyzeToken({
        owner_address: '',
        can_take_back_ownership: '1',
        is_blacklisted: '1',
      });
      expect(result.riskLevel).toBe('high');
    });

    it('no longer carves out tokenized-stock families (removed from RWA scope 2026-06-20)', () => {
      const analyzeWithAddr = (service as any).analyzeToken.bind(service) as
        (d: unknown, chainId?: number, address?: string) => TokenSecurityResult;
      // Tokenized equities (xStocks/bTokens) were dropped: RWA_STOCK_FAMILIES is
      // now empty, so a stock-shaped symbol gets NO issuer-controls carve-out and
      // is judged on its raw GoPlus flags like any other token. mint + pause on a
      // non-renounced owner must therefore surface as real (non-info) risk.
      const result = analyzeWithAddr({
        token_symbol: 'bTSLA',
        token_name: 'Backed Tesla Inc',
        owner_address: '0x1111111111111111111111111111111111111111',
        is_mintable: '1',
        transfer_pausable: '1',
      }, 1);
      expect(result.riskLevel).not.toBe('safe');
      expect(result.risks.some(r => r.type !== 'info')).toBe(true);
    });

    it('should NOT extend the stock carve-out to squatters failing the family shape', () => {
      const result = analyzeToken({
        token_symbol: 'BBP',
        token_name: 'Backed By Pacman',
        owner_address: '0x1111111111111111111111111111111111111111',
        transfer_pausable: '1',
      });
      expect(result.riskLevel).toBe('high');
    });

    it('should deny the RWA carve-out to a pinned-symbol impostor (wrong contract)', () => {
      const analyzeWithAddr = (service as any).analyzeToken.bind(service) as
        (d: unknown, chainId?: number, address?: string) => TokenSecurityResult;
      const result = analyzeWithAddr(
        {
          token_symbol: 'PAXG',
          token_name: 'PAX Gold',
          owner_address: '0x1111111111111111111111111111111111111111',
          is_blacklisted: '1',
          transfer_pausable: '1',
        },
        1,
        '0xdeadbeef00000000000000000000000000000000', // NOT the verified PAXG contract
      );
      expect(result.riskLevel).toBe('high');
    });

    it('should keep the RWA carve-out for the genuine pinned contract', () => {
      const analyzeWithAddr = (service as any).analyzeToken.bind(service) as
        (d: unknown, chainId?: number, address?: string) => TokenSecurityResult;
      const result = analyzeWithAddr(
        {
          token_symbol: 'PAXG',
          token_name: 'PAX Gold',
          owner_address: '0x1111111111111111111111111111111111111111',
          is_blacklisted: '1',
          transfer_pausable: '1',
        },
        1,
        '0x45804880De22913dAFE09f4980848ECE6EcbAf78', // verified PAXG (case-insensitive)
      );
      expect(result.risks.every(r => r.type === 'info')).toBe(true);
      expect(['safe', 'low', 'medium']).toContain(result.riskLevel);
    });

    it('denies the RWA carve-out to a family-shaped fake on a non-family chain', () => {
      const analyzeWithAddr = (service as any).analyzeToken.bind(service) as
        (d: unknown, chainId?: number, address?: string) => TokenSecurityResult;
      // Stock families are empty now, so a stock-shaped symbol gets no carve-out
      // anywhere; regardless, owner_change_balance must stay CRITICAL (direct
      // theft is never softened).
      const result = analyzeWithAddr({
        token_symbol: 'AAPLx',
        token_name: 'Apple xStock',
        owner_address: '0x1111111111111111111111111111111111111111',
        owner_change_balance: '1',
      }, 8453);
      expect(result.riskLevel).toBe('critical');
      expect(result.risks.some(r => r.type === 'critical' && /modify balances/i.test(r.message))).toBe(true);
    });

    it('keeps owner_change_balance critical for a chain-family match without a pin', () => {
      const analyzeWithAddr = (service as any).analyzeToken.bind(service) as
        (d: unknown, chainId?: number, address?: string) => TokenSecurityResult;
      // No stock family + no pin on 42161 → no carve-out at all; and even if one
      // applied, the balance-theft flag stays CRITICAL because direct theft is
      // never softened (the theft downgrade is pin-gated to pinVerdict==='match').
      const result = analyzeWithAddr({
        token_symbol: 'bTSLA',
        token_name: 'Backed Tesla Inc',
        owner_address: '0x1111111111111111111111111111111111111111',
        owner_change_balance: '1',
        transfer_pausable: '1',
      }, 42161, '0x2222222222222222222222222222222222222222');
      expect(result.riskLevel).toBe('critical');
      expect(result.risks.some(r => r.type === 'critical' && /modify balances/i.test(r.message))).toBe(true);
    });

    it('should add positive for trusted token', () => {
      const result = analyzeToken({
        trust_list: '1',
        is_open_source: '1',
        holder_count: '50000',
        dex: [{ name: 'Uniswap', liquidity: '10000000', pair: '0x...' }]
      });
      expect(result.isTrusted).toBe(true);
      expect(result.positives.some(p => p.message.toLowerCase().includes('verified'))).toBe(true);
    });

    it('should add positive for high liquidity', () => {
      const result = analyzeToken({
        dex: [{ name: 'Uniswap', liquidity: '150000', pair: '0x...' }]
      });
      expect(result.positives.some(p => p.message.includes('150K'))).toBe(true);
    });

    it('should add positive for high holder count', () => {
      const result = analyzeToken({
        holder_count: '15000',
        dex: [{ name: 'Uniswap', liquidity: '100000', pair: '0x...' }]
      });
      expect(result.positives.some(p => p.message.includes('15,000'))).toBe(true);
    });

    it('should NOT reduce risk score when critical risk exists despite positives', () => {
      const result = analyzeToken({
        is_honeypot: '1', // Critical
        trust_list: '1', // Positive
        holder_count: '50000', // Positive
        dex: [{ name: 'Uniswap', liquidity: '10000000', pair: '0x...' }] // Positive
      });
      // Should still be critical despite positives
      expect(result.riskLevel).toBe('critical');
      expect(result.riskScore).toBeGreaterThanOrEqual(80);
    });

    it('should NOT reduce risk score when high risk exists despite positives', () => {
      // trust_list is deliberately omitted here: trust-listed tokens
      // short-circuit to safe (product decision — GoPlus vets them), and an
      // unverified contract is not one of the hard scam flags that bypass
      // that fast path. The principle under test — positives must not mask
      // a high risk — is exercised via the holder-count and liquidity
      // positives instead.
      const result = analyzeToken({
        is_open_source: '0', // High risk - unverified
        holder_count: '50000', // Positive
        dex: [{ name: 'Uniswap', liquidity: '10000000', pair: '0x...' }] // Positive
      });
      // Should still be high risk
      expect(result.riskLevel).toBe('high');
    });
  });

  describe('checkSwapPairSecurity', () => {
    it('should check both tokens and return overall risk', async () => {
      // Mock native token for fromToken
      const result = await service.checkSwapPairSecurity(
        1, '0x0000000000000000000000000000000000000000',
        1, '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      );

      expect(result.fromToken).toBeTruthy();
      expect(result.toToken).toBeTruthy();
      expect(result.overallRisk).toBe('safe');
    });
  });

  describe('clearCache', () => {
    it('should clear specific cache entry', async () => {
      const mockResponse = {
        code: 1,
        message: 'OK',
        result: {
          '0x1234567890123456789012345678901234567890': {
            is_open_source: '1',
            dex: [{ name: 'Uniswap', liquidity: '100000', pair: '0x...' }]
          }
        }
      };

      const fetchSpy = spyOn(window, 'fetch').and.returnValue(
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        } as Response)
      );

      // First call - populates cache
      await service.checkTokenSecurity(1, '0x1234567890123456789012345678901234567890');
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Clear specific cache entry
      service.clearCache(1, '0x1234567890123456789012345678901234567890');

      // Should fetch again since cache was cleared
      await service.checkTokenSecurity(1, '0x1234567890123456789012345678901234567890');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});
