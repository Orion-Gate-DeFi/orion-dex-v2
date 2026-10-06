/**
 * =============================================================================
 * CONSENT BANNER COMPONENT
 * =============================================================================
 *
 * Minimal cookie-consent banner for optional analytics. Fixed to the bottom
 * of the viewport, shown while no decision is stored (and again when the
 * footer's "Cookie settings" reopens it). Accept and Reject render from ONE
 * button class — same size, same fill, same border, side by side. Do not give
 * Accept an accent fill: styling the refusal into the background is the dark
 * pattern regulators act on, and it would contradict the Privacy Notice.
 *
 * Deliberately NOT a modal: it must not block swapping. It only asks.
 *
 * @author Orion DEX Team
 * @version 1.0.1 — Accept lost its accent fill; the two choices are now
 *                  visually identical, matching the marketing site's banner.
 */

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConsentService } from '../../../core/services/consent.service';

@Component({
  selector: 'app-consent-banner',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (consent.bannerOpen()) {
      <!-- role=region (not dialog): the banner is non-modal and never traps
           focus — a dialog role would falsely announce modality AND collide
           with real dialogs (token selector) in strict a11y queries. -->
      <div
        class="consent-banner orion-card"
        role="region"
        aria-label="Cookie consent"
        aria-live="polite"
      >
        <div class="consent-banner__text">
          <p class="m-0">
            We use cookies for product analytics only with your consent —
            never for ads, and never tied to your wallet.
            <a routerLink="/legal" fragment="privacy" class="consent-banner__link">Privacy Notice</a>
          </p>
        </div>
        <div class="consent-banner__actions">
          <button type="button" class="consent-banner__btn" (click)="consent.reject()">
            Reject
          </button>
          <button type="button" class="consent-banner__btn" (click)="consent.accept()">
            Accept
          </button>
        </div>
      </div>
    }
  `,
  styles: [`
    .consent-banner {
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      /* Above page content and footer, below modal dialogs (z-50 header /
         higher overlays keep working — this never traps focus). */
      z-index: 40;
      width: min(560px, calc(100vw - 24px));
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px 16px;
      padding: 14px 16px;
      background: var(--orion-surface);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
    }

    .consent-banner__text {
      flex: 1 1 260px;
      font-size: 13px;
      line-height: 1.5;
      color: var(--orion-subtle);
    }

    .consent-banner__link {
      color: var(--orion-accent-text);
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .consent-banner__link:hover {
      color: var(--orion-text);
    }

    .consent-banner__actions {
      display: flex;
      gap: 8px;
      margin-left: auto;
    }

    /* Accept and Reject share the exact same metrics — equal prominence. */
    .consent-banner__btn {
      padding: 9px 18px;
      border-radius: var(--orion-radius-button);
      font-size: 13px;
      font-weight: 600;
      background: var(--orion-surface-2);
      border: 1px solid var(--orion-border);
      color: var(--orion-text);
      transition: background 160ms ease, border-color 160ms ease;
    }
    .consent-banner__btn:hover {
      background: var(--orion-surface-3);
      border-color: var(--orion-border-strong);
    }
  `],
})
export class ConsentBannerComponent {
  protected consent = inject(ConsentService);
}
