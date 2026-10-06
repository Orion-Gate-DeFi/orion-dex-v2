/**
 * =============================================================================
 * AGGREGATOR SERVICE SPEC
 * =============================================================================
 *
 * The backend takes slippage as a DECIMAL fraction (0.005 = 0.5%); the app
 * carries it as a percentage. The `/100` conversion is the single point where
 * that unit boundary is crossed, and it is duplicated across `getBestQuote`
 * and `refreshQuote` — two independent call sites that can drift apart.
 *
 * Sending the percentage verbatim would ask for 50%–150% slippage on every
 * swap (or be rejected as SWAP_INVALID_SLIPPAGE and silently demote the swap
 * to the LI.FI fallback path), so the outgoing body is asserted directly.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AggregatorService } from './aggregator.service';
import { environment } from '../../../../environments/environment';
import type { BestQuoteRequest, RefreshQuoteRequest } from '../../models/swap.model';
import type { Token } from '../../models/token.model';

describe('AggregatorService — slippage unit boundary', () => {
  const BEST_QUOTE_URL = `${environment.apiUrl}/swap/best-quote`;
  const REFRESH_QUOTE_URL = `${environment.apiUrl}/swap/refresh-quote`;
  const SENDER = '0x1234567890123456789012345678901234567890';

  let service: AggregatorService;
  let httpMock: HttpTestingController;

  const usdc: Token = {
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    chainId: 1,
  };
  const weth: Token = {
    address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    chainId: 1,
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), AggregatorService],
    });
    service = TestBed.inject(AggregatorService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  /** Issue a best-quote at `slippagePercent` and return the body that went out. */
  async function bodyOfBestQuote(slippagePercent: number): Promise<BestQuoteRequest> {
    const pending = service.getBestQuote(usdc, weth, '100', SENDER, slippagePercent);
    const req = httpMock.expectOne(BEST_QUOTE_URL);
    req.flush({});
    await pending;
    return req.request.body as BestQuoteRequest;
  }

  /** Same for the silent re-quote endpoint. */
  async function bodyOfRefreshQuote(slippagePercent: number): Promise<RefreshQuoteRequest> {
    const pending = service.refreshQuote('zerox', usdc, weth, '100', SENDER, slippagePercent);
    const req = httpMock.expectOne(REFRESH_QUOTE_URL);
    req.flush({});
    await pending;
    return req.request.body as RefreshQuoteRequest;
  }

  it('getBestQuote converts 0.5% to the decimal 0.005', async () => {
    const body = await bodyOfBestQuote(0.5);
    expect(body.slippage).toBe(0.005);
  });

  it('getBestQuote converts 1.5% (cross-chain default) to 0.015', async () => {
    const body = await bodyOfBestQuote(1.5);
    expect(body.slippage).toBe(0.015);
  });

  it('refreshQuote converts 0.5% to 0.005 — the second call site must not drift', async () => {
    const body = await bodyOfRefreshQuote(0.5);
    expect(body.slippage).toBe(0.005);
  });

  it('refreshQuote converts 1.5% to 0.015', async () => {
    const body = await bodyOfRefreshQuote(1.5);
    expect(body.slippage).toBe(0.015);
  });

  it('sends the amount in wei and the chain pair alongside the converted slippage', async () => {
    const body = await bodyOfBestQuote(0.5);
    expect(body).toEqual(jasmine.objectContaining({
      from_token: usdc.address,
      to_token: weth.address,
      amount: '100000000', // 100 USDC, 6 decimals
      from_chain_id: 1,
      to_chain_id: 1,
      sender_address: SENDER,
      slippage: 0.005,
    }));
  });
});
