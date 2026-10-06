/**
 * =============================================================================
 * FORMAT USD FEE
 * =============================================================================
 *
 * Single formatter for network/gas fees shown in USD across swap and send.
 *
 * The old `.toFixed(2)` path rounded any sub-cent fee to "$0.00", so a real
 * (but tiny) L2 gas cost read as a FREE transaction — the most misleading
 * thing a fee line can say. This formatter keeps the honest contract:
 *   - unparseable / non-positive  → "—"  (we couldn't estimate; never "free")
 *   - 0 < value < $0.01           → "<$0.01"  (real, just below a cent)
 *   - value ≥ $0.01               → "~$1.23"  (the familiar 2-decimal shape)
 *
 * @author Orion DEX Team
 * @version 1.0.0
 */

/**
 * Format a USD fee string for display.
 * @param value  Raw USD amount as a string (a quote/estimate value).
 * @param approx Prefix the cent-and-above shape with "~" (default true).
 */
export function formatUsdFee(value: string, approx: boolean = true): string {
  const n = parseFloat(value);
  // An estimation failure ('' / unparseable) or a non-positive value must
  // never render as a free swap — say "we don't know" instead.
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 0.01) return '<$0.01';
  return `${approx ? '~' : ''}$${n.toFixed(2)}`;
}
