import { cookies, headers } from "next/headers";
import { cache } from "react";
import {
  canonicalizeFormatLocale,
  createFormatters,
  DEFAULT_FORMAT_LOCALE,
  isValidTimeZone,
  resolveFormatLocaleFromAcceptLanguage,
  type Formatters,
  type UnitSystem,
} from "@tarmoto/shared";
import {
  FORMAT_LOCALE_COOKIE,
  TIMEZONE_COOKIE,
  UNITS_COOKIE,
  type FormatPrefs,
} from ".";

async function resolveFromRequest(): Promise<FormatPrefs> {
  let formatLocale: string | null = null;
  let timeZone: string | null = null;
  let units: UnitSystem = "metric";

  try {
    const cookieStore = await cookies();
    formatLocale = canonicalizeFormatLocale(
      cookieStore.get(FORMAT_LOCALE_COOKIE)?.value,
    );
    const tzCookie = cookieStore.get(TIMEZONE_COOKIE)?.value;
    if (tzCookie !== undefined && isValidTimeZone(tzCookie)) {
      timeZone = tzCookie;
    }
    const unitsCookie = cookieStore.get(UNITS_COOKIE)?.value;
    if (unitsCookie === "imperial" || unitsCookie === "metric") {
      units = unitsCookie;
    }
  } catch {
    // cookies() is unavailable in some contexts (e.g. static prerender);
    // fall through to header / defaults — same pattern as i18n/server.ts.
  }

  if (!formatLocale) {
    try {
      const headerStore = await headers();
      formatLocale = resolveFormatLocaleFromAcceptLanguage(
        headerStore.get("accept-language"),
      );
    } catch {
      // headers() may be unavailable too.
    }
  }

  return {
    formatLocale: formatLocale ?? DEFAULT_FORMAT_LOCALE,
    timeZone: timeZone ?? "UTC",
    units,
  };
}

/**
 * Server-side format-preference resolution, memoized per request via
 * react `cache()` (same idiom as i18n/server.ts). Precedence per value:
 * valid cookie > Accept-Language (format locale only) > en/UTC/metric.
 */
export const readFormatPrefs = cache(
  async (): Promise<FormatPrefs> => resolveFromRequest(),
);

/** Formatters bound to this request's prefs, for server components and route handlers. */
export async function getServerFormatters(): Promise<Formatters> {
  const prefs = await readFormatPrefs();
  return createFormatters({
    locale: prefs.formatLocale,
    timeZone: prefs.timeZone,
    units: prefs.units,
  });
}
