/**
 * =============================================================================
 * DASHBOARD COMPONENT
 * =============================================================================
 *
 * Main dashboard showing user's portfolio overview.
 * Designed for crypto beginners with clear, simple UI.
 *
 * Features:
 * - Total portfolio value
 * - Top assets list with balances
 * - Educational "Orion Academy" section
 * - Support chat link
 *
 * @author Orion DEX Team
 * @version 1.4.0 — "Living Orb" login hero: idle breathing + slow ring
 *                  rotation (CSS), pointer tilt on hover devices, WAAPI
 *                  spring/shockwave/shimmer per tap, Y-flip logo swap and a
 *                  convergent supernova on every 8th tap. The easter-egg tap
 *                  counter and logo-cycling behavior are unchanged.
 */

import { Component, ChangeDetectionStrategy, DestroyRef, inject, signal, computed, OnInit, OnDestroy, effect, viewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { WalletService } from '../../core/services/wallet.service';
import { LifiService } from '../../core/services/lifi.service';
import { BalanceRefreshService } from '../../core/services/balance-refresh.service';
import { TokenDataService } from '../../core/services/swap/token-data.service';
import { TransactionHistoryComponent } from '../../shared/components/transaction-history/transaction-history.component';
import { getNetworkName, getNetworkLogo, NETWORKS, NetworkInfo, isSupportedNetwork, SUGGEST_FEATURE_URL } from '../../core/constants';
import { LOGOS } from '../../core/models/token.model';
import { OrionAssetRingComponent, RingSegment } from './orion-asset-ring.component';
import { replaceWithLetterIcon } from '../../core/utils/token-icon';
import { Subscription } from 'rxjs';

// =============================================================================
// INTERFACES
// =============================================================================

interface PortfolioAsset {
  symbol: string;
  name: string;
  address: string;
  logoURI: string;
  balance: number;
  balanceUSD: number;
  priceUSD: number;
  chainId: number;
}

// =============================================================================
// TRUST HELPERS (pure — unit-tested directly)
// =============================================================================

/** Native pseudo-addresses (zero address, EIP-7528 0xeee…) — always trusted. */
const NATIVE_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
]);

export type AssetTrustStatus = 'trusted' | 'unknown' | 'untrusted';

/**
 * Classify an asset against the per-chain trusted address sets (the token
 * selector's LI.FI token lists):
 * - 'trusted'   — native, or present on the chain's token list;
 * - 'unknown'   — no usable list for this chain yet (fail-open: still shown,
 *                 but never merged with trusted assets by symbol);
 * - 'untrusted' — the chain has a list and the address is not on it.
 *                 Unsolicited airdrops / counterfeits land here — hidden and
 *                 excluded from totals and the allocation ring, so a fake
 *                 "$5k USDC" airdrop can't inflate the portfolio.
 */
export function assetTrustStatus(
  asset: { address: string; chainId: number },
  trustedByChain: ReadonlyMap<number, ReadonlySet<string>>,
): AssetTrustStatus {
  const address = asset.address.toLowerCase();
  if (NATIVE_ADDRESSES.has(address)) return 'trusted';
  const chainList = trustedByChain.get(asset.chainId);
  if (!chainList || chainList.size === 0) return 'unknown';
  return chainList.has(address) ? 'trusted' : 'untrusted';
}

// =============================================================================
// COMPONENT
// =============================================================================

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterLink, TransactionHistoryComponent, OrionAssetRingComponent],
  // Safe on OnPush: every template binding reads signals/computeds (the
  // helper functions — formatUSD, getNetworkBalance, … — are pure over
  // their args or read computeds, which registers the dependency). The
  // Default-strategy <app-transaction-history> child still gets checked on
  // our 5 s timeSinceUpdate tick, keeping its relative timestamps fresh.
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss'
})
export class DashboardComponent implements OnInit, OnDestroy {
  // ---------------------------------------------------------------------------
  // Services
  // ---------------------------------------------------------------------------

  walletService = inject(WalletService);
  private lifiService = inject(LifiService);
  private balanceRefreshService = inject(BalanceRefreshService);
  private tokenDataService = inject(TokenDataService);
  private destroyRef = inject(DestroyRef);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  /** User's portfolio assets (all networks) */
  assets = signal<PortfolioAsset[]>([]);

  /** Full loading state — only before the first data/error for an account */
  isLoading = signal(true);

  /**
   * Background refresh in flight (auto-tick, post-transaction, manual).
   * Keeps the asset table rendered and only spins the refresh icon, instead
   * of replacing the list with the full loading state every 30 s.
   */
  isRefreshing = signal(false);

  /** First load failed and there is no data to show — renders the error block */
  loadError = signal(false);

  /** A background refresh failed; previously loaded data stays on screen */
  refreshFailed = signal(false);

