/**
 * =============================================================================
 * LEGAL COMPONENT
 * =============================================================================
 *
 * Static legal surface for the public beta: Beta Terms of Use, Privacy
 * Notice, and Risk Disclosure on a single anchored page (/legal#terms,
 * /legal#privacy, /legal#risk).
 *
 * Fragment scrolling is handled here (ActivatedRoute.fragment subscription +
 * scrollIntoView) because the router is not configured with anchorScrolling
 * and enabling it globally is out of scope for this change.
 *
 * @author Orion DEX Team
 * @version 1.0.4 — Sync with the canonical beta-0.1 legal pack (2026-07-04):
 *                  add Eligibility (18+, US sanctions/OFAC) and Governing law
 *                  (Wyoming) to the Terms; add Waitlist data (Typeform) and drop
 *                  the in-app assistant bullet from the Privacy Notice (no agent
 *                  in beta 0.1); bold lead-in labels to match the source docs.
 * @version 1.0.5 — Analytics bullet updated for consent-gated GA4 (cookie
 *                  banner + footer withdrawal, no ad signals, no wallet data).
 *                  NOTE: diverges from the 2026-07-04 canonical pack — fold
 *                  this wording back into the pack at the next counsel review.
 * @version 1.0.6 — Privacy Notice brought in line with the code and with the
 *                  marketing site's corrected notice. Adds the mandatory Art. 13
 *                  elements that were missing (legal basis and retention per
 *                  purpose, the full rights list, supervisory-authority
 *                  complaint, international transfers, EU hosting) and the
 *                  recipients that were never disclosed: the AI assistant's
 *                  gateway and model operator, node/RPC providers, external
 *                  wallet connectors, asset CDNs, and server request logs.
 *                  Waitlist processor corrected from Typeform to Tally (the
 *                  live form is tally.so). The 1.0.4 note above records dropping
 *                  the assistant bullet for "no agent in beta 0.1" — that is
 *                  stale: the assistant ships in the app shell, so the bullet is
 *                  back and describes what actually leaves the device. Still
 *                  pending counsel review; per-vendor transfer mechanisms are
 *                  stated by category, which Art. 13(1)(e) permits.
 */

