import type { UnitSystem } from "@tarmoto/shared";

/**
 * Display-format preference plumbing. Cookies mirror the device (see
 * FormatPrefsSync) so the SERVER can render numbers/dates identically to
 * the client — the provider is always seeded from these server-read
 * values, never from `navigator` at render time, which is what makes the
 * whole seam hydration-safe by construction.
 */
export const FORMAT_LOCALE_COOKIE = "tarmoto-format-locale";
export const TIMEZONE_COOKIE = "tarmoto-timezone";
export const UNITS_COOKIE = "tarmoto-units";

/** Same lifetime as `tarmoto-locale`. */
export const FORMAT_PREFS_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export interface FormatPrefs {
  formatLocale: string;
  timeZone: string;
  units: UnitSystem;
}
