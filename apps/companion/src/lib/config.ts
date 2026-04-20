/**
 * Base URL for the backend (host only, no path prefix).
 * Defaults to empty string (same-origin) so client-side fetches resolve
 * against the current origin — works with Next.js rewrites/proxies in prod.
 * Strips any trailing /api/v1 in case the env var includes it.
 */
export const API_HOST = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(
  /\/api\/v1\/?$/,
  "",
);

/** Base URL with the API version prefix, for raw fetch calls. */
export const API_BASE = `${API_HOST}/api/v1`;

/**
 * Absolute base URL for server-side use (JWT callbacks, etc.).
 * Server-side fetch needs a full URL — relative paths don't resolve.
 */
export const API_BASE_SERVER = `${API_HOST || "http://localhost:3000"}/api/v1`;

/**
 * MapLibre style URL. Until INFRA #79 lands with the custom Tarmoto style
 * and tile pipeline, we use OpenFreeMap's free public Liberty style.
 * Override via NEXT_PUBLIC_MAP_STYLE_URL for staging/branding work.
 */
export const MAP_STYLE_URL =
  process.env.NEXT_PUBLIC_MAP_STYLE_URL ??
  "https://tiles.openfreemap.org/styles/liberty";
