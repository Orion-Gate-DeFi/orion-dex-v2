import { formatUsdFee } from './format-usd-fee';

describe('formatUsdFee', () => {
  it('renders a normal fee with two decimals and a ~ prefix', () => {
    expect(formatUsdFee('5')).toBe('~$5.00');
    expect(formatUsdFee('1.5')).toBe('~$1.50');
    expect(formatUsdFee('9')).toBe('~$9.00');
  });

  it('drops the ~ prefix when asked', () => {
    expect(formatUsdFee('5', false)).toBe('$5.00');
  });

  it('shows a real sub-cent fee as "<$0.01" instead of rounding it to "$0.00"', () => {
    // The whole point of the fix: an L2 gas cost of a fraction of a cent must
    // never read as a FREE transaction.
    expect(formatUsdFee('0.003')).toBe('<$0.01');
    expect(formatUsdFee('0.009')).toBe('<$0.01');
    expect(formatUsdFee('0.0001')).toBe('<$0.01');
    expect(formatUsdFee('0.000001')).toBe('<$0.01');
  });

  it('treats exactly one cent and above as the normal shape', () => {
    expect(formatUsdFee('0.01')).toBe('~$0.01');
    expect(formatUsdFee('0.02')).toBe('~$0.02');
  });

  it('returns "—" for the unknown / non-positive sentinels (never "free")', () => {
    expect(formatUsdFee('')).toBe('—');
    expect(formatUsdFee('not-a-number')).toBe('—');
    expect(formatUsdFee('0')).toBe('—');
    expect(formatUsdFee('-1')).toBe('—');
  });
});