  /**
   * Real numbers are on screen — only then may the zero-based summary chrome
   * (network cards, allocation ring) render. During wallet provisioning, the
   * first load, or after a first-load failure, the "$0.00 / 0 tokens"
   * zero-state above the status block would be a lie.
   */
  portfolioChromeVisible = computed(() => {
    // Read the local signals unconditionally BEFORE the wallet check: if a
    // false isConnected() short-circuited them away, the computed would have
    // no signal dependencies left and freeze at false (bit us in specs where
    // isConnected is a plain spy; also defensive against future non-signal
    // wallet-state implementations).
    const loadSettled = !this.isLoading() && !this.loadError();
    return loadSettled && this.walletService.isConnected();
  });

  /** Last updated timestamp */
  lastUpdated = signal<Date | null>(null);

  /** Timer signal for updating "X seconds ago" display */
  timeSinceUpdate = signal<string>('');

  /** Timer interval for updating time display */
  private timerIntervalId: ReturnType<typeof setInterval> | null = null;

  /** Auto-refresh interval ID */
  private refreshIntervalId: ReturnType<typeof setInterval> | null = null;

  /** Auto-refresh interval in milliseconds (30 seconds) */
  private readonly REFRESH_INTERVAL = 30000;

  /** Minimum interval between fetches to prevent rate limiting (10 seconds) */
  private readonly MIN_FETCH_INTERVAL = 10000;

  /** Last fetch timestamp for debounce */
  private lastFetchTime = 0;

  /**
   * Address the last fetch was issued for. The debounce window is per-account:
   * an account switch must fetch immediately instead of sitting out the
   * previous account's window (which would keep stale data on screen).
   */
  private lastFetchAddress: string | null = null;

  /**
   * Owner of the data currently in `assets` (set on successful load). Lets a
   * failed fetch tell "background refresh failed for the same account" apart
   * from "first load failed for a freshly switched account" — the latter must
   * clear the previous account's assets instead of keeping them on screen.
   */
  private loadedAddress: string | null = null;

  /**
   * Monotonically increasing id of the latest issued fetch. The `finally`
   * block of `loadPortfolio` may only clear the loading flags when the
   * finishing request still owns them — a stale request (account switched
   * mid-flight) must not kill a newer request's spinner.
   */
  private loadRequestId = 0;

  /** Subscription for balance refresh events */
  private refreshSubscription: Subscription | null = null;

  /** Page visibility handler reference */
  private visibilityHandler: (() => void) | null = null;

  /** Selected network filter (null = all networks) */
  selectedNetwork = signal<number | null>(null);

  /** Active tab: 'assets' or 'activity' */
  activeTab = signal<'assets' | 'activity'>('assets');

  /** Available networks for filter */
  readonly networks = NETWORKS;

  // ---------------------------------------------------------------------------
  // Privy initialization state
  // ---------------------------------------------------------------------------
  // `isConnectedInPrivy` starts as null while the React bridge boots. Without
  // a third branch the landing page is blank — forever, if Privy fails to
  // load. A skeleton covers the normal init window; past the timeout the
  // guest hero renders anyway and a broken Privy surfaces through the
  // connect flow itself.

  /** Privy never resolved within the timeout — fall back to the guest hero */
  privyInitTimedOut = signal(false);

  /**
   * How long the init skeleton may cover the landing page. Matches the lazy
   * bridge's BRIDGE_READY_TIMEOUT_MS (privy-bridge.ts, 15 s): the React/Privy
   * tree is mounted on idle + fetched as a lazy chunk, so on slow networks
   * the old 6 s watchdog fired before the mount and flashed the guest hero
   * at logged-in users.
   */
  private readonly PRIVY_INIT_TIMEOUT = 15_000;

  // The `connectDirect` fallback attaches a wallet without ever resolving
  // Privy state (`isConnectedInPrivy` stays null), so both gates below must
  // also defer to the actual wallet connection — otherwise a directly
  // connected user is stuck on the skeleton / guest hero forever.

  /** Privy auth state still unknown — render the hero skeleton */
  privyStatePending = computed(() =>
    !this.walletService.isConnected() &&
    this.walletService.isConnectedInPrivy() === null &&
    !this.privyInitTimedOut()
  );

  /** Guest hero: confirmed logged-out, or Privy never finished initializing */
  showGuestHero = computed(() =>
    !this.walletService.isConnected() && (
      this.walletService.isConnectedInPrivy() === false ||
      (this.walletService.isConnectedInPrivy() === null && this.privyInitTimedOut())
    )
  );

