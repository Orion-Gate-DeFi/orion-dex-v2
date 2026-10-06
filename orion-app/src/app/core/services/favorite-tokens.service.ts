import { Injectable, signal, computed } from '@angular/core';
import { Token } from '../models/token.model';

const STORAGE_KEY = 'orion_favorite_tokens';

/**
 * Favorite token identifier (chainId + address)
 */
interface FavoriteTokenId {
  chainId: number;
  address: string;
}

/**
 * Service for managing user's favorite tokens
 * Persists favorites to localStorage
 */
@Injectable({
  providedIn: 'root'
})
export class FavoriteTokensService {
  /** Set of favorite token IDs for fast lookup */
  private favorites = signal<Set<string>>(new Set());

  /** Array of favorite tokens with full data */
  private favoriteTokens = signal<Token[]>([]);

  constructor() {
    this.loadFromStorage();
  }

  /**
   * Get unique key for a token
   */
  private getTokenKey(chainId: number, address: string): string {
    return `${chainId}:${address.toLowerCase()}`;
  }

  /**
   * Check if a token is in favorites
   */
  isFavorite(chainId: number, address: string): boolean {
    const key = this.getTokenKey(chainId, address);
    return this.favorites().has(key);
  }

  /**
   * Get all favorite tokens for a specific chain
   */
  getFavoritesForChain(chainId: number): Token[] {
    return this.favoriteTokens().filter(t => t.chainId === chainId);
  }

  /**
   * Get all favorite tokens
   */
  getAllFavorites(): Token[] {
    return this.favoriteTokens();
  }

  /**
   * Add a token to favorites
   */
  addFavorite(token: Token): void {
    const key = this.getTokenKey(token.chainId, token.address);

    if (this.favorites().has(key)) {
      return; // Already favorite
    }

    // Update favorites set
    this.favorites.update(set => {
      const newSet = new Set(set);
      newSet.add(key);
      return newSet;
    });

    // Update tokens array
    this.favoriteTokens.update(tokens => [...tokens, token]);

    this.saveToStorage();
  }

  /**
   * Remove a token from favorites
   */
  removeFavorite(chainId: number, address: string): void {
    const key = this.getTokenKey(chainId, address);

    // Update favorites set
    this.favorites.update(set => {
      const newSet = new Set(set);
      newSet.delete(key);
      return newSet;
    });

    // Update tokens array
    this.favoriteTokens.update(tokens =>
      tokens.filter(t => this.getTokenKey(t.chainId, t.address) !== key)
    );

    this.saveToStorage();
  }

  /**
   * Toggle favorite status for a token
   * Returns new favorite status
   */
  toggleFavorite(token: Token): boolean {
    if (this.isFavorite(token.chainId, token.address)) {
      this.removeFavorite(token.chainId, token.address);
      return false;
    } else {
      this.addFavorite(token);
      return true;
    }
  }

  /**
   * Load favorites from localStorage. Filters out anything that isn't a
   * recognisable Token — localStorage is user-writable, so an XSS payload
   * (or a stale serialisation from an old build) could otherwise shove
   * objects through that crash the row renderer or, worse, present a fake
   * "USDC" pinned to the favourites list.
   */
  private loadFromStorage(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return;

      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) return;

      const valid = parsed.filter((t): t is Token => this.isValidToken(t));
      const set = new Set<string>();
      valid.forEach((token) => set.add(this.getTokenKey(token.chainId, token.address)));

      this.favorites.set(set);
      this.favoriteTokens.set(valid);
    } catch (error) {
      console.error('Failed to load favorite tokens:', error);
      // Wipe poisoned data so we don't keep hitting the same parse error.
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    }
  }

  private isValidToken(value: unknown): value is Token {
    if (!value || typeof value !== 'object') return false;
    const t = value as Record<string, unknown>;
    return (
      typeof t['chainId'] === 'number' &&
      Number.isFinite(t['chainId']) &&
      typeof t['address'] === 'string' &&
      /^0x[a-fA-F0-9]{40}$/.test(t['address']) &&
      typeof t['symbol'] === 'string' &&
      t['symbol'].length > 0 &&
      typeof t['decimals'] === 'number' &&
      Number.isFinite(t['decimals']) &&
      t['decimals'] >= 0 &&
      t['decimals'] <= 36
    );
  }

  /**
   * Save favorites to localStorage
   */
  private saveToStorage(): void {
    try {
      const tokens = this.favoriteTokens();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
    } catch (error) {
      console.error('Failed to save favorite tokens:', error);
    }
  }

  /**
   * Get count of favorites for a chain
   */
  getFavoritesCount(chainId?: number): number {
    if (chainId !== undefined) {
      return this.getFavoritesForChain(chainId).length;
    }
    return this.favoriteTokens().length;
  }
}
