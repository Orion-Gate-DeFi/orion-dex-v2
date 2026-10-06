import { Component, effect, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HeaderComponent } from './shared/components/header/header.component';
import { FooterComponent } from './shared/components/footer/footer.component';
import { ToastComponent } from './shared/components/toast/toast.component';
import { PrivyProviderComponent } from './shared/components/privy-provider/privy-provider.component';
import { AgentAssistantComponent } from './features/agent/agent-assistant.component';
import { OrionSwapPillComponent } from './shared/components/active-swap-pill/active-swap-pill.component';
import { WalletService } from './core/services/wallet.service';
import { TransactionHistoryService } from './core/services/transaction-history.service';
import { TransactionRehydrationService } from './core/services/transaction-rehydration.service';
import { AnalyticsService } from './core/services/analytics.service';
import { ConsentService } from './core/services/consent.service';
import { ConsentBannerComponent } from './shared/components/consent-banner/consent-banner.component';
import { EnvironmentValidatorService } from './core/services/environment-validator.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, HeaderComponent, FooterComponent, ToastComponent, PrivyProviderComponent, AgentAssistantComponent, OrionSwapPillComponent, ConsentBannerComponent],
  template: `
    <!-- Blocking config-error screen: only ever shows on a broken build
         (missing/invalid privyAppId, lifiProxyUrl or apiUrl). A silently
         half-working DEX is worse than a loud dev-facing stop. -->
    @if (envValidator.isBlocked()) {
      <div class="min-h-screen flex items-center justify-center p-6">
        <div class="config-error-card" role="alert">
          <h1>Configuration error</h1>
          <p>
            Required environment settings are missing or invalid — check
            privyAppId, lifiProxyUrl and apiUrl in the environment
            configuration and rebuild. Details are in the browser console.
          </p>
        </div>
      </div>
    } @else {
      <div class="min-h-screen flex flex-col relative">
        <!-- Skip-to-main link: visible only when focused, lets keyboard users
             jump past the header straight to swap content (WCAG 2.4.1). -->
        <a class="orion-skip-link" href="#main">Skip to main content</a>

        <!-- Privy Provider (React component for wallet connection) -->
        <app-privy-provider />

        <!-- Header -->
        <app-header />

        <!-- Main Content -->
        <!-- No z-index here: relative+z-10 created a stacking context that
             trapped every fixed modal/backdrop inside z=10, letting the z-50
             header paint (and stay clickable) above open dialogs. -->
        <main id="main" class="flex-1 flex flex-col relative" tabindex="-1">
          <router-outlet />
        </main>

        <!-- Footer (trust signals: copyright, version, support) -->
        <app-footer />

        <!-- Toast Notifications -->
        <app-toast />

        <!-- Orion Assistant (docked AI agent — overlays any screen, bottom-right) -->
        <app-agent-assistant />

        <!-- Active-swap pill (in-flight cross-chain swap status, bottom-left) -->
        <app-orion-swap-pill />

        <!-- Cookie-consent banner (bottom-center; only while undecided or
             reopened via the footer's "Cookie settings") -->
        <app-consent-banner />
      </div>
    }
  `,
  styles: [`
    .config-error-card {
      max-width: 26rem;
      width: 100%;
      padding: 1.75rem 1.5rem;
      border: 1px solid var(--orion-border-strong);
      border-radius: 16px;
      background: var(--orion-surface);
      text-align: center;

      h1 {
        color: var(--orion-danger);
        font-size: 1.125rem;
        font-weight: 600;
        margin-bottom: 0.5rem;
      }

      p {
        color: var(--orion-muted);
        font-size: 0.875rem;
        line-height: 1.55;
      }
    }
  `]
})
export class AppComponent {
  title = 'Orion DEX';

  /** Validated by APP_INITIALIZER before this component exists — the
   *  template only reads the resulting blocked/ok signal. */
  protected envValidator = inject(EnvironmentValidatorService);

  private wallet = inject(WalletService);
  private history = inject(TransactionHistoryService);
  private rehydration = inject(TransactionRehydrationService);
  private analytics = inject(AnalyticsService);
  private consent = inject(ConsentService);

  constructor() {
    // Consent-gated GA4 product analytics: init() only prepares the gtag
    // queue with Consent Mode v2 all-denied defaults — no request leaves the
    // browser until the user accepts the consent banner (ConsentService).
    this.analytics.init();
    this.consent.init();

    // Re-hydrate any "pending" history rows whenever a wallet connects.
    // Without this, a user who refreshed the tab mid-swap has the row
    // stuck pending forever — even though the tx already settled on-chain.
    // We bind the wallet to history first (triggers the load), then poll
    // each pending record against the chain / LI.FI bridge status.
    effect(() => {
      const address = this.wallet.address();
      this.history.setWallet(address);
      if (address) {
        // Fire-and-forget: a slow / failed re-hydration must never block
        // app boot or wallet switch.
        void this.rehydration.rehydratePendingForCurrentWallet();
      }
    });
  }
}
