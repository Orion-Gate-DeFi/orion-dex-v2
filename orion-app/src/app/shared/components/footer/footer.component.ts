/**
 * =============================================================================
 * FOOTER COMPONENT
 * =============================================================================
 *
 * Minimal footer with trust signals: copyright, version, support link, and
 * legal links (Beta Terms / Privacy / Risk disclosure → /legal sections).
 *
 * Legal links were deliberately absent until real legal text existed —
 * placeholder links erode trust faster than their absence. The /legal page
 * landed 2026-06-11, so the links are live now.
 *
 * @author Orion DEX Team
 * @version 1.2.0 — "Cookie settings" added to the legal nav: the GDPR
 *                  withdrawal path reopens the consent banner at any time.
 */

import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConsentService } from '../../../core/services/consent.service';
import { SUGGEST_FEATURE_URL } from '../../../core/constants';

@Component({
  selector: 'app-footer',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <footer
      class="border-t mt-auto"
      style="border-color: var(--orion-border); background: var(--orion-bg);"
      role="contentinfo"
    >
      <div
        class="max-w-[1280px] mx-auto px-4 sm:px-7 py-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-[12px]"
        style="color: var(--orion-muted);"
      >
        <!-- Left: copyright + beta tag -->
        <div class="flex items-center gap-3">
          <span class="orion-tabular">© {{ year }} Orion DEX</span>
          <span
            class="text-[10px] font-semibold uppercase tracking-[0.06em] px-[6px] py-[2px] rounded-md"
            style="color: var(--orion-accent-text); background: var(--orion-accent-tint);"
          >Beta v{{ version }}</span>
          <a
            [href]="suggestFeatureUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="hidden sm:inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.06em] px-4 py-2 rounded-md border no-underline transition-colors hover:text-[var(--orion-text)]"
            style="border-color: var(--orion-border);"
          >
            <span class="material-symbols-outlined text-[12px]" aria-hidden="true">feedback</span>
            Suggest a feature
          </a>
        </div>

        <!-- Middle: legal links. Fragment scrolling is handled inside
             LegalComponent (the router has no anchorScrolling configured). -->
        <nav class="flex flex-wrap items-center justify-center gap-x-5 gap-y-2" aria-label="Legal">
          <a
            routerLink="/legal"
            fragment="terms"
            class="transition-colors hover:text-[var(--orion-text)]"
          >Beta Terms</a>
          <a
            routerLink="/legal"
            fragment="privacy"
            class="transition-colors hover:text-[var(--orion-text)]"
          >Privacy</a>
          <a
            routerLink="/legal"
            fragment="risk"
            class="transition-colors hover:text-[var(--orion-text)]"
          >Risk disclosure</a>
          <button
            type="button"
            class="transition-colors hover:text-[var(--orion-text)]"
            (click)="consent.openSettings()"
          >Cookie settings</button>
        </nav>

        <!-- Right: social / support links. Brand-mark SVGs (no Material
             Symbols equivalent for X/Discord) — sized 14px to match the
             rest of the footer iconography. -->
        <div class="flex items-center gap-5">
          <a
            href="https://discord.com/invite/6xdyDbxZ5G"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Join our Discord"
            class="flex items-center gap-1.5 transition-colors hover:text-[var(--orion-text)]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.07.07 0 0 0-.073.035c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.073-.035 19.74 19.74 0 0 0-4.885 1.515.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.077.077 0 0 0 .084-.028c.462-.63.873-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.371-.291a.074.074 0 0 1 .078-.01c3.927 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.099.245.198.372.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.891.077.077 0 0 0-.04.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
            </svg>
            <span>Discord</span>
          </a>
          <a
            href="https://x.com/OGate_Official"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Follow us on X"
            class="flex items-center gap-1.5 transition-colors hover:text-[var(--orion-text)]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117l11.966 15.644z"/>
            </svg>
          </a>
        </div>
      </div>
    </footer>
  `,
})
export class FooterComponent {
  /** Reopens the consent banner (withdrawal / change of choice). */
  protected consent = inject(ConsentService);

  /** "Suggest a feature" CTA target (beta feedback channel). */
  readonly suggestFeatureUrl: string = SUGGEST_FEATURE_URL;

  /**
   * Version is read from a literal here rather than imported from
   * package.json — Angular's bundler doesn't resolve JSON imports through
   * `application` builder by default, and a literal stays trivially
   * trackable in code review when bumped.
   */
  readonly version = '0.1.0';
  readonly year = new Date().getFullYear();
}