  // ---------------------------------------------------------------------------
  // Login-orb easter egg — "Living Orb"
  // ---------------------------------------------------------------------------
  // Pure decoration: the orb breathes at rest (CSS: glow pulse + slow ring
  // rotation on independent periods), tilts toward the pointer on
  // hover-capable devices, and answers each tap with a two-axis spring +
  // shockwave + shimmer (all WAAPI — retriggers cleanly, no class juggling).
  // Taps cycle the orb's logo through the top-6 supported tokens via a Y-flip;
  // every 8th tap converges the particles into the centre and flashes as the
  // Orion logo flips back in. Under prefers-reduced-motion only the
  // opacity-only glow breathe remains (CSS override) and taps swap the logo
  // with a 150ms opacity crossfade — the swap still works (it's content, not
  // motion); every spatial effect is skipped.

  /** Top-6 supported-token logos cycled on each tap. Reuses the app's canonical
   *  token icons (CoinGecko CDN, via LOGOS); CSP allows `img-src https:` and the
   *  <img> (error) handler falls back to our logo, so a 404 never leaves it blank. */
  private readonly topTokenOrbLogos: readonly string[] = [
    LOGOS.WBTC, LOGOS.ETH, LOGOS.USDT, LOGOS.USDC, LOGOS.BNB,
    // ARB: CoinGecko's logo (LOGOS.ARB) is a JPEG with a white square background
    // that looks wrong in the round orb — use the transparent Trustwallet PNG.
    'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/assets/0x912CE59144191C1204E64559FE8253a0e49E6548/logo.png',
  ];
  /** Brand logo (from public/) shown at rest and on every 8th tap. */
  private readonly orionOrbLogo = 'logo_header.png';

  /** Logo currently shown in the orb — cycles tokens, returns to ours on the 8th. */
  readonly orbLogoSrc = signal<string>(this.orionOrbLogo);
  /** "Suggest a feature" CTA target (community card). */
  readonly suggestFeatureUrl: string = SUGGEST_FEATURE_URL;
  private orbPokeCount = 0;

  /** Guest-hero root — the pointer-tilt listeners live on it (position source). */
  private readonly guestHeroRef = viewChild<ElementRef<HTMLElement>>('guestHero');
  /** Orb button — tilt transform target and query root for the WAAPI parts. */
  private readonly guestOrbRef = viewChild<ElementRef<HTMLButtonElement>>('guestOrb');

  /**
   * Monotonic owner token for tap motion: async continuations (flip halves,
   * supernova convergence → flash) only proceed while they still hold the
   * latest token, so rapid taps collapse instead of piling animations up.
   */
  private orbMotionToken = 0;
  /** True while a logo flip runs — a tap mid-flip jumps straight to its target. */
  private orbFlipInFlight = false;

  /** Cached once — MediaQueryList.matches stays live, no per-event allocation. */
  private readonly reducedMotionQuery: MediaQueryList | null =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

  private prefersReducedMotion(): boolean {
    return this.reducedMotionQuery?.matches ?? false;
  }

  /**
   * Pointer-presence tilt, hover-capable devices only: the orb leans up to ~8°
   * toward the pointer while it travels the hero; the 120ms CSS transition on
   * the button smooths the follow (no rAF loop needed) and springs it back to
   * rest on leave. Touch devices skip tilt entirely — gyro permission prompts
   * aren't worth it for decoration.
   */
  private readonly orbTiltEffect = effect((onCleanup) => {
    const hero = this.guestHeroRef()?.nativeElement;
    const orb = this.guestOrbRef()?.nativeElement;
    if (!hero || !orb) return;
    if (typeof window.matchMedia !== 'function' || !window.matchMedia('(hover: hover)').matches) return;

    const onMove = (ev: PointerEvent): void => {
      if (this.prefersReducedMotion()) {
        orb.style.transform = '';
        return;
      }
      const rect = hero.getBoundingClientRect();
      const nx = Math.min(1, Math.max(-1, ((ev.clientX - rect.left) / rect.width) * 2 - 1));
      const ny = Math.min(1, Math.max(-1, ((ev.clientY - rect.top) / rect.height) * 2 - 1));
      // Lean toward the pointer: pointer below centre tips the top away.
      orb.style.transform =
        `perspective(600px) rotateX(${(-ny * 8).toFixed(2)}deg) rotateY(${(nx * 8).toFixed(2)}deg)`;
    };
    const onLeave = (): void => {
      orb.style.transform = '';
    };
    hero.addEventListener('pointermove', onMove, { passive: true });
    hero.addEventListener('pointerleave', onLeave, { passive: true });
    onCleanup(() => {
      hero.removeEventListener('pointermove', onMove);
      hero.removeEventListener('pointerleave', onLeave);
    });
  });

