import { Component, ChangeDetectionStrategy, Input, Output, EventEmitter, inject, signal, OnInit, computed, effect, HostListener, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FocusTrapDirective } from '../../../shared/directives/focus-trap.directive';
import { letterTokenIcon, replaceWithLetterIcon } from '../../../core/utils/token-icon';
import { Token, POPULAR_TOKENS, RWA_TOKEN_SYMBOLS, RWA_TOKEN_INFO, RWA_CHAINS, matchesRwaStockFamily, rwaPinVerdict } from '../../../core/models/token.model';
import { LifiService } from '../../../core/services/lifi.service';
import { WalletService } from '../../../core/services/wallet.service';
import { SettingsService } from '../../../core/services/settings.service';
import { FavoriteTokensService } from '../../../core/services/favorite-tokens.service';
import { TokenSecurityService, RiskLevel } from '../../../core/services/token-security.service';
import { isNativeTokenAddress } from '../../../core/services/swap/swap-execution.service';
import { NETWORKS, NetworkInfo } from '../../../core/constants';

/** Token balance info for display */
interface TokenBalance {
  address: string;
  balance: number;
  balanceUSD: number;
}

@Component({
  selector: 'app-token-selector',
  standalone: true,
  imports: [CommonModule, FormsModule, FocusTrapDirective],
  // Safe on OnPush: all view state is signals/computed; the plain fields
  // (searchQuery, @Inputs) are only mutated from template-bound events,
  // which mark the component dirty themselves.
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './token-selector.component.html',
  styles: [`
    .scrollbar-hide::-webkit-scrollbar {
      display: none;
    }
    .scrollbar-hide {
      -ms-overflow-style: none;
      scrollbar-width: none;
    }
    /* dvh tracks the VISIBLE viewport on mobile (vh ignores iOS Safari's
       browser chrome, so 88vh overflowed the screen); the plain
       redeclaration keeps the vh fallback for older browsers. */
    .selector-shell {
      max-height: 88vh;
      max-height: 88dvh;
    }
    /* Short viewports (landscape phones ~360-400px tall): the shrink-0
       chrome alone can exceed 88dvh, and with no scroll on the shell the
       overflow just clips. Let the WHOLE shell scroll here; on normal
       heights only the token list scrolls (shell overflow stays default).
       The list keeps a real floor too — otherwise flex collapses it to
       0 height (flex-1 + min-h-0) before the shell ever overflows, making
       the rows unreachable instead of the chrome. */
    @media (max-height: 480px) {
      .selector-shell { overflow-y: auto; }
      .selector-shell .token-list {
        min-height: 200px;
        flex-shrink: 0;
      }
    }
  `]
})
export class TokenSelectorComponent implements OnInit {
  settingsService = inject(SettingsService);
  favoriteTokensService = inject(FavoriteTokensService);

  @Input() chainId = 1;
  @Input() selectedToken: Token | null = null;
  @Input() sourceChainId = 1;  // Chain ID of the source token (for cross-chain filtering)
  @Input() selectingFor: 'from' | 'to' = 'from';  // Which field we're selecting for
  /**
   * 'market' (swap): pick anything tradable — tabs, market search, address
   * import with GoPlus. 'holdings' (send): pick from what the user OWNS —
   * balance-only list, no tabs/favorites, no import flow (you can't send
   * what you don't hold). Same component, same a11y, different semantics.
   */
  @Input() mode: 'market' | 'holdings' = 'market';
  /** Parent owns network choice (Send) — render the locked chip instead of pills. */
  @Input() lockNetwork = false;
  @Output() tokenSelected = new EventEmitter<Token>();
  @Output() close = new EventEmitter<void>();

  private lifiService = inject(LifiService);
  private walletService = inject(WalletService);

