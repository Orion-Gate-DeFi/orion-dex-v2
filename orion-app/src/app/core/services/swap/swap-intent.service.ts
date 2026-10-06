/**
 * SwapIntentService — a one-shot hand-off so the AI assistant (or any caller)
 * can pre-fill the swap form before navigating to /swap.
 *
 * The assistant resolves the Token objects itself and arms an intent here, then
 * navigates; SwapComponent consumes it via an `effect` and pre-fills the swap
 * STEP (from/to/amount + a quote fetch). Signal-backed so it fires whether /swap
 * is freshly opened OR already on screen (a plain field would be missed when the
 * route component isn't reconstructed). It deliberately does NOT advance to
 * review or execute — every existing guard (risk-ack, approval, silent re-quote,
 * simulation, signature) still applies. Cleared on consume so a back-navigation
 * can't silently re-arm a stale swap.
 *
 * @author Orion DEX Team
 * @version 1.1.0
 */
import { Injectable, signal } from '@angular/core';
import type { Token } from '../../models/token.model';

export interface SwapIntent {
  readonly fromToken: Token;
  readonly toToken: Token;
  /** Human-readable pay amount (e.g. "1.5"). */
  readonly amount: string;
}

@Injectable({ providedIn: 'root' })
export class SwapIntentService {
  private readonly _pending = signal<SwapIntent | null>(null);
  /** The armed intent (null when none). SwapComponent watches this. */
  readonly pending = this._pending.asReadonly();

  /** Arm a pending swap. Overwrites any previous unconsumed intent. */
  set(intent: SwapIntent): void {
    this._pending.set(intent);
  }

  /** Clear the pending intent (call right after applying it). */
  clear(): void {
    this._pending.set(null);
  }
}