  pokeOrb(): void {
    this.orbPokeCount += 1;
    // Every 8th tap brings our logo back through the supernova sequence; the
    // taps in between cycle the supported-token logos.
    const isSupernova = this.orbPokeCount % 8 === 0;
    const nextLogo = isSupernova
      ? this.orionOrbLogo
      : this.topTokenOrbLogos[(this.orbPokeCount - 1) % this.topTokenOrbLogos.length];
    const token = ++this.orbMotionToken;

    const orb = this.guestOrbRef()?.nativeElement ?? null;
    const logo = orb?.querySelector<HTMLElement>('.guest-orb-logo') ?? null;

    // Reduced motion (or missing DOM, defensively): swap the logo instantly
    // with a 150ms opacity crossfade — no tilt/spring/shockwave/particles.
    if (this.prefersReducedMotion() || !orb || !logo) {
      logo?.getAnimations().forEach((a) => a.cancel());
      this.orbFlipInFlight = false;
      this.orbLogoSrc.set(nextLogo);
      logo?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
      return;
    }

    // Queue collapse: cancel the previous tap's logo/particle animations so
    // rapid taps never pile up; a tap landing mid-flip jumps the logo straight
    // to this tap's target instead of chaining another flip.
    const interruptedFlip = this.orbFlipInFlight;
    logo.getAnimations().forEach((a) => a.cancel());
    orb.querySelectorAll<HTMLElement>('.orb-spark')
      .forEach((s) => s.getAnimations().forEach((a) => a.cancel()));
    this.orbFlipInFlight = false;

    this.playOrbSpring(orb);
    if (isSupernova) {
      this.playOrbSupernova(orb, logo, nextLogo, token);
    } else {
      this.playOrbShockwave(orb, 1);
      this.playOrbShimmer(orb);
      if (interruptedFlip) {
        this.orbLogoSrc.set(nextLogo);
      } else {
        this.flipOrbLogo(logo, nextLogo, token);
      }
    }
  }

  /** Two-axis counter-phase overshoot — a pressed elastic sphere, not a pop. */
  private playOrbSpring(orb: HTMLElement): void {
    // Default (linear) easing between keyframes per the motion spec — the
    // overshoot offsets carry the spring feel.
    orb.querySelector<HTMLElement>('.orb-body')?.animate(
      [
        { transform: 'scale(1, 1)' },
        { transform: 'scale(1.12, 0.94)', offset: 0.3 },
        { transform: 'scale(0.96, 1.06)', offset: 0.6 },
        { transform: 'scale(1.02, 0.99)', offset: 0.82 },
        { transform: 'scale(1, 1)' },
      ],
      { duration: 550 },
    );
  }

  /** Expanding impact ring; strength 2 is the brighter supernova double. */
  private playOrbShockwave(orb: HTMLElement, strength: 1 | 2): void {
    orb.querySelector<HTMLElement>('.orb-shockwave')?.animate(
      [
        { transform: 'scale(1)', opacity: strength === 2 ? 0.85 : 0.5, filter: 'blur(1px)' },
        { transform: `scale(${strength === 2 ? 1.9 : 1.55})`, opacity: 0, filter: 'blur(0px)' },
      ],
      { duration: strength === 2 ? 750 : 650, easing: 'ease-out' },
    );
  }

  /** Gradient glint swept across the sphere — the premium detail per tap. */
  private playOrbShimmer(orb: HTMLElement): void {
    orb.querySelector<HTMLElement>('.orb-shimmer')?.animate(
      [
        { transform: 'translateX(-120%)', opacity: 0 },
        { opacity: 1, offset: 0.25 },
        { opacity: 1, offset: 0.75 },
        { transform: 'translateX(120%)', opacity: 0 },
      ],
      { duration: 500, delay: 80, easing: 'ease-in-out' },
    );
  }

  /**
   * Y-flip logo swap: flip out (140ms ease-in, motion-blurred at the edge),
   * swap the src while the face sits at 90° (invisible), flip back in (180ms
   * ease-out). Both continuations re-check the motion token so a newer tap's
   * instant jump wins over a stale half-flip.
   */
  private flipOrbLogo(logo: HTMLElement, nextLogo: string, token: number): void {
    this.orbFlipInFlight = true;
    const out = logo.animate(
      [
        { transform: 'perspective(400px) rotateY(0deg)', filter: 'blur(0px)' },
        { transform: 'perspective(400px) rotateY(90deg)', filter: 'blur(1.5px)' },
      ],
      // fill: 'forwards' holds the edge-on pose across the src swap so the
      // logo can't flash face-on between the two animation halves.
      { duration: 140, easing: 'ease-in', fill: 'forwards' },
    );
    out.finished
      .then(() => {
        if (token !== this.orbMotionToken) return;
        this.orbLogoSrc.set(nextLogo);
        const back = logo.animate(
          [
            { transform: 'perspective(400px) rotateY(-90deg)', filter: 'blur(1.5px)' },
            { transform: 'perspective(400px) rotateY(0deg)', filter: 'blur(0px)' },
          ],
          { duration: 180, easing: 'ease-out' },
        );
        // The back-flip owns the transform now (later in composite order) —
        // release the out-flip's forwards fill so nothing lingers after.
        out.cancel();
        back.finished
          .then(() => {
            if (token === this.orbMotionToken) this.orbFlipInFlight = false;
          })
          .catch(() => { /* cancelled by a newer tap — the interrupter owns state */ });
      })
      .catch(() => { /* cancelled by a newer tap */ });
  }

