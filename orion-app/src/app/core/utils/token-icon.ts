/**
 * =============================================================================
 * TOKEN ICON FALLBACK
 * =============================================================================
 *
 * Letter-avatar data URIs for tokens without a working logo.
 *
 * Why: the previous fallback pointed at LI.FI's hosted `unknown.svg`, which
 * now 404s — so every broken logo fired `onerror`, reassigned the same dead
 * URL, and looped GET requests forever. A data URI cannot fail to load, so
 * the error chain terminates by construction.
 *
 * Colour is picked deterministically from the Starlight chart ramp so the
 * same token always renders the same tile.
 *
 * @author Orion DEX Team
 * @version 1.0.0
 */

/** Starlight categorical ramp (hex literals: data URIs can't read CSS vars). */
const TILE_COLORS = ['#4D9FFF', '#E8B45A', '#87C58F', '#E3866F', '#D98BA6'] as const;

const cache = new Map<string, string>();

/** "PAXG" → tinted circle with bold "PAX" — same input, same tile, no I/O. */
export function letterTokenIcon(symbol: string | null | undefined): string {
  const letters = (symbol || '?').trim().slice(0, 3).toUpperCase() || '?';
  const cached = cache.get(letters);
  if (cached) return cached;

  let hash = 0;
  for (const ch of letters) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  const color = TILE_COLORS[hash % TILE_COLORS.length];
  const fontSize = letters.length > 2 ? 11 : 14;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">` +
    `<circle cx="20" cy="20" r="20" fill="${color}" fill-opacity="0.16"/>` +
    `<text x="50%" y="50%" dy="0.36em" text-anchor="middle" ` +
    `font-family="Manrope, system-ui, sans-serif" font-size="${fontSize}" ` +
    `font-weight="700" fill="${color}">${letters}</text></svg>`;

  const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  cache.set(letters, uri);
  return uri;
}

/**
 * Shared <img (error)> handler: swap the broken image for the letter tile.
 * The symbol comes from the img's alt text (set to the token symbol across
 * the app). `onerror = null` is belt-and-braces — a data URI can't error.
 */
export function replaceWithLetterIcon(event: Event): void {
  const img = event.target as HTMLImageElement;
  img.onerror = null;
  img.src = letterTokenIcon(img.alt);
}