  // Filter networks based on cross-chain mode and the active list tab.
  // - 'to' token with cross-chain OFF: locked to the source network (this
  //   lock wins over the RWA filter — letting RWA pick a different chain here
  //   would silently break the same-chain promise).
  // - RWA tab (market, unlocked): only chains with curated RWA issuance
  //   (RWA_CHAINS). Every other chain's "RWA" rows would be ticker-squatters
  //   with no verified counterpart, so we don't offer those networks at all.
  // - otherwise: all supported networks.
  networks = computed(() => {
    if (this.selectingFor === 'to' && !this.settingsService.crossChainMode()) {
      return NETWORKS.filter(n => n.id === this.sourceChainId);
    }
    if (this.mode === 'market' && this.listTab() === 'rwa') {
      return NETWORKS.filter(n => RWA_CHAINS.includes(n.id));
    }
    return NETWORKS;
  });

  // Check if network selection is locked (for "You Receive" when cross-chain is off)
  isNetworkLocked = computed(() => {
    // lockNetwork is a static input (modal is recreated per open) — safe to
    // read inside a computed even though it isn't a signal.
    return this.lockNetwork || (this.selectingFor === 'to' && !this.settingsService.crossChainMode());
  });

  selectedNetwork = signal<NetworkInfo | null>(null);
  showNetworkHelp = true; // Show by default for beginners

  searchQuery = '';
  allTokens = signal<Token[]>([]);
  filteredTokens = signal<Token[]>([]);
  isLoading = signal(false);

  /**
   * Which curated list the default (no-search) view shows.
   * - 'popular': curated popular tokens + everything the user holds.
   *   Deliberately NOT "every token with a price" — the priced long tail is
   *   where ticker-squatting scams live, and product direction is to show
   *   only the most popular by default.
   * - 'rwa': tokenized real-world assets (see RWA_TOKEN_SYMBOLS).
   * Search and address-paste are unaffected by the tab.
   */
  listTab = signal<'popular' | 'rwa'>('popular');

  /**
   * Hide near-zero holdings (worth < $1) from the default list. On by default
   * — the curated list is cluttered with airdrop/dust tokens worth cents, and
   * a cleaner first view is what reviewers asked for. Curated popular tokens,
   * favourites and the currently-selected token are NEVER hidden (you must
   * still be able to pick them), and SEARCH is never dust-filtered so a held
   * dust token stays findable by name. Toggle lives in the list-filter row.
   */
  hideDustBalances = signal(true);

  /** USD floor below which a (non-curated) holding counts as dust. */
  private readonly DUST_USD_THRESHOLD = 1;

  toggleHideDust(): void {
    this.hideDustBalances.update((v) => !v);
    // Only the default (no-search) list is dust-filtered — re-derive it.
    if (!this.searchQuery) {
      this.applyDefaultList();
    }
  }

  setListTab(tab: 'popular' | 'rwa'): void {
    this.listTab.set(tab);
    // Entering RWA on a chain with no curated RWA (Optimism/BNB) would strand
    // the user: the network pills now exclude that chain (see `networks()`),
    // so no pill reads as active and the list comes up empty. Move them to
    // Ethereum — the dominant RWA chain — unless the network is locked
    // (Send / cross-chain-off 'to'), where the parent owns the chain.
    if (tab === 'rwa' && !this.isNetworkLocked()) {
      const current = this.selectedNetwork();
      if (!current || !RWA_CHAINS.includes(current.id)) {
        const eth = NETWORKS.find((n) => n.id === 1);
        if (eth) {
          // selectNetwork clears the query and reloads tokens+balances, which
          // re-derives the list via applyDefaultList — nothing more to do.
          this.selectNetwork(eth);
          return;
        }
      }
    }
    // The tab scopes BOTH the default list and an active search — switching
    // tabs mid-search re-runs the query against the new scope.
    if (this.searchQuery) {
      this.filterTokens(this.searchQuery);
    } else {
      this.applyDefaultList();
    }
  }

  /** Token balances for current network - key is lowercase address */
  tokenBalances = signal<Map<string, TokenBalance>>(new Map());
  /** Full token objects the user holds (holdings mode list source). */
  balanceTokens = signal<Token[]>([]);
  isLoadingBalances = signal(false);