  /**
   * Every-8th-tap supernova, reversed from the old outward burst: particles
   * START at ~48px radius and converge into the centre (staggered 0–90ms),
   * then a brighter flash — glow opacity spike + double-strength shockwave +
   * shimmer — lands as the Orion logo flips back in.
   */
  private playOrbSupernova(orb: HTMLElement, logo: HTMLElement, nextLogo: string, token: number): void {
    const sparks = Array.from(orb.querySelectorAll<HTMLElement>('.orb-spark'));
    const converge = sparks.map((spark, i) =>
      spark.animate(
        [
          { transform: `rotate(${i * 60}deg) translateX(48px) scale(1)`, opacity: 0 },
          { opacity: 1, offset: 0.2 },
          { transform: `rotate(${i * 60}deg) translateX(2px) scale(0.4)`, opacity: 0.9 },
        ],
        { duration: 420, delay: i * 18, easing: 'ease-in' },
      ),
    );
    // allSettled (not all): cancellation by a newer tap rejects `finished`;
    // the token check aborts the flash for superseded runs either way.
    void Promise.allSettled(converge.map((a) => a.finished)).then(() => {
      if (token !== this.orbMotionToken) return;
      orb.querySelector<HTMLElement>('.orb-glow')?.animate(
        [
          { opacity: 0.8, transform: 'scale(1)' },
          { opacity: 1, transform: 'scale(1.22)', offset: 0.25 },
          { opacity: 0.7, transform: 'scale(1)' },
        ],
        { duration: 650, easing: 'ease-out' },
      );
      this.playOrbShockwave(orb, 2);
      this.playOrbShimmer(orb);
      this.flipOrbLogo(logo, nextLogo, token);
    });
  }

  /** A meme CDN logo failed to load — never leave the orb blank, show ours. */
  onOrbLogoError(): void {
    this.orbLogoSrc.set(this.orionOrbLogo);
  }

  // ---------------------------------------------------------------------------
  // Scam-token hygiene
  // ---------------------------------------------------------------------------

  /** Hidden-tokens expander state */
  showHiddenAssets = signal(false);

  /** Per-chain trusted address sets from the selector's cached token lists */
  private trustedTokensByChain = computed<Map<number, Set<string>>>(() => {
    const byChain = new Map<number, Set<string>>();
    for (const [chainId, tokens] of this.tokenDataService.cachedTokens()) {
      if (tokens.length === 0) continue; // unusable list — fail open per chain
      byChain.set(chainId, new Set(tokens.map(t => t.address.toLowerCase())));
    }
    return byChain;
  });

  /** Assets that pass the trust check — every total/count/ring reads these */
  shownAssets = computed(() => {
    const trusted = this.trustedTokensByChain();
    return this.assets().filter(asset => assetTrustStatus(asset, trusted) !== 'untrusted');
  });

  /** Untrusted assets under the active network filter (collapsed section) */
  hiddenAssets = computed(() => {
    const trusted = this.trustedTokensByChain();
    const networkId = this.selectedNetwork();
    return this.assets().filter(asset =>
      assetTrustStatus(asset, trusted) === 'untrusted' &&
      (networkId === null || asset.chainId === networkId)
    );
  });

  /** Filtered assets based on selected network (trusted/unknown only) */
  filteredAssets = computed(() => {
    const networkId = this.selectedNetwork();
    const allAssets = this.shownAssets();

    if (networkId === null) {
      return allAssets;
    }
    return allAssets.filter(asset => asset.chainId === networkId);
  });

  /** Total portfolio value in USD (all networks, hidden tokens excluded) */
  totalValueUSD = computed(() => {
    return this.shownAssets().reduce((sum, asset) => sum + asset.balanceUSD, 0);
  });

  /** Filtered total value for selected network */
  filteredValueUSD = computed(() => {
    return this.filteredAssets().reduce((sum, asset) => sum + asset.balanceUSD, 0);
  });

  /** Balance per network for filter buttons (hidden tokens excluded) */
  networkBalances = computed(() => {
    const balances = new Map<number, number>();
    for (const asset of this.shownAssets()) {
      const current = balances.get(asset.chainId) || 0;
      balances.set(asset.chainId, current + asset.balanceUSD);
    }
    return balances;
  });

