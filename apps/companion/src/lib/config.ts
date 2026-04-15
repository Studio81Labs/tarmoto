/**
 * Base URL for the backend (host only, no path prefix).
 * Strips any trailing /api/v1 in case the env var includes it.
 */
export const API_HOST = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000")
  .replace(/\/api\/v1\/?$/, "");

/** Base URL with the API version prefix, for raw fetch calls. */
export const API_BASE = `${API_HOST}/api/v1`;
