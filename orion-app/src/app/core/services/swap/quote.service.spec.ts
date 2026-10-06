/**
 * Pure-helper tests for QuoteService.
 *
 * No TestBed: `selectMinimumReceived` is a pure export — pulling the
 * wallet/Privy DI graph into Karma breaks the run.
 *
 * Honest minimum-received (audit #9 follow-up): the review screen may only
 * present the aggregator-enforced post-slippage floor (`to_amount_min`) as
 * a guarantee; anything else is a client-side estimate and must be tagged
 * as such so the UI can soften its copy.
 */
import { selectMinimumReceived } from './quote.service';

describe('selectMinimumReceived', () => {
  it('uses the aggregator-enforced floor when to_amount_min is present', () => {
    // 0.99 USDC in raw units against a 1.0 USDC quote.
    const result = selectMinimumReceived('990000', '1.0', 0.5, 6);
    expect(result.value).toBe('0.99');
    expect(result.source).toBe('enforced');
  });

  it('falls back to toAmount×(1−slippage) when to_amount_min is absent (ODOS sends none by design)', () => {
    const result = selectMinimumReceived(undefined, '1.0', 0.5, 6);
    expect(result.value).toBe('0.995000');
    expect(result.source).toBe('estimated');
  });

  it('falls back on a garbage to_amount_min instead of crashing or trusting it', () => {
    const result = selectMinimumReceived('not-a-number', '1.0', 0.5, 6);
    expect(result.value).toBe('0.995000');
    expect(result.source).toBe('estimated');
  });

  it('falls back on a zero floor — "you are guaranteed nothing" is not a floor', () => {
    const result = selectMinimumReceived('0', '1.0', 0.5, 6);
    expect(result.source).toBe('estimated');
  });

  it('falls back when the reported floor exceeds the quoted output (nonsense data)', () => {
    const result = selectMinimumReceived('2000000', '1.0', 0.5, 6);
    expect(result.source).toBe('estimated');
    expect(result.value).toBe('0.995000');
  });

  it('caps the estimate precision at 6 decimals for 18-decimal tokens', () => {
    const result = selectMinimumReceived(undefined, '2', 1, 18);
    expect(result.value).toBe('1.980000');
    expect(result.source).toBe('estimated');
  });

  it('keeps full token precision on the enforced path (formatUnits, not toFixed)', () => {
    // 0.123456789012345678 of an 18-decimal token survives verbatim.
    const result = selectMinimumReceived('123456789012345678', '1.0', 0.5, 18);
    expect(result.value).toBe('0.123456789012345678');
    expect(result.source).toBe('enforced');
  });

  it('estimates 0 for an unparseable quoted output instead of NaN', () => {
    const result = selectMinimumReceived(undefined, 'garbage', 0.5, 6);
    expect(result.value).toBe('0.000000');
    expect(result.source).toBe('estimated');
  });

  it('applies the same-chain default (0.5%) to a 1000 USDC quote — 995.000000, estimated', () => {
    // End of the slippage chain: settings default 0.5 → aggregator body
    // 0.005 → this floor. A percent/decimal mix-up anywhere upstream shows
    // up here as a wildly wrong "minimum received" on the review screen.
    const result = selectMinimumReceived(undefined, '1000', 0.5, 6);
    expect(result.value).toBe('995.000000');
    expect(result.source).toBe('estimated');
  });

  it('applies the cross-chain default (1.5%) to the same quote — 985.000000', () => {
    const result = selectMinimumReceived(undefined, '1000', 1.5, 6);
    expect(result.value).toBe('985.000000');
    expect(result.source).toBe('estimated');
  });
});
