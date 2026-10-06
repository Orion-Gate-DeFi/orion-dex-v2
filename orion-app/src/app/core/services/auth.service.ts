/**
 * =============================================================================
 * AUTH SERVICE
 * =============================================================================
 *
 * This service handles authentication state and tokens:
 * - Retrieves Privy-generated JWT from the React wrapper
 * - Validates JWT presence
 * - Manages local user profile info (wallet address)
 * - Tracks whether the session runs on a Privy embedded wallet and holds the
 *   wallet-export function the React bridge registers (header's
 *   'Export wallet' action)
 *
 * @author Orion DEX Team
 * @version 2.1.0 — token retrieval moved to the module-level privy-bridge
 *                  channel (window.__privyGetAccessToken removed); embedded-
 *                  session flag + wallet export added.
 */

import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { WalletService } from './wallet.service';
import { environment } from '../../../environments/environment';
import { firstValueFrom } from 'rxjs';
import { getAccessToken as getBridgeAccessToken } from '../../shared/components/privy-provider/privy-bridge';

// =============================================================================
// INTERFACES
// =============================================================================

export interface AuthTokens {
  accessToken: string;
}

export interface AuthState {
  isAuthenticated: boolean;
  isAuthenticating: boolean;
  user: UserProfile | null;
  error: string | null;
}

export interface UserProfile {
  walletAddress: string;
  email?: string;
  createdAt?: string;
  referralLink?: string;
}

/** Response of POST /my — backend registration. The backend-issued `token`
 *  is deliberately unused: Privy JWT is the only client credential. */
interface SignupResponse {
  referral_link?: string;
  token?: string;
}


// =============================================================================
// CONSTANTS
// =============================================================================

const STORAGE_KEYS = {
  USER: 'orion_user',
};

