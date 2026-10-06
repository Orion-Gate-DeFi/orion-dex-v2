/**
 * =============================================================================
 * BUY COMPONENT
 * =============================================================================
 *
 * Fiat on-ramp entry point. Logging in creates (or restores) the Privy
 * embedded wallet; the Buy button then opens Privy's card on-ramp, which
 * routes the purchase by region to whichever provider is enabled in the Privy
 * dashboard (Stripe / Meld / MoonPay / Coinbase). We never see card data or
 * move funds ourselves — the whole payment flow lives inside Privy's modal and
 * the provider's own window.
 *
 * The iOS app opens this page in an SFSafariViewController. In that context
 * it is launched with `?from=app`, which adds a "Return to Orion" link back
 * into the native app (`orion://buy-done`). Without the parameter the link
 * stays hidden — on desktop it would be a dead end.
 *
 * Deliberately NOT linked from the header or any menu: the page is reached
 * by direct URL only (from the iOS app), so it stays out of the web nav.
 *
 * @author Orion DEX Team
 * @version 1.1.0 — useFiatOnramp migration: the funding call now resolves with
 *                  a status, so a completed purchase gets its own toast.
 */

import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { WalletService } from '../../core/services/wallet.service';
import { ToastService } from '../../core/services/toast.service';
import { StatusIconComponent } from '../../shared/components/status-icon/status-icon.component';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Deep link back into the iOS app. The native side registers the `orion`
 * scheme and closes its SFSafariViewController when this URL is opened.
 */
export const RETURN_TO_APP_URL = 'orion://buy-done';

/**
 * Privy rejects the funding promise when the user simply backs out. The
 * messages, verified against the installed @privy-io/react-auth 3.37 bundle:
 * 'User exited flow' (the on-ramp screen, any pre-submission close) and
 * 'Payment method selection was cancelled' (Stripe's payment-method sheet
 * dismissed). 'User cancelled funding' belongs to the older useAddFunds menu
 * and is kept only so a rollback to that hook stays silent too. None of these
 * is a failure, so none may raise an error toast; anything else is a real
 * problem worth surfacing.
 */
const FUNDING_CANCELLED_PATTERN = /user (exited|cancelled)|selection was cancelled/i;

// =============================================================================
// COMPONENT
// =============================================================================

@Component({
  selector: 'app-buy',
  standalone: true,
  imports: [CommonModule, StatusIconComponent],
  // Safe on OnPush: every piece of view state is a signal, except
  // `openedFromApp`, which is resolved from the URL before the first change
  // detection run and never changes afterwards.
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './buy.component.html',
})
export class BuyComponent {
  readonly walletService = inject(WalletService);
  private readonly toastService = inject(ToastService);
  private readonly route = inject(ActivatedRoute);

  /** Deep link back into the iOS app, rendered only when opened from it. */
  readonly returnToAppUrl = RETURN_TO_APP_URL;

  /**
   * True when the iOS app opened this page (`?from=app`). Read from the
   * snapshot rather than the queryParams stream: the page is always entered
   * by navigation, so the parameter is settled before the first render and
   * a subscription would only add a leak to clean up.
   */
  readonly openedFromApp: boolean = this.route.snapshot.queryParamMap.get('from') === 'app';

  /** Privy's funding modal is opening / open — blocks a second click. */
  readonly isFunding = signal(false);

  /** Open Privy's login modal (same flow every other screen uses). */
  connectWallet(): void {
    void this.walletService.connect();
  }

  /**
   * Hand the connected address to Privy's on-ramp. Resolves once the purchase
   * is submitted or confirmed; a plain modal close rejects and is swallowed on
   * purpose (see FUNDING_CANCELLED_PATTERN).
   *
   * Both resolutions are wins — the user paid either way — so neither is an
   * error. They differ only in whether Privy got its final confirmation from
   * the provider, which is exactly the success-vs-pending distinction the two
   * toasts draw.
   */
  async buyCrypto(): Promise<void> {
    const address = this.walletService.address();
    if (!address || this.isFunding()) return;

    this.isFunding.set(true);
    try {
      const status = await this.walletService.fundWallet(address);
      if (status === 'confirmed') {
        this.toastService.success(
          'Purchase confirmed',
          'Your USDC is on its way — it can take a few minutes to arrive.'
        );
      } else {
        this.toastService.info(
          'Purchase submitted',
          'Your payment went through. The USDC will land in your wallet shortly.'
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!FUNDING_CANCELLED_PATTERN.test(message)) {
        // Raw Privy/provider text never reaches the toast — it is provider
        // jargon the user cannot act on.
        this.toastService.error(
          'Couldn\'t start the purchase',
          'The payment provider didn\'t open. Try again in a moment.'
        );
      }
    } finally {
      this.isFunding.set(false);
    }
  }
}