  // Computed favorite tokens for selected network
  favoriteTokensForNetwork = computed(() => {
    const network = this.selectedNetwork();
    if (!network) return [];
    return this.favoriteTokensService.getFavoritesForChain(network.id);
  });

  /**
   * Escape closes the modal — required by WCAG 2.1.1 (Keyboard) and a
   * standard pattern users expect. The host's parent listener handles its
   * own dismiss too; this one fires first because it's component-scoped.
   */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close.emit();
  }

  ngOnInit(): void {
    // Set initial network from chainId prop or wallet
    const walletChainId = this.walletService.chainId();
    const initialChainId = this.chainId || walletChainId || 1;

    const availableNetworks = this.networks();
    const network = availableNetworks.find(n => n.id === initialChainId) || availableNetworks[0];
    this.selectedNetwork.set(network);

    // Holdings mode lists only what the user owns — the market token list
    // is dead weight there.
    if (this.mode !== 'holdings') {
      this.loadTokens();
    }
    this.loadBalances();
  }

  selectNetwork(network: NetworkInfo): void {
    this.selectedNetwork.set(network);
    this.searchQuery = '';
    // The imported-token banner describes a token on the PREVIOUS network —
    // clearing the query alone left it warning about a token no longer
    // on screen.
    this.clearImportedToken();
    this.isSearchingByAddress.set(false);
    if (this.mode !== 'holdings') {
      this.loadTokens();
    }
    this.loadBalances();
  }

  /** Category line for RWA rows ("Tokenized gold"), null off the RWA set. */
  rwaCategory(token: Token): string | null {
    return (
      RWA_TOKEN_INFO[token.symbol.toUpperCase()] ??
      matchesRwaStockFamily(token.symbol, token.name)?.category ??
      null
    );
  }

  /**
   * One-tap escape from an empty RWA tab: tokenized treasuries/gold live
   * almost entirely on Ethereum mainnet.
   */
  switchToEthereum(): void {
    const eth = NETWORKS.find((n) => n.id === 1);
    if (eth && !this.isNetworkLocked()) {
      this.selectNetwork(eth);
    }
  }

  /**
   * Load user's token balances for current network
   */
  async loadBalances(): Promise<void> {
    const network = this.selectedNetwork();
    const address = this.walletService.address();

    if (!network || !address) {
      this.tokenBalances.set(new Map());
      return;
    }

    this.isLoadingBalances.set(true);

    try {
      const balances = await this.lifiService.getPortfolioBalances(address, [network.id]);
      const balanceMap = new Map<string, TokenBalance>();

      for (const token of balances) {
        balanceMap.set(token.address.toLowerCase(), {
          address: token.address,
          balance: token.balance,
          balanceUSD: token.balanceUSD,
        });
      }

      this.tokenBalances.set(balanceMap);
      // Re-shape into Token (balances API returns priceUSD as number).
      this.balanceTokens.set(
        balances
          .filter((t) => t.balance > 0)
          .map((t) => ({
            address: t.address,
            symbol: t.symbol,
            name: t.name,
            decimals: t.decimals,
            chainId: t.chainId,
            logoURI: t.logoURI,
            priceUSD: t.priceUSD != null ? String(t.priceUSD) : undefined,
          })),
      );

      // Re-derive the default list now that we know what the user holds —
      // tokens with a positive balance always belong on the default list,
      // even if LI.FI's priceUSD is missing.
      if (!this.searchQuery) {
        this.applyDefaultList();
      }
    } catch (error) {
      console.error('Error loading balances:', error);
      this.tokenBalances.set(new Map());
      this.balanceTokens.set([]);
    } finally {
      this.isLoadingBalances.set(false);
    }
  }

  /**
   * Get balance for a specific token
   */
  getTokenBalance(token: Token): TokenBalance | null {
    const balances = this.tokenBalances();
    return balances.get(token.address.toLowerCase()) || null;
  }

  /**
   * Format balance for display
   */
  formatBalance(balance: number): string {
    if (balance === 0) return '0';
    if (balance < 0.0001) return '<0.0001';
    if (balance < 1) return balance.toFixed(4);
    if (balance < 1000) return balance.toFixed(2);
    return balance.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  async loadTokens(): Promise<void> {
    const network = this.selectedNetwork();
    if (!network) return;

    this.isLoading.set(true);

    try {
      const fetched = await this.lifiService.getTokensForChain(network.id);
      // An empty list (unauthenticated session, proxy hiccup) must not leave
      // the modal blank — the curated popular set always works offline. The
      // catch below handles the throwing failure mode the same way.
      const tokens = fetched.length > 0 ? fetched : [...(POPULAR_TOKENS[network.id] || [])];
      const sorted = tokens.sort((a, b) => {
        // Native gas token leads the whole list (see sortTokensByBalance).
        const aNative = this.isNativeToken(a);
        const bNative = this.isNativeToken(b);
        if (aNative && !bNative) return -1;
        if (!aNative && bNative) return 1;

        const popularTokens = POPULAR_TOKENS[network.id] || [];
        const aPopular = popularTokens.some((p) => p.address.toLowerCase() === a.address.toLowerCase());
        const bPopular = popularTokens.some((p) => p.address.toLowerCase() === b.address.toLowerCase());
        if (aPopular && !bPopular) return -1;
        if (!aPopular && bPopular) return 1;
        return a.symbol.localeCompare(b.symbol);
      });
      this.allTokens.set(sorted);
      // Default view is curated (popular + user holdings, or the RWA tab) —
      // the LI.FI list per chain runs into the thousands and the long tail
      // is dominated by zero-liquidity scam impostors. Any token is still
      // reachable via symbol/name search (trusted set) or address paste.
      this.applyDefaultList();
    } catch (error) {
      console.error('Failed to load tokens:', error);
      const popularTokens = POPULAR_TOKENS[network.id] || [];
      this.allTokens.set(popularTokens);
      this.filteredTokens.set(popularTokens);
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Re-derive the no-search list from the active tab.
   * Popular: curated POPULAR_TOKENS ∪ user holdings ∪ favourites.
   * RWA: curated symbol allowlist matched against the verified LI.FI list,
   *      gated on priceUSD>0 (indexed liquidity) so a squatter using an RWA
   *      ticker without a real market can't ride in.
   */
  private applyDefaultList(): void {
    const network = this.selectedNetwork();
    const tokens = this.allTokens();

    if (this.mode === 'holdings') {
      this.filteredTokens.set(this.sortTokensByBalance(this.balanceTokens()));
      return;
    }

    if (!network) {
      this.filteredTokens.set(tokens.slice(0, 50));
      return;
    }

    if (this.listTab() === 'rwa') {
      // The xStocks family alone is ~65 tickers — a 50-row cap would chop it.
      this.filteredTokens.set(this.sortTokensByBalance(this.rwaTokens(tokens)).slice(0, 120));
      return;
    }

    const popularAddrs = new Set(
      (POPULAR_TOKENS[network.id] || []).map((t) => t.address.toLowerCase()),
    );
    const favoriteAddrs = new Set(
      this.favoriteTokensService
        .getFavoritesForChain(network.id)
        .map((t) => t.address.toLowerCase()),
    );
    const balances = this.tokenBalances();

    const popular = tokens.filter((t) => {
      const addr = t.address.toLowerCase();
      // Curated tokens (popular/favourite) are always offered, dust or not —
      // the user may want to receive USDC even if they hold $0 of it.
      if (popularAddrs.has(addr) || favoriteAddrs.has(addr)) return true;
      const bal = balances.get(addr);
      if (!bal || bal.balance <= 0) return false;
      // A non-curated holding worth < $1 is dust — hide it when the toggle is
      // on, but never hide the token that's already selected.
      if (
        this.hideDustBalances() &&
        bal.balanceUSD < this.DUST_USD_THRESHOLD &&
        !this.isSelectedToken(t)
      ) {
        return false;
      }
      return true;
    });
    this.filteredTokens.set(this.sortTokensByBalance(popular).slice(0, 50));
  }

  /**
   * Curated RWA subset of a token list: symbol allowlist + priced (indexed
   * liquidity), so a squatter using an RWA ticker without a market can't
   * ride in.
   */
  private rwaTokens(tokens: Token[]): Token[] {
    return tokens.filter((t) => {
      // Pinned flagships first: on a pinned chain only the exact verified
      // contract passes — an impostor with the right ticker is rejected
      // before any softer rule can admit it.
      const pin = rwaPinVerdict(t.symbol, t.chainId, t.address);
      if (pin === 'mismatch') return false;
      if (pin === 'match') return true;

      const priceUSD = t.priceUSD ? parseFloat(t.priceUSD) : 0;
      // Curated commodities/treasuries: symbol allowlist + priced.
      if (RWA_TOKEN_SYMBOLS.has(t.symbol.toUpperCase())) return priceUSD > 0;
      // Tokenized stocks: family rules with chain + price-sanity guards.
      return matchesRwaStockFamily(t.symbol, t.name, { chainId: t.chainId, priceUSD }) !== null;
    });
  }

  /**
   * Trust filter for SEARCH results (symbol/name queries).
   *
   * A token is "trusted enough to surface in search" if any of:
   *   1. It's in the curated POPULAR_TOKENS list for the chain.
   *   2. The user holds a positive balance of it (per loadBalances()).
   *   3. LI.FI returned a positive priceUSD — that means the aggregator
   *      indexed liquidity for the pair, which filters out the bulk of
   *      long-tail scam impostors that ride on a popular ticker.
   *
   * (The DEFAULT list is stricter — see applyDefaultList(): only popular,
   * holdings, favourites, or the RWA tab. Search keeps leg 3 so legitimate
   * mid-tail tokens stay findable by name.)
   *
   * Tokens that fail all three are still reachable via address search (the
   * imported-token warning banner gates them with a GoPlus risk read-out).
   */
  private getTrustedTokens(tokens: Token[]): Token[] {
    const network = this.selectedNetwork();
    if (!network) return tokens;

    const popularAddrs = new Set(
      (POPULAR_TOKENS[network.id] || []).map((t) => t.address.toLowerCase()),
    );
    const balances = this.tokenBalances();

    return tokens.filter((t) => {
      const addr = t.address.toLowerCase();
      if (popularAddrs.has(addr)) return true;
      const bal = balances.get(addr);
      if (bal && bal.balance > 0) return true;
      const priceUSD = t.priceUSD ? parseFloat(t.priceUSD) : 0;
      return priceUSD > 0;
    });
  }

  /** The network's gas token (ETH, POL, BNB…) — pinned to the top of the list. */
  private isNativeToken(token: Token): boolean {
    return isNativeTokenAddress(token.address);
  }

  /** The token currently chosen in the parent (never dust-hidden). */
  private isSelectedToken(token: Token): boolean {
    const sel = this.selectedToken;
    return (
      !!sel &&
      sel.chainId === token.chainId &&
      sel.address.toLowerCase() === token.address.toLowerCase()
    );
  }

  /**
   * Sort tokens: the network's native gas token first (users reach for it
   * most — it's what they pay fees in), then tokens with balance, then by
   * balance amount (desc), then alphabetically.
   */
  private sortTokensByBalance(tokens: Token[]): Token[] {
    const balances = this.tokenBalances();

    return [...tokens].sort((a, b) => {
      // Native gas token always leads, regardless of balance.
      const aNative = this.isNativeToken(a);
      const bNative = this.isNativeToken(b);
      if (aNative && !bNative) return -1;
      if (!aNative && bNative) return 1;

      const balanceA = balances.get(a.address.toLowerCase());
      const balanceB = balances.get(b.address.toLowerCase());

      const hasBalanceA = balanceA && balanceA.balance > 0;
      const hasBalanceB = balanceB && balanceB.balance > 0;

      // Tokens with balance come first
      if (hasBalanceA && !hasBalanceB) return -1;
      if (!hasBalanceA && hasBalanceB) return 1;

      // Both have balance - sort by USD value (desc)
      if (hasBalanceA && hasBalanceB) {
        return (balanceB?.balanceUSD || 0) - (balanceA?.balanceUSD || 0);
      }

      // Neither has balance - sort alphabetically
      return a.symbol.localeCompare(b.symbol);
    });
  }

  filterTokens(query: string): void {
    if (!query) {
      // Empty query → back to the curated tab view.
      this.applyDefaultList();
      this.isSearchingByAddress.set(false);
      this.clearImportedToken();
      return;
    }

    const lower = query.toLowerCase().trim();

    // Check if query looks like an address (0x + 40 hex chars)
    const isAddress = /^0x[a-fA-F0-9]{40}$/.test(query.trim());

    // Search through ALL tokens, not just first 50
    // Prioritize exact matches and symbol matches
    const allTokens = this.allTokens();

    // For symbol/name search we filter to trusted tokens — a scam token
    // squatting on the "USDC" ticker shouldn't show up when Alice types
    // "USDC". On the RWA tab, search is further scoped to the RWA set —
    // typing there must not surface the whole market. Address search
    // bypasses both: if the user pasted a specific address, surface the
    // match (the imported-token banner handles risk disclosure).
    const haystack = this.mode === 'holdings'
      ? this.balanceTokens()
      : isAddress
        ? allTokens
        : this.listTab() === 'rwa'
          ? this.rwaTokens(allTokens)
          : this.getTrustedTokens(allTokens);
    const filtered = haystack.filter((t) => {
      const symbolMatch = t.symbol.toLowerCase().includes(lower);
      const nameMatch = t.name.toLowerCase().includes(lower);
      const addressMatch = t.address.toLowerCase() === lower;
      return symbolMatch || nameMatch || addressMatch;
    });

    // Sort: exact symbol match first, then by balance, then alphabetically
    const balances = this.tokenBalances();
    filtered.sort((a, b) => {
      // First priority: exact symbol match
      const aExact = a.symbol.toLowerCase() === lower;
      const bExact = b.symbol.toLowerCase() === lower;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;

      // Second priority: has balance
      const balanceA = balances.get(a.address.toLowerCase());
      const balanceB = balances.get(b.address.toLowerCase());
      const hasBalanceA = balanceA && balanceA.balance > 0;
      const hasBalanceB = balanceB && balanceB.balance > 0;
      if (hasBalanceA && !hasBalanceB) return -1;
      if (!hasBalanceA && hasBalanceB) return 1;

      // Third: sort by USD value if both have balance
      if (hasBalanceA && hasBalanceB) {
        return (balanceB?.balanceUSD || 0) - (balanceA?.balanceUSD || 0);
      }

      return a.symbol.localeCompare(b.symbol);
    });

    this.filteredTokens.set(filtered.slice(0, 50));

    // If it's an address and no tokens found, try to fetch from API.
    // Holdings mode never imports: an address the user doesn't hold simply
    // has nothing to send.
    if (isAddress && filtered.length === 0 && this.mode !== 'holdings') {
      this.isSearchingByAddress.set(true);
      // Drop the PREVIOUS import before fetching the new one — the fetch
      // repopulates the banner for the address actually on screen.
      this.clearImportedToken();
      this.fetchTokenByAddress(query.trim());
    } else {
      // Any query that resolves from the local lists (a name search, or an
      // address already known) must also forget the last imported token —
      // its "Verify carefully" banner otherwise outlives the search that
      // produced it and lands on top of unrelated results.
      this.isSearchingByAddress.set(false);
      this.clearImportedToken();
    }
  }

  /**
   * Forget the last imported-by-address token (banner + GoPlus verdict).
   * Bumping the seq also disowns any in-flight address fetch / risk check
   * so a late response can't resurrect the banner.
   */
  private clearImportedToken(): void {
    this.importedTokenSeq++;
    this.importedToken.set(null);
    this.importedTokenRisk.set(null);
  }

  private tokenSecurity = inject(TokenSecurityService);

  // Signal for address search loading state
  isSearchingByAddress = signal(false);
  importedToken = signal<Token | null>(null);

  /**
   * GoPlus risk for the currently displayed *imported* token. `null` while a
   * check is pending — the UI uses that to show a "checking…" badge instead
   * of pretending the token is verified before we've heard back.
   *
   * Imported (paste-by-address) tokens are the most dangerous surface in the
   * selector: a homoglyph "USDC" with a fake logo can match a popular symbol
   * exactly. Surfacing the risk *here* gives the user a chance to back out
   * before they ever leave the modal — instead of finding out at confirm time.
   */
  importedTokenRisk = signal<RiskLevel | null>(null);
  private importedTokenSeq = 0;

  async fetchTokenByAddress(address: string): Promise<void> {
    const network = this.selectedNetwork();
    if (!network) return;

    const seq = ++this.importedTokenSeq;
    this.importedTokenRisk.set(null);

    try {
      // Use the direct LI.FI API to fetch token by address
      // This will find any token with liquidity, not just cached ones
      const found = await this.lifiService.getTokenByAddress(network.id, address);

      // Bail if a newer search started while we waited.
      if (seq !== this.importedTokenSeq) return;

      if (found) {
        this.importedToken.set(found);
        this.filteredTokens.set([found]);

        // Background security check — don't block the import preview, but
        // populate the risk badge as soon as GoPlus responds.
        this.tokenSecurity
          .checkTokenSecurity(found.chainId, found.address)
          .then((result) => {
            if (seq === this.importedTokenSeq) {
              this.importedTokenRisk.set(result.riskLevel);
            }
          })
          .catch(() => {
            if (seq === this.importedTokenSeq) {
              this.importedTokenRisk.set(null);
            }
          });
      } else {
        // Token not found in LI.FI - no liquidity or not supported
        this.importedToken.set(null);
        this.filteredTokens.set([]);
      }
    } catch (error) {
      console.error('Error fetching token by address:', error);
      if (seq === this.importedTokenSeq) {
        this.importedToken.set(null);
        this.filteredTokens.set([]);
      }
    } finally {
      if (seq === this.importedTokenSeq) {
        this.isSearchingByAddress.set(false);
      }
    }
  }

  selectToken(token: Token): void {
    // Ensure the token has the correct chainId from selected network
    const network = this.selectedNetwork();
    if (network) {
      token = { ...token, chainId: network.id };
    }
    this.tokenSelected.emit(token);
  }

  onImageError(event: Event): void {
    replaceWithLetterIcon(event);
  }

  /** Template src fallback for tokens with no logoURI — letters, no network. */
  tokenIcon(token: Token): string {
    return token.logoURI || letterTokenIcon(token.symbol);
  }

  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

  /** ArrowDown in the search field jumps into the result list. */
  focusFirstRow(event: Event): void {
    event.preventDefault();
    this.elementRef.nativeElement
      .querySelector<HTMLButtonElement>('.orion-token-list-row .row-main')
      ?.focus();
  }

  // Check if query looks like a token address
  isAddressQuery(query: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(query.trim());
  }

  /**
   * Check if token is in favorites
   */
  isFavorite(token: Token): boolean {
    return this.favoriteTokensService.isFavorite(token.chainId, token.address);
  }

  /**
   * Toggle favorite status for a token
   */
  toggleFavorite(event: Event, token: Token): void {
    event.stopPropagation(); // Don't select the token
    this.favoriteTokensService.toggleFavorite(token);
  }
}
