/**
 * Locale-aware display formatting.
 *
 * `createFormatters` (added alongside these validators) is the single
 * formatting seam for client surfaces. The validators here are shared by
 * the backend DTO layer and the companion capture route so both sides
 * accept exactly the same `format_locale` / `timezone` values.
 */

import {
  celsiusToFahrenheit,
  kmToMiles,
  kmhToMph,
  metersToFeet,
  type UnitSystem,
} from "./units";

export const DEFAULT_FORMAT_LOCALE = "en";
/** BCP-47 tags are bounded well under this; also caps abuse via the wire. */
export const FORMAT_LOCALE_MAX_LENGTH = 35;
/** Matches the varchar(64) shape of `quiet_hours_timezone`. */
export const TIMEZONE_MAX_LENGTH = 64;

/**
 * Returns the canonical BCP-47 form of a locale tag ("CS-cz" → "cs-CZ"),
 * or null when the input is not a well-formed tag. Never throws — cookie
 * and wire input are untrusted.
 */
export function canonicalizeFormatLocale(tag: unknown): string | null {
  if (typeof tag !== "string") return null;
  const trimmed = tag.trim();
  if (!trimmed || trimmed.length > FORMAT_LOCALE_MAX_LENGTH) return null;
  try {
    return Intl.getCanonicalLocales(trimmed)[0] ?? null;
  } catch {
    return null;
  }
}

export function isValidFormatLocale(tag: unknown): tag is string {
  return canonicalizeFormatLocale(tag) !== null;
}

export function isValidTimeZone(zone: unknown): zone is string {
  if (
    typeof zone !== "string" ||
    zone === "" ||
    zone.length > TIMEZONE_MAX_LENGTH
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat(DEFAULT_FORMAT_LOCALE, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Picks the highest-q usable locale tag from an Accept-Language header,
 * keeping the region. Unlike `resolveLocale` (i18n.ts), which reduces to a
 * primary subtag for catalog lookup, "cs-CZ" must stay "cs-CZ" here —
 * number/date formats differ per region, not just per language.
 */
export function resolveFormatLocaleFromAcceptLanguage(
  header: string | null | undefined,
): string | null {
  if (!header) return null;
  const candidates = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      // Case-insensitive and numerically strict, mirroring resolveLocale's
      // q-weight parsing in i18n.ts: only a full `q=<number>` match (any
      // case) overrides the default of 1; anything else is ignored rather
      // than mis-parsed via a lenient case-sensitive prefix + parseFloat.
      let q = 1;
      for (const param of params) {
        const match = /^q=([0-9]*\.?[0-9]+)$/i.exec(param.trim());
        if (match) {
          const parsed = Number.parseFloat(match[1] ?? "");
          if (!Number.isNaN(parsed)) q = parsed;
        }
      }
      return { tag: (tag ?? "").trim(), q };
    })
    .filter((candidate) => candidate.tag !== "" && candidate.tag !== "*")
    .sort((a, b) => b.q - a.q);
  for (const candidate of candidates) {
    const canonical = canonicalizeFormatLocale(candidate.tag);
    if (canonical) return canonical;
  }
  return null;
}

export type DateInput = string | number | Date;

export interface FormatContext {
  /** BCP-47 regional-format tag (e.g. "cs-CZ"). Invalid input falls back to "en". */
  locale: string;
  /** IANA zone instants render in. Invalid/absent falls back to "UTC". */
  timeZone?: string;
  units: UnitSystem;
}

export interface SplitValueUnit {
  value: string;
  unit: string;
}

export interface Formatters {
  /** Resolved (post-fallback) context, for callers that need to introspect. */
  locale: string;
  timeZone: string;
  units: UnitSystem;
  integer(value: number): string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  /** Localized `toFixed` replacement: fixed digits, locale separators/grouping. */
  decimal(value: number, digits: number): string;
  /** Takes a fraction: `percent(0.42)` → "42%". */
  percent(fraction: number): string;
  /** Locale-aware monetary amount, including currency placement/separators. */
  currency(
    value: number,
    currency: string,
    options?: Intl.NumberFormatOptions,
  ): string;
  /** Instant, medium date, in the context timezone. */
  date(value: DateInput): string;
  /** Instant, "18 Apr"-shaped, in the context timezone. */
  shortDate(value: DateInput): string;
  /** Instant, "Apr 2025"-shaped, in the context timezone. */
  monthYear(value: DateInput): string;
  /** Locale month name only ("Apr"), UTC-pinned — for chart axes comparing the same month across years. */
  month(value: DateInput): string;
  /** Compact "Apr 26"-shaped month + 2-digit year, UTC-pinned — for narrow chart axes spanning years. */
  monthYearCompact(value: DateInput): string;
  /** Instant, locale hour-cycle time, in the context timezone. */
  time(value: DateInput): string;
  /** Instant, medium date + short time, in the context timezone. */
  dateTime(value: DateInput): string;
  /** Instant range, "Apr 3 – 9"-shaped, in the context timezone. */
  dateRange(start: DateInput, end: DateInput): string;
  /**
   * Date-only semantics (closure windows, "a day"): UTC-pinned so the
   * rendered day never shifts with the viewer's timezone, locale-formatted.
   */
  calendarDate(value: DateInput): string;
  calendarDateRange(start: DateInput, end: DateInput): string;
  /** "now" / "5m ago" / "3h ago" / "2d ago", absolute `date()` beyond 7 days. */
  relativeTime(value: DateInput, now?: DateInput): string;
  /**
   * Locale-aware compact duration, e.g. "4h 12m" / "52 min" in English.
   * Non-finite input (NaN/Infinity) renders "—" rather than NaN-tainted math.
   */
  duration(totalMinutes: number): string;
  /**
   * "52m" / "4h 12m" — the tight table variant of `duration()`. Same
   * non-finite fallback ("—") as `duration()`.
   */
  durationCompact(totalMinutes: number): string;
  distanceKm(km: number): string;
  distanceM(m: number): string;
  speed(kmh: number): string;
  elevation(m: number): string;
  temperature(c: number): string;
  splitDistanceKm(km: number): SplitValueUnit;
  splitSpeed(kmh: number): SplitValueUnit;
  splitElevation(m: number): SplitValueUnit;
}

// Intl constructor calls are expensive and list renders format thousands of
// values, so instances are memoized per (locale, options). Keys come from
// static option literals below plus the rare ad-hoc `number()` options —
// bounded in practice. Locales are still client-controlled (cookies,
// Accept-Language), so each cache is capped; clearing it wholesale past the
// cap is simpler than LRU bookkeeping and reconstruction is cheap.
const FORMAT_CACHE_MAX = 256;
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>();

function getNumberFormat(
  locale: string,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) {
    if (numberFormats.size >= FORMAT_CACHE_MAX) numberFormats.clear();
    format = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, format);
  }
  return format;
}

