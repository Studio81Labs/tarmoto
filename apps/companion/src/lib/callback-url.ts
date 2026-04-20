/**
 * Resolve a caller-supplied `callbackUrl` to a safe same-origin path.
 *
 * Naïve prefix checks (`startsWith("/") && !startsWith("//")`) are bypassable
 * because the WHATWG URL parser treats `\` as a path separator for http/https,
 * so a value like `/\evil.com` would pass the string check but navigate to
 * `//evil.com` once the browser resolves it. Resolving against the current
 * origin via `new URL()` and comparing `.origin` defers the decision to the
 * same parser the browser will use for the redirect, closing that gap.
 *
 * Always falls back to `/` if the value is missing, cross-origin, or malformed.
 */
export function safeCallbackUrl(raw: string | null | undefined): string {
  if (!raw || typeof window === "undefined") return "/";
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}
