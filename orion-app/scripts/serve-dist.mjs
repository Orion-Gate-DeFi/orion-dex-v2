/**
 * Static file server for the built app — used by Playwright in CI.
 *
 * WHY THIS EXISTS: `ng serve` cannot start in CI. Vite's cold dependency
 * pre-bundle tries to resolve `@farcaster/mini-app-solana`, an OPTIONAL peer
 * dependency of @privy-io/react-auth that is legitimately not installed, and
 * fails — the dev server then renders an error overlay over the whole page, so
 * every Playwright click is intercepted. Locally the failure hides behind a warm
 * .angular cache. Serving the production build sidesteps the dev pipeline and
 * has the better property anyway: the suite exercises the artifact that ships.
 *
 * Zero dependencies on purpose (node: builtins only) — nothing to install in CI.
 * SPA fallback: unknown paths return index.html so client-side routes resolve.
 *
 * Usage: node scripts/serve-dist.mjs [port]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(process.argv[2] ?? 'dist/orion-app/browser');
const PORT = Number(process.argv[3] ?? process.env.PORT ?? 4300);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Resolve a request path to a file inside ROOT, or null if it escapes.
 * Decoding happens before normalizing so percent-encoded traversal
 * (`%2e%2e%2f`) is caught by the same containment check as a literal `../`.
 */
function resolveInRoot(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }
  const abs = resolve(join(ROOT, normalize(decoded)));
  return abs === ROOT || abs.startsWith(ROOT + sep) ? abs : null;
}

const server = createServer(async (req, res) => {
  const urlPath = (req.url ?? '/').split('?')[0].split('#')[0];
  const candidate = resolveInRoot(urlPath === '/' ? '/index.html' : urlPath);

  // Anything that escapes the root, and any unknown path, falls back to the
  // SPA shell — the same behaviour Cloudflare Pages gives the deployed site.
  let file = candidate;
  if (file) {
    try {
      const info = await stat(file);
      if (info.isDirectory()) file = join(file, 'index.html');
    } catch {
      file = null;
    }
  }
  if (!file) file = join(ROOT, 'index.html');

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`serving ${ROOT} on http://localhost:${PORT}`);
});
