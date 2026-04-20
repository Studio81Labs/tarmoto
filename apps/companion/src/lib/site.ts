/**
 * Canonical public site URL for sitemap / robots / OG tags.
 * Override via NEXT_PUBLIC_SITE_URL in each environment; falls back to the
 * production host so dev builds don't leak localhost into generated metadata.
 */
export function siteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL ?? "https://tarmoto.com";
  return raw.replace(/\/$/, "");
}
