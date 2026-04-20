const FALLBACK_SITE_URL = "https://tarmoto.com";

/**
 * Canonical public site URL for sitemap / robots / OG tags.
 * Override via NEXT_PUBLIC_SITE_URL in each environment; falls back to the
 * production host so dev builds don't leak localhost into generated metadata.
 *
 * Validates the value so a malformed env var doesn't crash `new URL(...)` at
 * request time when the /explore layout builds its metadata.
 */
export function siteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim() || FALLBACK_SITE_URL;
  try {
    return new URL(raw).toString().replace(/\/$/, "");
  } catch {
    return FALLBACK_SITE_URL;
  }
}