export function formatCurrencyAmount(
  value: number,
  currency: string,
  locale = DEFAULT_FORMAT_LOCALE,
  options: Intl.NumberFormatOptions = {},
): string {
  const resolvedLocale =
    canonicalizeFormatLocale(locale) ?? DEFAULT_FORMAT_LOCALE;
  return getNumberFormat(resolvedLocale, {
    style: "currency",
    currency,
    ...options,
  }).format(value);
}

/** Formats an amount expressed in the ISO currency's smallest unit. */
export function formatCurrencyMinorAmount(
  valueMinor: number,
  currency: string,
  locale = DEFAULT_FORMAT_LOCALE,
): string {
  const resolvedLocale =
    canonicalizeFormatLocale(locale) ?? DEFAULT_FORMAT_LOCALE;
  const formatter = getNumberFormat(resolvedLocale, {
    style: "currency",
    currency,
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(valueMinor / 10 ** fractionDigits);
}

function getDateTimeFormat(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = dateTimeFormats.get(key);
  if (!format) {
    if (dateTimeFormats.size >= FORMAT_CACHE_MAX) dateTimeFormats.clear();
    format = new Intl.DateTimeFormat(locale, options);
    dateTimeFormats.set(key, format);
  }
  return format;
}

function getRelativeTimeFormat(
  locale: string,
  options: Intl.RelativeTimeFormatOptions,
): Intl.RelativeTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = relativeTimeFormats.get(key);
  if (!format) {
    if (relativeTimeFormats.size >= FORMAT_CACHE_MAX) {
      relativeTimeFormats.clear();
    }
    format = new Intl.RelativeTimeFormat(locale, options);
    relativeTimeFormats.set(key, format);
  }
  return format;
}

// One malformed wire timestamp must not crash-loop a whole list render, so
// formatters render "" for unparseable dates instead of letting Intl throw.
function toDate(value: DateInput): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function createFormatters(ctx: FormatContext): Formatters {
  const locale = canonicalizeFormatLocale(ctx.locale) ?? DEFAULT_FORMAT_LOCALE;
  const timeZone =
    ctx.timeZone !== undefined && isValidTimeZone(ctx.timeZone)
      ? ctx.timeZone
      : "UTC";
  const units: UnitSystem = ctx.units === "imperial" ? "imperial" : "metric";

  const formatNumber = (
    value: number,
    options: Intl.NumberFormatOptions,
  ): string => getNumberFormat(locale, options).format(value);

  const formatDate = (
    value: DateInput,
    options: Intl.DateTimeFormatOptions,
  ): string => {
    const date = toDate(value);
    return date ? getDateTimeFormat(locale, options).format(date) : "";
  };

  const formatDateRange = (
    start: DateInput,
    end: DateInput,
    options: Intl.DateTimeFormatOptions,
  ): string => {
    const from = toDate(start);
    const to = toDate(end);
    if (!from || !to) return "";
    return getDateTimeFormat(locale, options).formatRange(from, to);
  };

  const unitNumber = (
    value: number,
    unit: string,
    options: Intl.NumberFormatOptions,
  ): string =>
    formatNumber(value, {
      style: "unit",
      unit,
      unitDisplay: "short",
      ...options,
    });

  const splitUnitNumber = (
    value: number,
    unit: string,
    options: Intl.NumberFormatOptions,
  ): SplitValueUnit => {
    const parts = getNumberFormat(locale, {
      style: "unit",
      unit,
      unitDisplay: "short",
      ...options,
    }).formatToParts(value);
    return {
      value: parts
        .filter((part) => part.type !== "unit")
        .map((part) => part.value)
        .join("")
        .trim(),
      unit: parts
        .filter((part) => part.type === "unit")
        .map((part) => part.value)
        .join("")
        .trim(),
    };
  };

  const instant = (
    extra: Intl.DateTimeFormatOptions,
  ): Intl.DateTimeFormatOptions => ({ timeZone, ...extra });
  const calendar = (
    extra: Intl.DateTimeFormatOptions,
  ): Intl.DateTimeFormatOptions => ({ timeZone: "UTC", ...extra });

  const date = (value: DateInput): string =>
    formatDate(value, instant({ dateStyle: "medium" }));

  const relativeTime = (value: DateInput, now?: DateInput): string => {
    const target = toDate(value);
    if (!target) return "";
    const reference =
      (now !== undefined ? toDate(now) : new Date()) ?? new Date();
    const diffMs = target.getTime() - reference.getTime();
    const abs = Math.abs(diffMs);
    const rtf = getRelativeTimeFormat(locale, {
      numeric: "auto",
      style: "narrow",
    });
    if (abs < MINUTE_MS) return rtf.format(0, "second");
    if (abs < HOUR_MS)
      return rtf.format(Math.trunc(diffMs / MINUTE_MS), "minute");
    if (abs < DAY_MS) return rtf.format(Math.trunc(diffMs / HOUR_MS), "hour");
    if (abs <= 7 * DAY_MS)
      return rtf.format(Math.trunc(diffMs / DAY_MS), "day");
    return date(target);
  };

  return {
    locale,
    timeZone,
    units,
    integer: (value) => formatNumber(value, { maximumFractionDigits: 0 }),
    number: (value, options) => formatNumber(value, options ?? {}),
    decimal: (value, digits) =>
      formatNumber(value, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }),
    percent: (fraction) =>
      formatNumber(fraction, { style: "percent", maximumFractionDigits: 0 }),
    currency: (value, currency, options) =>
      formatCurrencyAmount(value, currency, locale, options),
    date,
    shortDate: (value) =>
      formatDate(value, instant({ day: "numeric", month: "short" })),
    monthYear: (value) =>
      formatDate(value, instant({ month: "short", year: "numeric" })),
    month: (value) => formatDate(value, calendar({ month: "short" })),
    monthYearCompact: (value) =>
      formatDate(value, calendar({ month: "short", year: "2-digit" })),
    time: (value) => formatDate(value, instant({ timeStyle: "short" })),
    dateTime: (value) =>
      formatDate(value, instant({ dateStyle: "medium", timeStyle: "short" })),
    dateRange: (start, end) =>
      formatDateRange(start, end, instant({ day: "numeric", month: "short" })),
    calendarDate: (value) =>
      formatDate(value, calendar({ dateStyle: "medium" })),
    calendarDateRange: (start, end) =>
      formatDateRange(start, end, calendar({ day: "numeric", month: "short" })),
    relativeTime,
    duration: (totalMinutes) => {
      if (!Number.isFinite(totalMinutes)) return "—";
      const total = Math.max(0, Math.round(totalMinutes));
      const hours = Math.floor(total / 60);
      const minutes = total % 60;
      if (hours === 0) {
        return unitNumber(minutes, "minute", { unitDisplay: "short" });
      }
      const formattedHours = unitNumber(hours, "hour", {
        unitDisplay: "narrow",
      });
      if (minutes === 0) return formattedHours;
      return `${formattedHours} ${unitNumber(minutes, "minute", {
        unitDisplay: "narrow",
      })}`;
    },
    durationCompact: (totalMinutes) => {
      if (!Number.isFinite(totalMinutes)) return "—";
      const total = Math.max(0, Math.round(totalMinutes));
      const hours = Math.floor(total / 60);
      const minutes = total % 60;
      if (hours === 0) {
        return unitNumber(minutes, "minute", { unitDisplay: "narrow" });
      }
      const formattedHours = unitNumber(hours, "hour", {
        unitDisplay: "narrow",
      });
      if (minutes === 0) return formattedHours;
      return `${formattedHours} ${unitNumber(minutes, "minute", {
        unitDisplay: "narrow",
      })}`;
    },
    distanceKm: (km) =>
      units === "imperial"
        ? unitNumber(kmToMiles(km), "mile", { maximumFractionDigits: 1 })
        : unitNumber(km, "kilometer", { maximumFractionDigits: 1 }),
    distanceM: (m) => {
      if (units === "imperial") {
        // ~1000 ft: below it feet read naturally, above it fractional miles.
        return m < 305
          ? unitNumber(metersToFeet(m), "foot", { maximumFractionDigits: 0 })
          : unitNumber(kmToMiles(m / 1000), "mile", {
              maximumFractionDigits: 1,
            });
      }
      return m < 1000
        ? unitNumber(m, "meter", { maximumFractionDigits: 0 })
        : unitNumber(m / 1000, "kilometer", { maximumFractionDigits: 1 });
    },
    speed: (kmh) =>
      units === "imperial"
        ? unitNumber(kmhToMph(kmh), "mile-per-hour", {
            maximumFractionDigits: 1,
          })
        : unitNumber(kmh, "kilometer-per-hour", { maximumFractionDigits: 0 }),
    elevation: (m) =>
      units === "imperial"
        ? unitNumber(metersToFeet(m), "foot", { maximumFractionDigits: 0 })
        : unitNumber(m, "meter", { maximumFractionDigits: 0 }),
    temperature: (c) =>
      units === "imperial"
        ? unitNumber(celsiusToFahrenheit(c), "fahrenheit", {
            maximumFractionDigits: 1,
          })
        : unitNumber(c, "celsius", { maximumFractionDigits: 1 }),
    splitDistanceKm: (km) =>
      units === "imperial"
        ? splitUnitNumber(kmToMiles(km), "mile", { maximumFractionDigits: 1 })
        : splitUnitNumber(km, "kilometer", { maximumFractionDigits: 1 }),
    splitSpeed: (kmh) =>
      units === "imperial"
        ? splitUnitNumber(kmhToMph(kmh), "mile-per-hour", {
            maximumFractionDigits: 1,
          })
        : splitUnitNumber(kmh, "kilometer-per-hour", {
            maximumFractionDigits: 0,
          }),
    splitElevation: (m) =>
      units === "imperial"
        ? splitUnitNumber(metersToFeet(m), "foot", { maximumFractionDigits: 0 })
        : splitUnitNumber(m, "meter", { maximumFractionDigits: 0 }),
  };
}