// =============================================================================
// AUTH SERVICE
// =============================================================================

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private readonly walletService = inject(WalletService);
  private readonly http = inject(HttpClient);

  // ---------------------------------------------------------------------------
  // Reactive State
  // ---------------------------------------------------------------------------

  private _state = signal<AuthState>({
    isAuthenticated: false,
    isAuthenticating: false,
    user: null,
    error: null,
  });

  readonly state = this._state.asReadonly();
  readonly isAuthenticated = computed(() => this._state().isAuthenticated);
  readonly isAuthenticating = computed(() => this._state().isAuthenticating);
  readonly user = computed(() => this._state().user);
  readonly error = computed(() => this._state().error);

  /**
   * True when the connected wallet is Privy's embedded wallet (social/email
   * login). Set via the React connect callback chain (PrivyWrapper detects
   * walletClientType 'privy' → PrivyProviderComponent → here); cleared on
   * logout. The header gates its 'Export wallet' menu item on this — export
   * only makes sense when Privy custodies the key.
   */
  private readonly _isEmbeddedSession = signal<boolean>(false);
  readonly isEmbeddedSession = this._isEmbeddedSession.asReadonly();

  /**
   * Wallet-export function registered by PrivyWrapper through a callback
   * prop (NOT a window global — the export flow reveals the private key, so
   * it must only be reachable through code paths we own). Null until the
   * lazy React mount completes or after the provider component is destroyed.
   */
  private walletExportFn: (() => Promise<void>) | null = null;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor() {
    this.loadStoredAuth();
    this.setupWalletListener();
  }

  // ---------------------------------------------------------------------------
  // Public Methods
  // ---------------------------------------------------------------------------

  /**
   * Authenticate user using the native Privy JWT.
   * No signing is required, as Privy handles the actual wallet connection and JWT issuance.
   *
   * @param email - Optional email for signup context
   * @returns Promise<boolean> - true if authentication successful
   */
  async authenticate(email?: string): Promise<boolean> {
    const walletAddress = this.walletService.address();

    if (!walletAddress) {
      this._state.update(s => ({ ...s, error: 'Wallet not connected' }));
      return false;
    }

    this._state.update(s => ({ ...s, isAuthenticating: true, error: null }));

    try {
      // Small delay just to ensure the token is ready via the window object
      await new Promise(r => setTimeout(r, 100));
      const token = await this.getAccessTokenAsync();

      if (!token) {
        throw new Error('Failed to retrieve native access token');
      }

      const user: UserProfile = { walletAddress, email };
      this.storeUser(user);

      // Update state
      this._state.set({
        isAuthenticated: true,
        isAuthenticating: false,
        user,
        error: null,
      });

      // Fire-and-forget: backend user row + referral code (see method doc).
      void this.registerWithBackend(walletAddress, email);

      return true;
    } catch (error: any) {
      console.error('Authentication error:', error);
      this._state.update(s => ({
        ...s,
        isAuthenticating: false,
        error: error.message || 'Authentication failed',
      }));
      return false;
    }
  }

  /**
   * Logout user and clear tokens
   */
  logout(): void {
    this.clearUser();
    // The embedded flag describes the CURRENT session — it must not survive
    // logout, or the header would offer 'Export wallet' to the next session
    // before its own connect callback classifies it.
    this._isEmbeddedSession.set(false);
    this._state.set({
      isAuthenticated: false,
      isAuthenticating: false,
      user: null,
      error: null,
    });
  }

  /**
   * Record whether the current session runs on Privy's embedded wallet.
   * Called by PrivyProviderComponent from the connect callback chain.
   */
  setEmbeddedSession(isEmbedded: boolean): void {
    this._isEmbeddedSession.set(isEmbedded);
  }

  /**
   * Register (or clear, with null) the wallet-export function handed up by
   * PrivyWrapper's onExportWalletReady callback prop.
   */
  registerWalletExport(exportFn: (() => Promise<void>) | null): void {
    this.walletExportFn = exportFn;
  }

  /**
   * Open Privy's export-wallet modal (private-key reveal) for the embedded
   * wallet. Throws when no export function is registered (Privy not mounted)
   * or when Privy itself rejects — callers surface that as a toast. The
   * actual key display happens entirely inside Privy's iframe; the key never
   * touches our code.
   */
  async exportWallet(): Promise<void> {
    if (!this.walletExportFn) {
      throw new Error('Wallet export is unavailable — Privy is not ready');
    }
    await this.walletExportFn();
  }

  /**
   * Retrieves the native Privy JWT string asynchronously.
   *
   * Bridge contract (privy-bridge.ts): getAccessToken() is a module-level
   * accessor with queued-await semantics — a call placed before the lazy
   * React mount completes waits INSIDE the bridge, up to
   * BRIDGE_READY_TIMEOUT_MS (15 s), and resolves null on timeout/abort/error.
   * The accessor exists from module load, so the old "slot not yet occupied"
   * window (and this method's former 20×100 ms poll) is gone — the bridge's
   * own deadline is the only wait. A single await below can legitimately
   * take that long.
   *
   * A null result means the user is genuinely logged out, or the Privy mount
   * failed/timed out. DO NOT clearUser() on null — the user might simply be
   * navigating while Privy is still initializing.
   *
   * SINGLE STRIP POINT: Privy occasionally hands us a token wrapped in
   * quotes (`"ey..."`); strip once here so every consumer (interceptor,
   * lifi-fetch patch, gas, tracker, token-data) gets a clean string instead
   * of duplicating the strip. The bridge deliberately returns the token
   * verbatim — never re-strip downstream.
   */
  async getAccessTokenAsync(): Promise<string | null> {
    const token = await getBridgeAccessToken();
    return typeof token === 'string' ? token.replace(/^["']|["']$/g, '') : null;
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Register the user row on the Orion backend (idempotent — the backend
   * returns the existing user's referral link on repeat calls). Runs
   * fire-and-forget after Privy auth succeeds: a backend hiccup must not
   * block login, but new users must get a DB row + referral code.
   */
  private async registerWithBackend(walletAddress: string, email?: string): Promise<void> {
    try {
      const body: { email?: string } = {};
      if (email) {
        body.email = email;
      }
      const response = await firstValueFrom(
        this.http.post<SignupResponse>(`${environment.apiUrl}/my`, body),
      );
      // Guard against resurrection: if the user logged out while the request
      // was in flight, don't write a stale profile back into state/storage.
      if (response?.referral_link && this._state().isAuthenticated) {
        const user: UserProfile = {
          ...(this._state().user ?? { walletAddress }),
          referralLink: response.referral_link,
        };
        this.storeUser(user);
        this._state.update(s => ({ ...s, user }));
      }
    } catch (error) {
      console.warn('[Auth] backend signup failed (non-fatal, will retry next login):', error);
    }
  }

  /**
   * Store user profile in localStorage
   */
  private storeUser(user: UserProfile): void {
    localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user));
  }

  /**
   * Clear all stored user data
   */
  private clearUser(): void {
    localStorage.removeItem(STORAGE_KEYS.USER);
  }

  /**
   * Load stored authentication on app startup. Validates the parsed object
   * before trusting it as a UserProfile — localStorage is user-writable and
   * an injected payload here would mark the app as `isAuthenticated: true`
   * with arbitrary attacker data.
   */
  private loadStoredAuth(): void {
    const userJson = localStorage.getItem(STORAGE_KEYS.USER);
    if (!userJson) return;

    try {
      const parsed = JSON.parse(userJson);
      if (!this.isValidUserProfile(parsed)) {
        console.warn('Stored auth payload failed validation; clearing.');
        this.logout();
        return;
      }
      this._state.set({
        isAuthenticated: true,
        isAuthenticating: false,
        user: parsed,
        error: null,
      });
    } catch (error) {
      console.error('Error loading stored user:', error);
      this.logout();
    }
  }

  private isValidUserProfile(value: unknown): value is UserProfile {
    if (!value || typeof value !== 'object') return false;
    const u = value as Record<string, unknown>;
    if (typeof u['walletAddress'] !== 'string') return false;
    if (!/^0x[a-fA-F0-9]{40}$/.test(u['walletAddress'])) return false;
    if (u['email'] !== undefined && typeof u['email'] !== 'string') return false;
    if (u['createdAt'] !== undefined && typeof u['createdAt'] !== 'string') return false;
    if (u['referralLink'] !== undefined && typeof u['referralLink'] !== 'string') return false;
    return true;
  }

  /**
   * Logout and trigger Privy disconnect
   */
  private logoutWithPrivy(): void {
    this.logout();
    // Trigger Privy logout after a short delay to ensure it's initialized.
    // The lazy-bridge shim REJECTS on abort/timeout — swallow: local state is
    // already cleared and an unhandled rejection would only add Sentry noise.
    setTimeout(() => {
      const privyLogout = (window as any).__privyLogout;
      if (privyLogout) {
        Promise.resolve(privyLogout()).catch(() => {});
      }
    }, 100);
  }

  /**
   * No automatic logout listener needed.
   * Tokens are cleared only on explicit disconnect via handleDisconnect in PrivyProvider.
   */
  private setupWalletListener(): void {
    // Intentionally empty - logout happens only on explicit user action
  }
}