  /**
   * Donut segments for the portfolio ring: per-asset USD share under the
   * active network filter. Trusted same-symbol balances across chains merge
   * into one segment (the ring answers "what am I holding", not "where");
   * unverified assets (fail-open chains) key by address instead, so a
   * counterfeit can never merge into the real asset's slice. The tail past
   * the top five folds into "Other" so slivers stay readable.
   */
  ringSegments = computed<RingSegment[]>(() => {
    const trusted = this.trustedTokensByChain();
    const merged = new Map<string, RingSegment>();
    for (const asset of this.filteredAssets()) {
      if (asset.balanceUSD <= 0) continue;
      const key = assetTrustStatus(asset, trusted) === 'trusted'
        ? `sym:${asset.symbol.toUpperCase()}`
        : `addr:${asset.chainId}:${asset.address.toLowerCase()}`;
      const existing = merged.get(key);
      if (existing) {
        existing.value += asset.balanceUSD;
      } else {
        merged.set(key, {
          id: key,
          label: asset.symbol,
          value: asset.balanceUSD,
          logoURI: asset.logoURI,
        });
      }
    }

    const sorted = [...merged.values()].sort((a, b) => b.value - a.value);
    if (sorted.length <= 6) return sorted;

    const top = sorted.slice(0, 5);
    const otherValue = sorted.slice(5).reduce((sum, s) => sum + s.value, 0);
    return [...top, { id: 'other', label: `Other (${sorted.length - 5})`, value: otherValue }];
  });

  /** Scope caption inside the ring ("All networks" / active network name). */
  ringCaption = computed(() => {
    const networkId = this.selectedNetwork();
    return networkId === null ? 'All networks' : getNetworkName(networkId);
  });

  // ---------------------------------------------------------------------------
  // Sticky quick toolbar
  // ---------------------------------------------------------------------------
  // The hero deliberately has no balance figure (the Allocation ring is the
  // total display) — so once the ring scrolls out of view, a fixed toolbar
  // with the figure + core actions slides in. Driven by IntersectionObserver
  // on the Allocation card; the signal-based viewChild re-runs the effect
  // when the @if branch (dis)mounts the element.
  private readonly allocCard = viewChild<ElementRef<HTMLElement>>('allocCard');
  readonly showQuickBar = signal(false);
  private quickBarObserver: IntersectionObserver | null = null;

  private readonly quickBarEffect = effect(() => {
    const el = this.allocCard()?.nativeElement;
    this.quickBarObserver?.disconnect();
    this.quickBarObserver = null;
    if (!el || typeof IntersectionObserver === 'undefined') {
      this.showQuickBar.set(false);
      return;
    }
    this.quickBarObserver = new IntersectionObserver(
      ([entry]) => this.showQuickBar.set(!entry.isIntersecting),
      // A little headroom so the bar appears just before the ring fully exits.
      { rootMargin: '-56px 0px 0px 0px' },
    );
    this.quickBarObserver.observe(el);
  });

