import { cookies, headers } from "next/headers";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  resolveLocale,
  type SupportedLocale,
} from ".";

/**
 * Server-side locale resolution. Used by the root layout to pick the right
 * locale before any client code runs, so the `<html lang>` attribute and the
 * initial render reflect the rider's preference.
 *
 * Precedence: explicit cookie > Accept-Language header > DEFAULT_LOCALE.
 */
export async function readLocale(): Promise<SupportedLocale> {
  try {
    const cookieStore = await cookies();
    const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;
    if (cookieLocale) return resolveLocale(cookieLocale);
  } catch {
    // `cookies()` is not available in some contexts (e.g. static prerender);
    // fall through to header / default.
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