import { AfterViewInit, ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';

@Component({
  selector: 'app-legal',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!--
      BETA NOTICE: this legal text mirrors the canonical beta-0.1 legal pack
      (drafted in-house, last updated 2026-07-04) and has not yet been reviewed
      by legal counsel. The operating entity, contact channels, and the Wyoming
      governing-law clause below are canonical; the full text still needs
      counsel review before general release.
    -->
    <div class="flex-1 flex items-start justify-center p-3 lg:p-4 relative min-h-0 orion-screen-enter">
      <div class="w-full max-w-[700px] pt-6 pb-12">
        <div class="flex items-center gap-3 mb-6">
          <a routerLink="/" class="orion-btn-icon" aria-label="Back to home">
            <span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>
          </a>
          <h1 class="text-[22px] font-semibold text-[var(--orion-text)] tracking-[-0.01em] m-0">Legal</h1>
        </div>

        <div class="orion-card w-full">
          <div class="p-4 sm:p-6 lg:p-8">
            <p class="text-[12px] text-[var(--orion-muted)] m-0">Last updated: July 26, 2026</p>

            <nav class="flex flex-wrap gap-x-5 gap-y-2 mt-3 text-[13px]" aria-label="On this page">
              <a routerLink="/legal" fragment="terms" class="legal-jump">Beta Terms of Use</a>
              <a routerLink="/legal" fragment="privacy" class="legal-jump">Privacy Notice</a>
              <a routerLink="/legal" fragment="risk" class="legal-jump">Risk Disclosure</a>
            </nav>

            <!-- ================= Terms ================= -->
            <section id="terms" tabindex="-1" class="legal-section">
              <h2 class="legal-h2">Orion Beta Terms of Use</h2>
              <div class="legal-body">
                <p>
                  The Orion service is operated by Orion Gate LLC, 30 N Gould St, STE R,
                  Sheridan, WY 82801, USA ("Orion", "we"). Orion is beta software, provided
                  as is. By using it during the beta you accept these terms. Formal legal
                  notices can be sent to
                  <a href="mailto:legal@oriongate.xyz" class="legal-link">legal&#64;oriongate.xyz</a>.
                </p>
                <p>
                  <strong>Eligibility.</strong> You may use Orion only if you are at least 18 years old and are
                  not located in, or a resident of, any jurisdiction subject to comprehensive United States
                  sanctions, and you are not named on any U.S. government list of sanctioned or restricted
                  persons (including the OFAC SDN list). By using the service you represent that this is the
                  case.
                </p>
                <p>
                  <strong>Non-custodial.</strong> Orion is non-custodial. Your keys and your funds stay in your
                  wallet. Orion never takes possession of them and cannot move, freeze, or recover them if you
                  lose access to your wallet. If you connect an external wallet (such as MetaMask), you alone
                  hold the keys; if you sign in with email, you receive a Privy embedded wallet whose key
                  management and recovery are operated by Privy's infrastructure under Privy's own terms — in
                  both cases Orion never takes possession of your keys.
                </p>
                <p>
                  <strong>Third-party routing.</strong> Quotes and routing come from third-party aggregators and
                  bridges. Orion compares their offers, but it does not control their pricing, execution, or
                  availability.
                </p>
                <p>
                  <strong>Your responsibility.</strong> You are responsible for reviewing every transaction
                  before you sign it: tokens, amounts, recipient, network. Once signed and confirmed, a
                  transaction cannot be recalled.
                </p>
                <p>
                  <strong>No warranties.</strong> The service comes with no warranties of any kind, express or
                  implied. During the beta, features may change, break, or be removed, and the service itself
                  may be discontinued without notice.
                </p>
                <p>
                  <strong>Limitation of liability.</strong> To the maximum extent permitted by applicable law,
                  Orion and its contributors are not liable for losses arising from use of the service,
                  including losses caused by aggregator errors, bridge failures, network conditions, or
                  transactions you signed.
                </p>
                <p>
                  <strong>Governing law.</strong> These terms are governed by the laws of the State of Wyoming,
                  USA, without regard to its conflict-of-law rules. Before bringing a formal claim, you agree to
                  first contact us at
                  <a href="mailto:legal@oriongate.xyz" class="legal-link">legal&#64;oriongate.xyz</a>
                  and attempt to resolve the dispute informally within 30 days. Any dispute that cannot be
                  resolved informally shall be brought exclusively in the state or federal courts located in
                  Wyoming, USA.
                </p>
              </div>
            </section>

            <div class="orion-divider my-7" role="presentation"></div>

            <!-- ================= Privacy ================= -->
            <section id="privacy" tabindex="-1" class="legal-section">
              <h2 class="legal-h2">Privacy Notice</h2>
              <div class="legal-body">
                <p>
                  The data controller for the processing described here is Orion Gate LLC,
                  30 N Gould St, STE R, Sheridan, WY 82801, USA. Our own backend and database run on servers
                  located in the European Union, and the team that builds and operates Orion works from the
                  European Union. For privacy questions or to exercise your data rights, email
                  <a href="mailto:privacy@oriongate.xyz" class="legal-link">privacy&#64;oriongate.xyz</a>.
                </p>
                <p>
                  <strong>Account data.</strong> When you sign in, our backend creates an account record: a
                  username, the email address you signed in with (if any), your wallet address, and a referral
                  code derived from that address. That is the account data we keep. We process it to create and
                  operate your account, on the legal basis of performing our agreement with you (the Beta Terms
                  of Use), and we keep it for as long as your account exists. If you ask us to delete it, we do
                  so without undue delay and in any case within one month.
                </p>
                <p>
                  <strong>Waitlist data.</strong> If you join the waitlist for our mobile app, we store the
                  email address you submit, and — if you choose to provide them — your wallet address and
                  social handle. This data is collected through Tally, which processes it as our service
                  provider under its own terms. We use it to send TestFlight invites and product updates, and
                  for nothing else. The legal basis is your consent, given when you submit the form. We keep
                  this data until the mobile app has launched and its invites have gone out, and then delete
                  it — sooner if you ask us to. To have your waitlist data deleted, or to withdraw your
                  consent, email
                  <a href="mailto:privacy@oriongate.xyz" class="legal-link">privacy&#64;oriongate.xyz</a>.
                </p>
                <p><strong>Built-in exposure.</strong> Some exposure is built into how the product works:</p>
                <ul>
                  <li>Public blockchains record every transaction permanently, visible to anyone.</li>
                  <li>
                    When you request a quote, the trade details (token pair, amount, and your wallet
                    address) go to our backend, which queries third-party aggregators and bridges
                    (such as 0x, ODOS, LI.FI, and Squid) to find a route.
                  </li>
                  <li>
                    To screen tokens for known scams, token contract addresses are sent to
                    GoPlus, a third-party security provider. Prices and token metadata are served by LI.FI
                    through our proxy. Because some of these calls are made by the app in your browser rather
                    than by our servers, the provider also sees your IP address and the page you called from.
                  </li>
                  <li>
                    Reading balances and broadcasting transactions requires blockchain node providers. Your
                    wallet address and IP address reach the node operator handling the request — ours, or the
                    one your own wallet uses. Token and network logos are loaded from third-party content
                    networks, which likewise see your IP address.
                  </li>
                  <li>
                    Privy handles authentication and processes your login under its own privacy policy. If you
                    connect an external wallet, the connector you choose — including WalletConnect, where it is
                    used — processes that connection under its own terms.
                  </li>
                  <li>
                    <strong>AI assistant.</strong> When you use the in-app assistant, the text of your messages
                    and the conversation so far are sent through our backend to GonkaGate, an AI gateway, which
                    runs them on a third-party language model — Moonshot's Kimi. If you ask about your balances,
                    what the assistant works from includes your
                    token holdings, their amounts and their value in US dollars. Some questions additionally
                    trigger a live web lookup through the same gateway. We do not store your conversations on
                    our servers; the gateway and the model operator process them under their own terms. The model runs on a
                    decentralized compute network, so the country that processes any given conversation cannot be
                    guaranteed. The
                    legal basis is performance of our agreement with you — the assistant cannot answer without
                    sending your question. It never moves funds: it can only pre-fill a screen that you review
                    and sign yourself. If you would rather none of this were processed, do not use the
                    assistant.
                  </li>
                  <li>
                    Our servers keep technical logs of the requests they handle, recording your IP address,
                    your browser's user-agent string and the request path — which, for balance lookups,
                    contains your wallet address. We keep these to operate, debug and secure the service, on
                    the legal basis of our legitimate interest in running it, and only for as long as that
                    requires.
                  </li>
                  <li>
                    With your consent (asked once via the cookie banner, changeable any time
                    through "Cookie settings" in the footer), we use Google Analytics to
                    measure product usage: page visits and coarse product events such as
                    which networks and token pairs are traded. Page paths are sanitized before they leave your
                    device, and the events we send carry no wallet address, transaction hash or exact amount.
                    Advertising signals are permanently disabled. If you decline, nothing is sent, and
                    withdrawing consent later also deletes the analytics cookies already stored in your
                    browser.
                  </li>
                </ul>
                <p>
                  Orion does not use advertising trackers. Google's advertising signals — ad storage, ad user
                  data, and ad personalization — stay switched off at all times, whichever option you pick in
                  the banner.
                </p>
                <p>
                  <strong>Where your data goes.</strong> Our own backend and database are in the European Union,
                  and the team that builds and operates Orion works from the European Union. Several of the
                  recipients described above — aggregators and bridges, the token-security and market-data
                  providers, the authentication provider, the AI gateway and the model operator, the analytics provider, the node
                  providers and the content networks — are established outside the European Economic Area, so
                  using them means data reaching a third country. Those transfers rely on the European
                  Commission's adequacy decision for the recipient's country, the recipient's certification
                  under such a decision, or standard contractual clauses, depending on the provider.
                </p>
                <p>
                  <strong>Your rights.</strong> You can ask us for a copy of your data, have it corrected or
                  deleted, have our use of it restricted, object to that use, or receive it in a portable form.
                  Where we rely on your consent — the cookie banner and the waitlist — you can withdraw it at
                  any time, and withdrawing it does not affect processing that already took place. Email
                  <a href="mailto:privacy@oriongate.xyz" class="legal-link">privacy&#64;oriongate.xyz</a>
                  to exercise any of these; you can also reach the team on
                  <a
                    href="https://discord.com/invite/6xdyDbxZ5G"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="legal-link"
                  >our Discord</a>. If you believe we have mishandled your data, you can lodge a complaint with
                  the data protection authority in the country where you live.
                </p>
              </div>
            </section>

            <div class="orion-divider my-7" role="presentation"></div>

            <!-- ================= Risk ================= -->
            <section id="risk" tabindex="-1" class="legal-section">
              <h2 class="legal-h2">Risk Disclosure</h2>
              <div class="legal-body">
                <p>Swapping tokens on-chain can lose money. Understand these risks before you trade:</p>
                <ul>
                  <li>
                    <strong>Smart contracts.</strong> Token, aggregator, and bridge contracts can contain bugs
                    or be exploited.
                  </li>
                  <li>
                    <strong>Bridges.</strong> Cross-chain transfers can take far longer than estimated, and a
                    failed bridge can strand or lose funds.
                  </li>
                  <li>
                    <strong>Slippage and MEV.</strong> The executed price can be worse than the quote, and bots
                    can extract value from pending transactions.
                  </li>
                  <li><strong>Volatility.</strong> Prices can move sharply while a swap is in flight.</li>
                  <li>
                    <strong>Irreversibility.</strong> A confirmed blockchain transaction cannot be undone by
                    Orion or anyone else.
                  </li>
                  <li>
                    <strong>Scam tokens.</strong> Anyone can deploy a token with any name and logo. Orion filters
                    known scams, but the filter is not complete; verify contract addresses yourself.
                  </li>
                  <li>
                    <strong>Beta defects.</strong> This software is in beta and may contain bugs affecting
                    quotes, balances, or transaction handling.
                  </li>
                </ul>
                <p class="font-semibold text-[var(--orion-text)]">Never swap more than you can afford to lose.</p>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .legal-jump {
      color: var(--orion-accent-text);
      text-decoration: none;
      transition: color 0.15s ease;
    }
    .legal-jump:hover {
      color: var(--orion-text);
    }
    .legal-section {
      /* Breathing room above the heading when scrolled to via fragment. */
      scroll-margin-top: 16px;
      outline: none;
      margin-top: 28px;
    }
    .legal-h2 {
      margin: 0 0 12px;
      font-size: 17px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: var(--orion-text);
    }
    .legal-body {
      font-size: 14px;
      line-height: 1.65;
      color: var(--orion-subtle);
    }
    .legal-body p {
      margin: 0 0 12px;
    }
    .legal-body p:last-child {
      margin-bottom: 0;
    }
    .legal-body ul {
      margin: 0 0 12px;
      padding-left: 20px;
      list-style: disc;
    }
    .legal-body li {
      margin-bottom: 8px;
    }
    .legal-body strong {
      color: var(--orion-text);
      font-weight: 600;
    }
    .legal-link {
      color: var(--orion-accent-text);
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .legal-link:hover {
      color: var(--orion-text);
    }
  `],
})
export class LegalComponent implements AfterViewInit {
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  ngAfterViewInit(): void {
    // The router has no anchorScrolling configured, so fragments are handled
    // here. Subscribing (rather than reading the snapshot once) also covers
    // footer clicks that change only the fragment while already on /legal.
    this.route.fragment
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((fragment) => {
        if (!fragment) {
          return;
        }
        // Defer one frame: on initial navigation the view was just attached
        // and layout may not be final yet.
        requestAnimationFrame(() => this.scrollToSection(fragment));
      });
  }

  private scrollToSection(id: string): void {
    const target = document.getElementById(id);
    if (!target) {
      return;
    }
    // Move focus to the section (tabindex="-1") so keyboard and screen-reader
    // users land where the page visually scrolled to (WCAG 2.4.3).
    target.focus({ preventScroll: true });
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }
}