  /** User's display name (shortened address or "User") */
  displayName = computed(() => {
    const addr = this.walletService.shortAddress();
    return addr ? `${addr}` : 'User';
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  constructor() {
    // Use effect to reactively load portfolio when wallet connects
    // allowSignalWrites needed because loadPortfolio writes to signals
    effect(() => {
      const address = this.walletService.address();
      const isConnected = this.walletService.isConnected();

      if (isConnected && address) {
        this.loadPortfolio();
      } else {
        // Reset when wallet disconnects
        this.assets.set([]);
        this.loadedAddress = null;
        this.isLoading.set(false);
        this.loadError.set(false);
        this.refreshFailed.set(false);
      }
    }, { allowSignalWrites: true });

    // Privy-init watchdog: past this point the guest hero renders even if
    // the bridge never resolves. DestroyRef keeps the timer from leaking.
    const privyTimer = setTimeout(
      () => this.privyInitTimedOut.set(true),
      this.PRIVY_INIT_TIMEOUT,
    );
    this.destroyRef.onDestroy(() => clearTimeout(privyTimer));
  }

  ngOnInit(): void {
    // Initial load if already connected
    if (this.walletService.isConnected() && this.walletService.address()) {
      this.loadPortfolio();
    }

    // Start auto-refresh interval (30 seconds)
    this.startAutoRefresh();

    // Start timer for "X seconds ago" display (every 5 seconds)
    this.startTimerDisplay();

    // Listen for transaction completion events (Send/Swap). These are
    // explicit balance-change signals — they must show up immediately, so
    // bypass the rate-limit debounce the same way the manual refresh does
    // (a plain loadPortfolio() within 10 s of a tick gets swallowed).
    this.refreshSubscription = this.balanceRefreshService.refresh$.subscribe(() => {
      void this.refresh();
    });

    // Listen for page visibility changes (refresh when tab becomes visible)
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible' && this.walletService.isConnected()) {
        this.loadPortfolio();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  ngOnDestroy(): void {
    // Cleanup auto-refresh interval
    this.stopAutoRefresh();

    // Cleanup timer display interval
    this.stopTimerDisplay();

    // Invalidate in-flight orb tap sequences (flip halves / supernova flash
    // continuations check this token before touching component state).
    this.orbMotionToken += 1;

    // Cleanup refresh subscription
    if (this.refreshSubscription) {
      this.refreshSubscription.unsubscribe();
      this.refreshSubscription = null;
    }

    // Cleanup visibility listener
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }

    // Cleanup quick-bar observer
    this.quickBarObserver?.disconnect();
    this.quickBarObserver = null;
  }

  // ---------------------------------------------------------------------------
  // Auto-Refresh
  // ---------------------------------------------------------------------------

  /** Start auto-refresh interval */
  private startAutoRefresh(): void {
    this.stopAutoRefresh(); // Clear any existing interval
    this.refreshIntervalId = setInterval(() => {
      // Hidden tabs must not keep hammering the LI.FI balance API — users
      // park DEX tabs for hours. The visibilitychange handler (ngOnInit)
      // already refreshes immediately when the tab becomes visible again.
      if (document.hidden) return;
      if (this.walletService.isConnected() && !this.isLoading() && !this.isRefreshing()) {
        this.loadPortfolio();
      }
    }, this.REFRESH_INTERVAL);
  }

  /** Stop auto-refresh interval */
  private stopAutoRefresh(): void {
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = null;
    }
  }

  /** Start timer display interval (updates "X seconds ago" every 5 seconds) */
  private startTimerDisplay(): void {
    this.stopTimerDisplay();
    this.updateTimeSinceUpdate(); // Initial update
    this.timerIntervalId = setInterval(() => {
      this.updateTimeSinceUpdate();
    }, 5000); // Update every 5 seconds
  }

  /** Stop timer display interval */
  private stopTimerDisplay(): void {
    if (this.timerIntervalId) {
      clearInterval(this.timerIntervalId);
      this.timerIntervalId = null;
    }
  }

  /** Update the time since last update display */
  private updateTimeSinceUpdate(): void {
    const lastUpdate = this.lastUpdated();
    if (!lastUpdate) {
      this.timeSinceUpdate.set('');
      return;
    }

    const now = new Date();
    const diffMs = now.getTime() - lastUpdate.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 5) {
      this.timeSinceUpdate.set('Just now');
    } else if (diffSec < 60) {
      this.timeSinceUpdate.set(`${diffSec}s ago`);
    } else {
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) {
        this.timeSinceUpdate.set(`${diffMin}m ago`);
      } else {
        const diffHour = Math.floor(diffMin / 60);
        this.timeSinceUpdate.set(`${diffHour}h ago`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Data Loading
  // ---------------------------------------------------------------------------

  /**
   * Load user's portfolio data
   * Fetches balances for all tokens across supported chains via LI.FI API
   * Includes debounce to prevent rate limiting from LI.FI API
   *
   * `opts.force` bypasses the TokenDataService balance cache — refresh()
   * (manual button / post-transaction trigger) passes it so a refresh fired
   * right after a send/swap cannot be served pre-transaction balances. The
   * auto-tick and visibility paths deliberately do NOT (the cache exists to
   * absorb exactly those).
   */
  async loadPortfolio(opts?: { force?: boolean }): Promise<void> {
    // Owner of this request, captured before any await: responses (and
    // failures) arriving after an account switch or disconnect are discarded
    // so account A's state never renders under account B's identity.
    const requestAddress = this.walletService.address();
    if (!requestAddress) {
      this.isLoading.set(false);
      this.isRefreshing.set(false);
      return;
    }

    // Debounce: skip if the last fetch for the SAME account was too recent
    // (prevents rate limiting). An account switch always fetches immediately.
    // `switched` is captured BEFORE updating lastFetchAddress — the
    // background/full decision below needs it to tell an account switch
    // apart from a same-account retry.
    const switched = requestAddress !== this.lastFetchAddress;
    const now = Date.now();
    if (switched) {
      this.lastFetchAddress = requestAddress;
    } else if (now - this.lastFetchTime < this.MIN_FETCH_INTERVAL) {
      return;
    }
    this.lastFetchTime = now;

    // This request now owns the loading flags. A previously issued fetch
    // that finishes later may not touch them (see `finally`) — otherwise
    // account A's slow background tick would kill account B's full-screen
    // loader mid-flight.
    const requestId = ++this.loadRequestId;

    // Full loading state only before the first data/error for THIS account:
    // refreshes (auto-tick, post-transaction, manual, same-account error
    // Retry) keep what is on screen and only spin the refresh icon. An
    // account switch is NOT background — `loadError` belongs to the previous
    // account, and account A's table must not render as account B's while
    // B's first fetch is in flight.
    const isBackground = (!switched && this.loadError()) || this.loadedAddress === requestAddress;
    this.isLoading.set(!isBackground);
    this.isRefreshing.set(isBackground);

    try {
      // Fetch real balances from LI.FI API. The throwing variant lets us
      // tell a fetch failure apart from a genuinely empty wallet.
      const balances = await this.lifiService.getPortfolioBalancesOrThrow(
        requestAddress,
        undefined,
        opts,
      );

      // Stale response — the account changed mid-flight; a newer request
      // owns the state now.
      if (this.walletService.address() !== requestAddress) {
        return;
      }

      // Convert to PortfolioAsset format, filtering only supported networks
      const assets: PortfolioAsset[] = balances
        .filter(token => isSupportedNetwork(token.chainId))
        .map(token => ({
          symbol: token.symbol,
          name: token.name,
          address: token.address,
          logoURI: token.logoURI,
          balance: token.balance,
          balanceUSD: token.balanceUSD,
          priceUSD: token.priceUSD,
          chainId: token.chainId,
        }));

      this.assets.set(assets);
      this.loadedAddress = requestAddress;
      this.lastUpdated.set(new Date());
      this.updateTimeSinceUpdate();
      this.loadError.set(false);
      this.refreshFailed.set(false);
      // Warm the trusted token lists for the chains we now hold assets on
      // (non-blocking — the shown/hidden split fails open until they arrive)
      this.ensureTrustedTokenLists(assets);
    } catch (error) {
      console.error('Error loading portfolio:', error);
      // Stale failure (account switched or disconnected mid-flight) — don't
      // surface the previous account's error under the current identity.
      if (this.walletService.address() !== requestAddress) {
        return;
      }
      if (this.loadedAddress === requestAddress && this.assets().length > 0) {
        // Background refresh failed — keep the data already on screen and
        // surface a non-blocking inline indicator instead of wiping assets.
        this.refreshFailed.set(true);
      } else {
        // First load for THIS account failed — anything on screen belongs to
        // a previous account; clear it and render the error block.
        this.assets.set([]);
        this.lastUpdated.set(null);
        this.updateTimeSinceUpdate();
        this.loadError.set(true);
        this.refreshFailed.set(false);
      }
    } finally {
      // Only the latest request may clear the flags: the try block's stale
      // early-returns (account switched mid-flight) land here too, and a
      // stale request must not hide the spinner a newer request still owns.
      if (requestId === this.loadRequestId) {
        this.isLoading.set(false);
        this.isRefreshing.set(false);
      }
    }
  }

  /**
   * Warm the per-chain token lists that act as the trust source for the
   * shown/hidden split. TokenDataService caches per chain, so repeat loads
   * are free; on failure the chain simply stays fail-open (everything shown).
   */
  private ensureTrustedTokenLists(assets: PortfolioAsset[]): void {
    const cached = this.tokenDataService.cachedTokens();
    for (const chainId of new Set(assets.map(a => a.chainId))) {
      if (!cached.has(chainId)) {
        void this.tokenDataService.getTokensForChain(chainId);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Format USD value */
  /** Broken/missing token logos fall back to generated letter tiles. */
  onTokenImgError(event: Event): void {
    replaceWithLetterIcon(event);
  }

  private static readonly USD_FORMAT = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  formatUSD(value: number): string {
    return DashboardComponent.USD_FORMAT.format(value);
  }

  /** Format token balance */
  formatBalance(value: number, decimals: number = 4): string {
    if (value === 0) return '0';
    if (value < 0.0001) return '< 0.0001';
    return value.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals,
    });
  }

  /** Get network logo */
  getNetworkLogo = getNetworkLogo;
  getNetworkName = getNetworkName;

  /** Select network filter */
  selectNetwork(networkId: number | null): void {
    this.selectedNetwork.set(networkId);
  }

  /** Get balance for a specific network */
  getNetworkBalance(networkId: number): number {
    return this.networkBalances().get(networkId) || 0;
  }

  /** Get token count for a specific network (hidden tokens excluded) */
  getNetworkTokenCount(networkId: number): number {
    return this.shownAssets().filter(asset => asset.chainId === networkId).length;
  }

  /** Format USD value in compact form for filter buttons */
  formatCompactUSD(value: number): string {
    if (value < 1) return '$0';
    if (value < 1000) return `$${value.toFixed(0)}`;
    if (value < 10000) return `$${(value / 1000).toFixed(1)}K`;
    return `$${(value / 1000).toFixed(0)}K`;
  }

  /** Refresh portfolio data (manual refresh bypasses debounce) */
  async refresh(): Promise<void> {
    // Manual refresh bypasses debounce — and the balance TTL cache: this
    // path also serves the post-send/post-swap trigger, where a cache hit
    // would replay pre-transaction balances.
    this.lastFetchTime = 0;
    await this.loadPortfolio({ force: true });
  }
}

