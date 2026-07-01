// Shared between worker.mjs (the Cloudflare Worker) and its tests. The admin
// console calls the backend's prefix-less /admin/* routes same-origin; the
// worker proxies them to the backend so the httpOnly, host-scoped,
// SameSite=Lax tarmoto_admin_* session cookies stay first-party on the console
// origin — the same contract the Vite dev proxy provides locally
// (apps/admin/vite.config.ts). The GitHub OAuth callback rides this branch too,
// so it lands on the clean /admin/auth/sso/github/callback path.
//
// Mirrors the sibling admin workers (tabletap/nexcue): admin routes are
// mounted prefix-less on the backend, and its admin API authenticates the
// session cookie itself (InternalGuard), so this worker additionally injects
// the shared x-internal-token proving the request transited the trusted proxy
// — direct hits that skip the proxy are rejected by the backend (defence in
// depth).

export const API_PROXY_PREFIX = "/admin/";
export const MAX_PROXY_BODY_BYTES = 1024 * 1024;
export const INTERNAL_TOKEN_HEADER = "x-internal-token";

export const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// Spoofable identity headers: never forward the browser's values. The worker
// re-sets the IP headers from Cloudflare's cf-connecting-ip and injects the
// internal token itself.
const STRIPPED_PROXY_HEADERS = new Set([
  INTERNAL_TOKEN_HEADER,
  "x-forwarded-for",
  "x-real-ip",
]);

/**
 * Live proxying needs both the backend base URL and the internal token.
 * Without them the worker can only serve the static console; API calls return
 * 503 rather than half-working against an unreachable/ungated backend.
 */
export function resolveProxyConfig(env = {}) {
  const rawBaseUrl = env.TARMOTO_ADMIN_API_BASE_URL?.trim();
  const internalToken = env.TARMOTO_INTERNAL_API_TOKEN?.trim();

  if (!rawBaseUrl || !internalToken) {
    return { enabled: false };
  }

  try {
    return { enabled: true, baseUrl: new URL(rawBaseUrl), internalToken };
  } catch {
    return { enabled: false };
  }
}

export function shouldForwardProxyHeader(name) {
  const normalized = name.toLowerCase();
  return (
    !HOP_BY_HOP_HEADERS.has(normalized) &&
    !STRIPPED_PROXY_HEADERS.has(normalized)
  );
}
