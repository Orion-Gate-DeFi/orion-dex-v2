/**
 * Pure-function tests for the error presenter — no TestBed.
 *
 * The whitelist specs import the REAL app-authored constants from their
 * owning services so a copy rewrite there breaks here, instead of silently
 * drifting past the literal prefix patterns in error-presenter.ts.
 */
import { presentError, truncateErrorForCta } from './error-presenter';
import { insufficientFundsMessage } from '../services/swap/swap-execution.service';
import { PARTIAL_SUCCESS_REASON } from '../services/swap/transaction-tracker.service';

describe('truncateErrorForCta', () => {
  it('passes short single-line messages through untouched', () => {
    expect(truncateErrorForCta('No liquidity')).toBe('No liquidity');
  });

  it('collapses whitespace and newlines to one line', () => {
    expect(truncateErrorForCta('line one\n  line two\t end')).toBe('line one line two end');
  });

  it('bounds long dumps to the limit with an ellipsis', () => {
    const out = truncateErrorForCta('x'.repeat(300));
    expect(out.length).toBe(80);
    expect(out.endsWith('…')).toBeTrue();
  });
});

describe('presentError', () => {
  it('replaces a multiline ethers dump with the calm quote copy and keeps the raw text in detail', () => {
    const raw = 'could not coalesce error\n(error={ "code": -32603 }, code=UNKNOWN_ERROR, version=6.13.0)';
    const out = presentError(raw, 'quote');
    expect(out.short).toBe('Something went wrong on our side. Your funds were not moved — refresh the quote and try again.');
    expect(out.detail).toContain('could not coalesce error');
    expect(out.detail).not.toContain('\n');
  });

  it('treats HTTP status phrasing as technical', () => {
    const out = presentError('HTTP 500 Internal Server Error', 'quote');
    expect(out.short).toContain('refresh the quote and try again');
    expect(out.detail).toBe('HTTP 500 Internal Server Error');
  });

  it('treats hex blobs and JSON braces as technical', () => {
    expect(presentError('execution reverted: 0xdeadbeef0123', 'swap').short)
      .toContain("didn't go through");
    expect(presentError('{"jsonrpc":"2.0","error":"oops"}', 'swap').short)
      .toContain("didn't go through");
  });

  it('treats over-long single-line messages as technical', () => {
    const out = presentError('a'.repeat(160), 'simulation');
    expect(out.short).toContain('Your funds are safe');
    expect(out.detail!.length).toBeLessThanOrEqual(200);
  });

  it('passes already-friendly messages through verbatim with no detail', () => {
    const friendly = [
      'No liquidity available for this pair',
      'Price moved beyond your slippage tolerance. Refresh the quote or raise slippage.',
      'Token approval not yet confirmed on-chain. Wait a few seconds and retry.',
      'execution reverted',
    ];
    for (const message of friendly) {
      const out = presentError(message, 'quote');
      expect(out.short).toBe(message);
      expect(out.detail).toBeUndefined();
    }
  });

  it('names the consequence per surface', () => {
    const garbage = 'code=CALL_EXCEPTION';
    expect(presentError(garbage, 'swap').short).toContain('gas may have been spent');
    expect(presentError(garbage, 'approve').short).toContain('no token permission was granted');
    expect(presentError(garbage, 'simulation').short).toContain('Your funds are safe');
  });

  it('maps an empty message to calm copy without a detail', () => {
    const out = presentError('', 'quote');
    expect(out.short).toContain('refresh the quote and try again');
    expect(out.detail).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // App-authored whitelist seam — length alone must never swallow our own copy
  // ---------------------------------------------------------------------------

  it('passes a 200-char app-authored allowance-reset message through despite the length ceiling', () => {
    // Padded to exactly 200 chars — far past the 120-char technical
    // heuristic. The known app-authored prefix must win over length.
    const base = 'USDT needs its old allowance reset to zero first — approve the reset transaction.';
    const message = `${base} ${'p'.repeat(200 - base.length - 1)}`;
    expect(message.length).toBe(200);
    const out = presentError(message, 'approve');
    expect(out.short).toBe(message);
    expect(out.detail).toBeUndefined();
  });

  it('passes the real PARTIAL_SUCCESS_REASON through verbatim (it is ~230 chars by design)', () => {
    expect(PARTIAL_SUCCESS_REASON.length).toBeGreaterThan(120);
    const out = presentError(PARTIAL_SUCCESS_REASON, 'swap');
    expect(out.short).toBe(PARTIAL_SUCCESS_REASON);
    expect(out.detail).toBeUndefined();
  });

  it('passes both real insufficient-gas templates through verbatim', () => {
    for (const message of [
      insufficientFundsMessage(true, 1),
      insufficientFundsMessage(false, 137),
    ]) {
      const out = presentError(message, 'swap');
      expect(out.short).toBe(message);
      expect(out.detail).toBeUndefined();
    }
  });

  it('passes app-authored send copy through verbatim on the send surface', () => {
    for (const message of [
      "Couldn't complete on the network",
      'Failed to switch network',
      'Transaction rejected by user',
    ]) {
      const out = presentError(message, 'send');
      expect(out.short).toBe(message);
      expect(out.detail).toBeUndefined();
    }
  });
});
