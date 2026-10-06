/**
 * =============================================================================
 * ERROR PRESENTER
 * =============================================================================
 *
 * Boundary sanitization for raw error messages before they reach a toast,
 * a failure screen or a CTA label. Raw aggregator / ethers / RPC errors can
 * be multiline JSON dumps — each UI surface gets calm copy naming what
 * happened, whether funds moved, and the next step, while the bounded raw
 * text survives in `detail` for tooltips/support.
 *
 * Pure module by design: no Angular imports (direct or transitive), so the
 * swap and send features can share it and the spec runs without TestBed.
 *
 * @version 1.0.0
 */

/**
 * Single-line, bounded error text for the swap CTA. Raw aggregator errors
 * can be multiline JSON dumps — the button shows at most `maxLength` chars
 * on one line; the full text lives in the button's title attribute.
 */
export function truncateErrorForCta(message: string, maxLength: number = 80): string {
  const singleLine = message.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1).trimEnd()}…`;
}

/** Surfaces that show raw errors to the user — each gets its own calm fallback. */
export type ErrorPresentationContext = 'quote' | 'swap' | 'send' | 'approve' | 'simulation';

/**
 * Calm fallback copy per surface: what happened, whether funds moved, and
 * the next step. Used only when the raw message is technical garbage the
 * user can't act on — already-friendly messages pass through untouched.
 */
const CALM_ERROR_COPY: Record<ErrorPresentationContext, string> = {
  quote: 'Something went wrong on our side. Your funds were not moved — refresh the quote and try again.',
  swap: 'The transaction didn\'t go through. No tokens left your wallet, but gas may have been spent.',
  send: 'The transaction didn\'t go through. No tokens left your wallet, but gas may have been spent.',
  approve: 'The approval didn\'t go through, so no token permission was granted. Try approving again in a moment.',
  simulation: 'This swap would likely fail if sent right now. Your funds are safe — refresh the quote and try again.',
};

/**
 * Markers no human-authored UI message contains: hex blobs (addresses,
 * calldata, tx hashes), HTTP status phrasing, ethers' `code=` dumps and JSON
 * braces. Length/newline checks live in `presentError` itself.
 */
const TECHNICAL_ERROR_MARKERS = /0x[0-9a-f]{6,}|\bHTTP\b|code=|[{}]/i;

/**
 * App-authored friendly templates that interpolate runtime values (token
 * symbols, native-token names) or run long by design. The marker heuristics
 * alone can't protect them — `presentError`'s 120-char ceiling would swallow
 * a verbose but fully human message (PARTIAL_SUCCESS_REASON is ~230 chars),
 * replacing our own advice with vaguer calm copy. A known-prefix match here
 * passes the message through regardless of length. Sources:
 *   - swap-execution.service `approveToken` (USDT allowance-reset advice),
 *   - swap-execution.service `insufficientFundsMessage` (gas top-up advice),
 *   - transaction-tracker.service `PARTIAL_SUCCESS_REASON` (fallback-token
 *     delivery explanation).
 * Kept as literal patterns so this module stays free of Angular-service
 * imports; error-presenter.spec.ts imports the real constants and locks
 * these patterns against copy drift.
 */
const FRIENDLY_APP_MESSAGE_PATTERNS: readonly RegExp[] = [
  /^\S{1,16} needs its old allowance reset to zero first/,
  /^Not enough \S{1,16} (?:for the swap amount plus network fees|to pay network fees)/,
  /^The destination swap couldn't complete, so a fallback token/,
];

/**
 * Sanitize a raw error message at the UI boundary. Messages that already read
 * as human copy (our own mapped errors, the execution service's friendly
 * rephrasing) pass through verbatim — detected by a known app-authored prefix
 * or by the absence of technical markers. Anything technical (ethers dumps,
 * HTTP codes, JSON, multi-line stack soup) is replaced by calm copy naming
 * the consequence and the next step; `detail` then carries the bounded
 * single-line raw text for tooltips/support, and doubles as the "was
 * replaced" discriminator.
 */
export function presentError(
  raw: string,
  context: ErrorPresentationContext,
): { short: string; detail?: string } {
  const message = (raw || '').trim();
  const isKnownFriendly = FRIENDLY_APP_MESSAGE_PATTERNS.some((p) => p.test(message));
  const isTechnical =
    !isKnownFriendly &&
    (message.length === 0 ||
      message.length > 120 ||
      message.includes('\n') ||
      TECHNICAL_ERROR_MARKERS.test(message));
  if (!isTechnical) {
    return { short: message };
  }
  return message
    ? { short: CALM_ERROR_COPY[context], detail: truncateErrorForCta(message, 200) }
    : { short: CALM_ERROR_COPY[context] };
}
