import { cookies, headers } from "next/headers";
import { cache } from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isSupportedLocale,
  resolveLocale,
  setActiveLocale,
  translate as isomorphicTranslate,
  type SupportedLocale,
  type Translate,
} from ".";

/**
 * React `cache()` gives us per-request memoization on the server: every
 * render pass gets its own ref slot, so concurrent requests handled by the
 * same Edge isolate can't see each other's locale through this object. The
 * ref shape (`{ current }`) lets us mutate without re-creating the cache
 * entry on subsequent reads.
 *
 * Only imported by the root layout today; if other server components ever
 * need request-scoped locale access they can call `getServerLocale()`.
 */
const requestLocaleRef = cache((): { current: SupportedLocale } => ({
  current: DEFAULT_LOCALE,
}));

async function resolveFromRequest(): Promise<SupportedLocale> {
  try {
    const cookieStore = await cookies();
    const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;
    if (cookieLocale) {
      // Only honour the cookie if it actually resolves to a registered
      // locale. A stale/tampered cookie — e.g. left over after a locale
      // was removed from the registry — must not pin the user to English
      // when a valid Accept-Language header would otherwise carry them.
      const normalized = cookieLocale.toLowerCase().split("-")[0] ?? "";
      if (isSupportedLocale(normalized)) return normalized;
    }
  } catch {
    // `cookies()` is not available in some contexts (e.g. static prerender);
    // fall through to header / default.
  }

  try {
    // Keep importing the heavy Auth.js module lazy: request-bound `t()` is
    // also used by static/error rendering paths that never need a session.
    const { auth } = await import("@/lib/auth");
    const accountLocale = (await auth())?.user?.language;
    if (accountLocale && isSupportedLocale(accountLocale)) {
      return accountLocale;
    }
  } catch {
    // An unavailable/expired auth session must not block browser detection.
  }

  try {
    const headerStore = await headers();
    const acceptLanguage = headerStore.get("accept-language");
    if (acceptLanguage) return resolveLocale(acceptLanguage);
  } catch {
    // Headers may not be available either.
  }

  return DEFAULT_LOCALE;
}

/**
 * Server-side locale resolution. Used by the root layout to pick the right
 * locale before any client code runs, so the `<html lang>` attribute and the
 * initial render reflect the rider's preference.
 *
 * Two pieces of state are touched on every call:
 *   1. A `cache()`-backed ref — authoritative, per-request, safe under
 *      concurrent renders on the same isolate.
 *   2. The module-level `activeLocale` consumed by the synchronous `t()`
 *      helper — set so server components that import `t` directly (e.g.
 *      `app/(auth)/layout.tsx`) see the right locale by the time React
 *      renders them. Because the root layout awaits `readLocale()` before
 *      returning JSX, the assignment lands before children render in the
 *      same request. Concurrent requests on the same isolate can still
 *      stomp this global at a Suspense boundary — server components that
 *      need strict per-request isolation under concurrent rendering should
 *      either pass `locale` explicitly to `t()` or call `getServerLocale()`.
 *
 * Precedence: explicit cookie > authenticated account language >
 * Accept-Language header > DEFAULT_LOCALE.
 */
export async function readLocale(): Promise<SupportedLocale> {
  const ref = requestLocaleRef();
  const locale = await resolveFromRequest();
  ref.current = locale;
  setActiveLocale(locale);
  return locale;
}

/**
 * Reads the locale resolved earlier in this request. Use this in server
 * components that need strict per-request locale isolation (i.e. cannot
 * tolerate a stale module-global under concurrent rendering).
 */
export function getServerLocale(): SupportedLocale {
  return requestLocaleRef().current;
}

/**
 * Server-bound translator: defaults the locale to `getServerLocale()` (the
 * per-request `cache()` ref), so an awaiting server component is request-safe
 * without threading `locale` by hand. Import `t` from `@/i18n/server` (not
 * `@/i18n`) in server components that render text after an `await`.
 */
export const t: Translate = (key, values, locale) =>
  isomorphicTranslate(key, values, locale ?? getServerLocale());
export const translate = t;
