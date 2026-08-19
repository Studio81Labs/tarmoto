# Companion Locale-Aware Formatting — Foundation (PR 1 + PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation for user-preference-driven display formatting in the companion app: backend contract (`preferences.format_locale`, `preferences.timezone`, tightened `units`), the shared `createFormatters` core, cookie-based autodetection/prefill, the `FormatProvider`/`useFormat` seam, and units account-sync.

**Architecture:** A pure `createFormatters({locale, timeZone, units})` factory in `@tarmoto/shared` (all `Intl.*`, memoized instances) is the single formatting vocabulary. Companion seeds it server-side from cookies (`tarmoto-format-locale`, `tarmoto-timezone`, `tarmoto-units`) so SSR and hydration render identically; a headless `FormatPrefsSync` component detects device values, POSTs `/api/format-prefs` (sets cookies + best-effort PATCH `/me`), and refreshes once on change. Spec: `docs/superpowers/specs/2026-07-16-companion-locale-formatting-design.md`.

**Tech Stack:** TypeScript strict (ES2024 target/lib), native `Intl.*` (zero new dependencies), NestJS 11 + class-validator 0.15, Next.js App Router (edge routes), Zustand, vitest (shared + companion), jest (backend), Playwright (companion e2e).

## Global Constraints

- Zero new npm dependencies — everything uses built-in `Intl.*`.
- TS base config has `noUncheckedIndexedAccess: true` and `exactOptionalPropertyTypes: true` — index access yields `T | undefined`; never assign explicit `undefined` to optional props.
- `packages/shared` must be rebuilt (`pnpm shared:build` from repo root) before backend typecheck/tests or `pnpm openapi:gen` pick up new shared exports.
- Companion CI typechecks test files: run `pnpm typecheck` in `apps/companion` after editing any test.
- Conventional commits, lowercase subjects, scope required (`shared`, `backend`, `companion`, `cross`, `openapi`).
- Quote style: double quotes in `packages/shared` new files and all companion files; single quotes in backend files. Prettier runs via lint-staged on commit either way.
- Backend stores/serves metric only — formatters convert at display time (AGENTS.md).
- New cookies: 1 year, `path:/`, `sameSite:lax`, `httpOnly:false` (mirrors `tarmoto-locale`).
- `notification_preferences.quiet_hours_timezone` and `users.language` are untouched.
- Tasks 1–4 form PR 1 (`feat(cross)` scope overall); Tasks 5–10 form PR 2 (`feat(companion)`). PR 2 builds on PR 1's regenerated OpenAPI client, so execute in order on one branch (stacked) or land PR 1 first.
- All paths below are relative to the repo root.

---

### Task 1: Shared validation helpers (`format.ts` part 1)

**Files:**

- Create: `packages/shared/src/format.ts`
- Create: `packages/shared/src/format.spec.ts`
- Modify: `packages/shared/src/index.ts` (add barrel export)

**Interfaces:**

- Consumes: nothing new.
- Produces (used by Tasks 2, 3, 5, 6, 8):
  - `DEFAULT_FORMAT_LOCALE = "en"`, `FORMAT_LOCALE_MAX_LENGTH = 35`, `TIMEZONE_MAX_LENGTH = 64`
  - `canonicalizeFormatLocale(tag: unknown): string | null`
  - `isValidFormatLocale(tag: unknown): tag is string`
  - `isValidTimeZone(zone: unknown): zone is string`
  - `resolveFormatLocaleFromAcceptLanguage(header: string | null | undefined): string | null`

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/format.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  canonicalizeFormatLocale,
  isValidFormatLocale,
  isValidTimeZone,
  resolveFormatLocaleFromAcceptLanguage,
} from "./format";

describe("canonicalizeFormatLocale", () => {
  it("canonicalizes case per BCP-47", () => {
    expect(canonicalizeFormatLocale("CS-cz")).toBe("cs-CZ");
    expect(canonicalizeFormatLocale("en-gb")).toBe("en-GB");
    expect(canonicalizeFormatLocale("de")).toBe("de");
  });

  it("rejects malformed, empty, oversized, and non-string input", () => {
    expect(canonicalizeFormatLocale("not a locale!")).toBeNull();
    expect(canonicalizeFormatLocale("en_US")).toBeNull(); // underscore is not BCP-47
    expect(canonicalizeFormatLocale("")).toBeNull();
    expect(canonicalizeFormatLocale("x".repeat(36))).toBeNull();
    expect(canonicalizeFormatLocale(null)).toBeNull();
    expect(canonicalizeFormatLocale(42)).toBeNull();
  });
});

describe("isValidFormatLocale", () => {
  it("accepts well-formed tags and rejects garbage", () => {
    expect(isValidFormatLocale("cs-CZ")).toBe(true);
    expect(isValidFormatLocale("klingon locale")).toBe(false);
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA zones", () => {
    expect(isValidTimeZone("Europe/Prague")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects unknown zones, empty, oversized, and non-string input", () => {
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("x".repeat(65))).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
  });
});

describe("resolveFormatLocaleFromAcceptLanguage", () => {
  it("keeps the region of the highest-q tag", () => {
    expect(
      resolveFormatLocaleFromAcceptLanguage("cs-CZ,cs;q=0.9,en;q=0.8"),
    ).toBe("cs-CZ");
  });

  it("honours q-weights over listing order", () => {
    expect(resolveFormatLocaleFromAcceptLanguage("en;q=0.5,de-AT;q=0.9")).toBe(
      "de-AT",
    );
  });

  it("skips wildcards and malformed tags, falling through to the next candidate", () => {
    expect(resolveFormatLocaleFromAcceptLanguage("*,fr-FR;q=0.7")).toBe(
      "fr-FR",
    );
    expect(resolveFormatLocaleFromAcceptLanguage("!!bad!!,en-GB;q=0.1")).toBe(
      "en-GB",
    );
  });

  it("returns null for empty/absent/unusable headers", () => {
    expect(resolveFormatLocaleFromAcceptLanguage(null)).toBeNull();
    expect(resolveFormatLocaleFromAcceptLanguage(undefined)).toBeNull();
    expect(resolveFormatLocaleFromAcceptLanguage("*")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && pnpm test -- format`
Expected: FAIL — `Cannot find module './format'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/format.ts`:

```ts
/**
 * Locale-aware display formatting.
 *
 * `createFormatters` (added alongside these validators) is the single
 * formatting seam for client surfaces. The validators here are shared by
 * the backend DTO layer and the companion capture route so both sides
 * accept exactly the same `format_locale` / `timezone` values.
 */

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
      const qParam = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="));
      const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
      return { tag: (tag ?? "").trim(), q: Number.isNaN(q) ? 0 : q };
    })
    .filter((candidate) => candidate.tag !== "" && candidate.tag !== "*")
    .sort((a, b) => b.q - a.q);
  for (const candidate of candidates) {
    const canonical = canonicalizeFormatLocale(candidate.tag);
    if (canonical) return canonical;
  }
  return null;
}
```

In `packages/shared/src/index.ts`, add after the `export * from "./i18n";` line:

```ts
export * from "./format";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/shared && pnpm test -- format`
Expected: PASS (all `describe` blocks above).

- [ ] **Step 5: Build shared and commit**

```bash
pnpm shared:build
git add packages/shared/src/format.ts packages/shared/src/format.spec.ts packages/shared/src/index.ts
git commit -m "feat(shared): add format-locale and timezone validation helpers"
```

---

### Task 2: Shared `createFormatters` display core (`format.ts` part 2)

**Files:**

- Modify: `packages/shared/src/format.ts` (append)
- Modify: `packages/shared/src/format.spec.ts` (append)

**Interfaces:**

- Consumes: `celsiusToFahrenheit`, `kmToMiles`, `kmhToMph`, `metersToFeet`, `type UnitSystem` from `./units` (existing).
- Produces (used by Tasks 5, 7):
  - `type DateInput = string | number | Date`
  - `interface FormatContext { locale: string; timeZone?: string; units: UnitSystem }`
  - `interface SplitValueUnit { value: string; unit: string }`
  - `interface Formatters` (full method list in the code below)
  - `createFormatters(ctx: FormatContext): Formatters`

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/format.spec.ts`. Add `createFormatters` to the EXISTING `from "./format"` import statement (do not add a second import from the same module), then append:

```ts
/**
 * ICU renders some locales with NBSP ( ) or narrow NBSP ( )
 * where ASCII expectations would use a plain space, and the exact choice
 * shifts between ICU versions. Normalize so the tests assert separators
 * and ordering — the locale-correctness that matters — not ICU trivia.
 */
const norm = (s: string) => s.replace(/[  ]/g, " ");

// 22:30 UTC on 18 Apr 2025 — a day-boundary case: Prague (UTC+2) is
// already 19 Apr, New York (UTC-4) still 18 Apr.
const INSTANT = "2025-04-18T22:30:00Z";

describe("createFormatters — numbers", () => {
  it("groups and decimalizes per locale", () => {
    const en = createFormatters({ locale: "en-US", units: "metric" });
    const cs = createFormatters({ locale: "cs-CZ", units: "metric" });
    const de = createFormatters({ locale: "de-DE", units: "metric" });
    expect(en.integer(12345)).toBe("12,345");
    expect(norm(cs.integer(12345))).toBe("12 345");
    expect(de.decimal(1234.5, 1)).toBe("1.234,5");
    expect(en.decimal(4.2, 1)).toBe("4.2");
    expect(norm(cs.decimal(4.2, 1))).toBe("4,2");
  });

  it("formats percent from a fraction", () => {
    const en = createFormatters({ locale: "en-US", units: "metric" });
    const cs = createFormatters({ locale: "cs-CZ", units: "metric" });
    expect(en.percent(0.42)).toBe("42%");
    expect(norm(cs.percent(0.42))).toBe("42 %");
  });

  it("falls back to en/UTC/metric on invalid context (cookies are untrusted)", () => {
    const f = createFormatters({
      locale: "!!nope!!",
      timeZone: "Mars/Olympus_Mons",
      units: "cubits" as never,
    });
    expect(f.locale).toBe("en");
    expect(f.timeZone).toBe("UTC");
    expect(f.units).toBe("metric");
    expect(f.integer(1000)).toBe("1,000");
  });
});

describe("createFormatters — dates and times", () => {
  it("renders instants in the context timezone (day can shift)", () => {
    const prague = createFormatters({
      locale: "en-GB",
      timeZone: "Europe/Prague",
      units: "metric",
    });
    const ny = createFormatters({
      locale: "en-US",
      timeZone: "America/New_York",
      units: "metric",
    });
    expect(prague.date(INSTANT)).toBe("19 Apr 2025");
    expect(ny.date(INSTANT)).toBe("Apr 18, 2025");
    expect(norm(ny.time(INSTANT))).toBe("6:30 PM");
    expect(prague.time(INSTANT)).toBe("00:30");
  });

  it("localizes date shapes", () => {
    const cs = createFormatters({
      locale: "cs-CZ",
      timeZone: "Europe/Prague",
      units: "metric",
    });
    expect(norm(cs.date(INSTANT))).toBe("19. 4. 2025");
    expect(norm(cs.shortDate(INSTANT))).toContain("19.");
    expect(norm(cs.monthYear(INSTANT))).toContain("2025");
  });

  it("pins calendar dates to UTC regardless of context timezone", () => {
    const prague = createFormatters({
      locale: "en-GB",
      timeZone: "Europe/Prague",
      units: "metric",
    });
    expect(prague.calendarDate(INSTANT)).toBe("18 Apr 2025");
  });

  it("formats ranges via formatRange", () => {
    const en = createFormatters({ locale: "en-US", units: "metric" });
    const range = en.calendarDateRange("2025-04-03", "2025-04-09");
    expect(range).toContain("Apr 3");
    expect(range).toContain("9");
  });

  it("returns empty string for unparseable dates instead of throwing mid-render", () => {
    const en = createFormatters({ locale: "en-US", units: "metric" });
    expect(en.date("not-a-date")).toBe("");
    expect(en.dateRange("not-a-date", INSTANT)).toBe("");
  });
});

describe("createFormatters — relative time", () => {
  const en = createFormatters({ locale: "en-US", units: "metric" });
  const now = new Date("2025-04-18T12:00:00Z");

  it("buckets seconds/minutes/hours/days", () => {
    expect(en.relativeTime("2025-04-18T11:59:30Z", now)).toBe("now");
    expect(norm(en.relativeTime("2025-04-18T11:55:00Z", now))).toMatch(
      /5m ago/,
    );
    expect(norm(en.relativeTime("2025-04-18T09:00:00Z", now))).toMatch(
      /3h ago/,
    );
    expect(norm(en.relativeTime("2025-04-16T12:00:00Z", now))).toMatch(
      /2d ago/,
    );
  });

  it("falls back to an absolute date beyond 7 days", () => {
    expect(en.relativeTime("2025-04-01T12:00:00Z", now)).toBe("Apr 1, 2025");
  });

  it("is locale-aware", () => {
    const cs = createFormatters({ locale: "cs-CZ", units: "metric" });
    expect(norm(cs.relativeTime("2025-04-18T11:55:00Z", now))).toMatch(/před/);
  });
});

describe("createFormatters — duration", () => {
  const en = createFormatters({ locale: "en-US", units: "metric" });
  it("keeps the compact h/m style", () => {
    expect(en.duration(252)).toBe("4h 12m");
    expect(en.duration(52)).toBe("52 min");
    expect(en.duration(120)).toBe("2h");
  });
});

describe("createFormatters — unit-aware measurements", () => {
  const metric = createFormatters({ locale: "en-US", units: "metric" });
  const imperial = createFormatters({ locale: "en-US", units: "imperial" });
  const cs = createFormatters({ locale: "cs-CZ", units: "metric" });

  it("converts and localizes distance", () => {
    expect(norm(metric.distanceKm(1234.5))).toBe("1,234.5 km");
    expect(norm(imperial.distanceKm(100))).toBe("62.1 mi");
    expect(norm(cs.distanceKm(1234.5))).toBe("1 234,5 km");
  });

  it("switches sub-unit for short distances", () => {
    expect(norm(metric.distanceM(850))).toBe("850 m");
    expect(norm(metric.distanceM(1500))).toBe("1.5 km");
    expect(norm(imperial.distanceM(100))).toBe("328 ft");
    expect(norm(imperial.distanceM(5000))).toBe("3.1 mi");
  });

  it("converts speed, elevation, temperature", () => {
    expect(norm(metric.speed(90))).toBe("90 km/h");
    expect(norm(imperial.speed(90))).toBe("55.9 mph");
    expect(norm(metric.elevation(2350))).toBe("2,350 m");
    expect(norm(imperial.elevation(100))).toBe("328 ft");
    expect(norm(metric.temperature(20))).toBe("20°C");
    expect(norm(imperial.temperature(20))).toBe("68°F");
  });

  it("splits value and unit for KPI tiles", () => {
    expect(metric.splitSpeed(90)).toEqual({ value: "90", unit: "km/h" });
    expect(norm(imperial.splitDistanceKm(100).value)).toBe("62.1");
    expect(imperial.splitDistanceKm(100).unit).toBe("mi");
    expect(metric.splitElevation(1234)).toEqual({
      value: "1,234",
      unit: "m",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && pnpm test -- format`
Expected: FAIL — `createFormatters` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `packages/shared/src/format.ts`:

```ts
import {
  celsiusToFahrenheit,
  kmToMiles,
  kmhToMph,
  metersToFeet,
  type UnitSystem,
} from "./units";

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
  /** Instant, medium date, in the context timezone. */
  date(value: DateInput): string;
  /** Instant, "18 Apr"-shaped, in the context timezone. */
  shortDate(value: DateInput): string;
  /** Instant, "Apr 2025"-shaped, in the context timezone. */
  monthYear(value: DateInput): string;
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
  /** "4h 12m" / "52 min" — deliberately locale-neutral in v1 (spec §8). */
  duration(totalMinutes: number): string;
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
// bounded in practice.
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
    format = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, format);
  }
  return format;
}

function getDateTimeFormat(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = dateTimeFormats.get(key);
  if (!format) {
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
    date,
    shortDate: (value) =>
      formatDate(value, instant({ day: "numeric", month: "short" })),
    monthYear: (value) =>
      formatDate(value, instant({ month: "short", year: "numeric" })),
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
      const total = Math.max(0, Math.round(totalMinutes));
      const hours = Math.floor(total / 60);
      const minutes = total % 60;
      if (hours === 0) return `${minutes} min`;
      if (minutes === 0) return `${hours}h`;
      return `${hours}h ${minutes}m`;
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
```

Note: the `import` block goes at the TOP of `format.ts` (imports must precede the Task 1 code); everything else appends after the Task 1 helpers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/shared && pnpm test -- format`
Expected: PASS. If an ICU-variance assertion fails (e.g. a locale renders a different literal), fix the EXPECTATION to the observed locale-correct output — do not weaken `norm()` beyond NBSP variants.

- [ ] **Step 5: Verify the whole shared suite + build, then commit**

Run: `cd packages/shared && pnpm test && pnpm build`
Expected: all existing specs (i18n, constants, email-blocks, feature-flags) still PASS; tsc clean.

```bash
git add packages/shared/src/format.ts packages/shared/src/format.spec.ts
git commit -m "feat(shared): add locale-aware createFormatters display core"
```

---

### Task 3: Backend contract — preference fields + validation

**Files:**

- Create: `apps/backend/src/modules/users/dto/is-format-locale.validator.ts`
- Create: `apps/backend/src/modules/users/dto/update-profile.dto.spec.ts`
- Modify: `apps/backend/src/modules/users/dto/update-profile.dto.ts` (the `UserPreferencesDto` class, lines ~68–97)
- Modify: `apps/backend/src/modules/users/dto/user-response.dto.ts` (the `UserPreferencesResponse` class, lines ~62–83)

**Interfaces:**

- Consumes: `canonicalizeFormatLocale`, `isValidFormatLocale`, `TIMEZONE_MAX_LENGTH` from `@tarmoto/shared` (Task 1 — run `pnpm shared:build` first).
- Produces: `PATCH /api/v1/users/me` accepts `preferences.format_locale` (canonicalized BCP-47) and `preferences.timezone` (IANA); `preferences.units` now rejects non-enum strings; `GET /users/me` echoes both fields. Wire names are exactly `format_locale` and `timezone` (used by Tasks 4, 6, 9).

- [ ] **Step 1: Write the failing DTO validation tests**

Create `apps/backend/src/modules/users/dto/update-profile.dto.spec.ts`:

```ts
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { UpdateProfileDto } from "./update-profile.dto.js";

async function validatePreferences(preferences: Record<string, unknown>) {
  const dto = plainToInstance(UpdateProfileDto, { preferences });
  const errors = await validate(dto);
  return { dto, errors };
}

describe("UpdateProfileDto preferences validation", () => {
  it("accepts and canonicalizes a valid format_locale", async () => {
    const { dto, errors } = await validatePreferences({
      format_locale: "CS-cz",
    });
    expect(errors).toHaveLength(0);
    expect(dto.preferences?.format_locale).toBe("cs-CZ");
  });

  it("rejects a malformed format_locale", async () => {
    const { errors } = await validatePreferences({
      format_locale: "not a locale!",
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts a valid IANA timezone", async () => {
    const { errors } = await validatePreferences({
      timezone: "Europe/Prague",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects an unknown timezone", async () => {
    const { errors } = await validatePreferences({
      timezone: "Mars/Olympus_Mons",
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts enum units and rejects arbitrary strings (closes the @IsString gap)", async () => {
    expect(
      (await validatePreferences({ units: "imperial" })).errors,
    ).toHaveLength(0);
    expect(
      (await validatePreferences({ units: "nautical" })).errors.length,
    ).toBeGreaterThan(0);
  });

  it("still accepts a preferences patch that omits the new fields", async () => {
    const { errors } = await validatePreferences({ daily_km: 250 });
    expect(errors).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm shared:build && cd apps/backend && pnpm test -- update-profile.dto`
Expected: FAIL — most likely as a TypeScript compile error (`format_locale` does not exist on `UserPreferencesDto` yet), which counts as the failing state; once the fields exist but before the decorators/transform are right, the canonicalization assertion and both rejection tests fail at runtime.

- [ ] **Step 3: Write the custom validator decorator**

Create `apps/backend/src/modules/users/dto/is-format-locale.validator.ts`:

```ts
import { registerDecorator, type ValidationOptions } from "class-validator";
import { isValidFormatLocale } from "@tarmoto/shared";

/**
 * Validates a BCP-47 locale tag via `Intl.getCanonicalLocales` (shared with
 * the companion capture route, so both sides accept identical values).
 * Pair with the canonicalizing `@Transform` at the field — this validator
 * sees the already-canonicalized value on the happy path and the raw
 * original when canonicalization failed.
 */
export function IsFormatLocale(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isFormatLocale",
      target: object.constructor,
      propertyName,
      options: {
        message: `${propertyName} must be a valid BCP-47 locale tag (e.g. cs-CZ)`,
        ...options,
      },
      validator: {
        validate: (value: unknown) => isValidFormatLocale(value),
      },
    });
  };
}
```

- [ ] **Step 4: Modify the update DTO**

In `apps/backend/src/modules/users/dto/update-profile.dto.ts`:

1. Change the class-transformer import from `import { Type } from 'class-transformer';` to:

```ts
import { Transform, Type } from "class-transformer";
```

2. Add to the imports:

```ts
import { IsTimeZone } from "class-validator"; // merge into the existing class-validator import list
import { canonicalizeFormatLocale, TIMEZONE_MAX_LENGTH } from "@tarmoto/shared"; // merge into the existing @tarmoto/shared import
import { IsFormatLocale } from "./is-format-locale.validator.js";
```

3. Replace the `units` field of `UserPreferencesDto` and add the two new fields, so the class starts:

```ts
class UserPreferencesDto {
  @IsOptional()
  @IsIn(['metric', 'imperial'])
  units?: 'metric' | 'imperial';

  /**
   * BCP-47 regional-format tag (e.g. "cs-CZ") driving number/date display.
   * Canonicalized on write ("CS-cz" → "cs-CZ"); when canonicalization fails
   * the raw value is kept so @IsFormatLocale rejects it with a 400 instead
   * of a silent null landing in the JSONB.
   */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? (canonicalizeFormatLocale(value) ?? value)
      : value,
  )
  @IsFormatLocale()
  format_locale?: string;

  /** IANA display timezone (e.g. "Europe/Prague"); mirrors the rider's device. */
  @IsOptional()
  @IsTimeZone()
  @MaxLength(TIMEZONE_MAX_LENGTH)
  timezone?: string;
```

(The remaining fields `daily_km` … `route_prefs` stay exactly as they are.)

- [ ] **Step 5: Modify the response DTO**

In `apps/backend/src/modules/users/dto/user-response.dto.ts`, inside `UserPreferencesResponse` after the `units` field, add:

```ts
  @ApiProperty({
    required: false,
    description:
      'BCP-47 regional-format locale (e.g. cs-CZ) driving number/date ' +
      'display. Auto-captured from the rider’s browser; user-editable later.',
  })
  format_locale?: string;

  @ApiProperty({
    required: false,
    description:
      'IANA display timezone (e.g. Europe/Prague). Auto-synced to mirror ' +
      'the rider’s current device (companion FormatPrefsSync).',
  })
  timezone?: string;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/backend && pnpm test -- update-profile.dto`
Expected: PASS (all 6 tests).

Then run the users module suite to catch regressions: `cd apps/backend && pnpm test -- users`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/modules/users/dto/
git commit -m "feat(backend): accept format_locale and timezone user preferences"
```

---

### Task 4: Contract regen + mobile type parity (PR 1 wrap)

**Files:**

- Modify: `apps/mobile/src/types/index.ts` (the `UserPreferences` interface, ~line 99)
- Regenerated: `packages/openapi-client/src/generated/*` (via `pnpm openapi:gen`), postman artifacts (via `pnpm postman:gen`)

**Interfaces:**

- Consumes: Task 3's DTO changes.
- Produces: `components["schemas"]["UserResponseDto"]["preferences"]` and the `UpdateProfileDto` schema carry `format_locale?`/`timezone?`, and `units` is the enum in BOTH schemas — Tasks 6 and 9 rely on the regenerated client typechecking their PATCH bodies.

- [ ] **Step 1: Regenerate the OpenAPI client and postman artifacts**

```bash
pnpm openapi:gen
pnpm postman:gen
```

Expected: both succeed. The openapi step compiles the backend with the strict tsconfig — `noUncheckedIndexedAccess` errors surface HERE even when `nest build` passed (known repo gotcha); fix any such error in the Task 3 files before proceeding.

- [ ] **Step 2: Verify the generated schema carries the new fields**

Run: `grep -n "format_locale" packages/openapi-client/src/generated/schema.d.ts | head`
Expected: hits in both `UserResponseDto`→`preferences` and `UpdateProfileDto`→`preferences`. Also verify units tightened:
`grep -n '"metric" | "imperial"' packages/openapi-client/src/generated/schema.d.ts | head`
Expected: present for the UpdateProfileDto preferences (previously plain `string`).

- [ ] **Step 3: Mobile type parity**

In `apps/mobile/src/types/index.ts`, extend the interface:

```ts
export interface UserPreferences {
  units: "metric" | "imperial";
  daily_km: number;
  min_quality: number;
  road_types: string[];
  record_gps: boolean;
  crash_detection: boolean;
  /** BCP-47 regional-format tag captured by companion; unused by mobile yet. */
  format_locale?: string;
  /** IANA display timezone captured by companion; unused by mobile yet. */
  timezone?: string;
}
```

- [ ] **Step 4: Typecheck the consumers**

```bash
(cd apps/mobile && pnpm typecheck)
(cd apps/companion && pnpm typecheck)
```

Expected: both PASS (additive optional fields break nothing).

- [ ] **Step 5: Commit (PR 1 is complete after this)**

```bash
git add packages/openapi-client packages/openapi apps/mobile/src/types/index.ts
git commit -m "chore(cross): regen contracts and mobile type parity for format prefs"
```

Note: also `git add` any postman collection files `pnpm postman:gen` rewrote (check `git status`). PR 1 boundary — title suggestion: `feat(cross): format-locale + timezone user preferences and shared display formatters`.

---

### Task 5: Companion format module — constants + server resolution

**Files:**

- Create: `apps/companion/src/format/index.ts`
- Create: `apps/companion/src/format/server.ts`
- Create: `apps/companion/src/format/server.test.ts`

**Interfaces:**

- Consumes: Task 1 validators, Task 2 `createFormatters`/`Formatters`, `UnitSystem` from `@tarmoto/shared`.
- Produces (used by Tasks 6–9):
  - `FORMAT_LOCALE_COOKIE = "tarmoto-format-locale"`, `TIMEZONE_COOKIE = "tarmoto-timezone"`, `UNITS_COOKIE = "tarmoto-units"`, `FORMAT_PREFS_COOKIE_MAX_AGE_SECONDS`
  - `type FormatPrefs = { formatLocale: string; timeZone: string; units: UnitSystem }`
  - `readFormatPrefs(): Promise<FormatPrefs>` (server-only), `getServerFormatters(): Promise<Formatters>` (server-only)

- [ ] **Step 1: Write the constants module**

Create `apps/companion/src/format/index.ts`:

```ts
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
```

- [ ] **Step 2: Write the failing server-resolution tests**

Create `apps/companion/src/format/server.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFormatPrefs } from "./server";

// vi.hoisted so the mock factory's state exists when vi.mock is hoisted
// above the imports — a plain top-level const would hit the TDZ.
const state = vi.hoisted(() => ({
  cookieJar: new Map<string, string>(),
  acceptLanguage: null as string | null,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = state.cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => ({
    get: (name: string) =>
      name.toLowerCase() === "accept-language" ? state.acceptLanguage : null,
  }),
}));

describe("readFormatPrefs", () => {
  beforeEach(() => {
    state.cookieJar.clear();
    state.acceptLanguage = null;
  });

  it("prefers valid cookies", async () => {
    state.cookieJar.set("tarmoto-format-locale", "cs-CZ");
    state.cookieJar.set("tarmoto-timezone", "Europe/Prague");
    state.cookieJar.set("tarmoto-units", "imperial");
    await expect(readFormatPrefs()).resolves.toEqual({
      formatLocale: "cs-CZ",
      timeZone: "Europe/Prague",
      units: "imperial",
    });
  });

  it("falls back to the full Accept-Language tag when the locale cookie is absent", async () => {
    state.acceptLanguage = "de-AT,de;q=0.9,en;q=0.8";
    const prefs = await readFormatPrefs();
    expect(prefs.formatLocale).toBe("de-AT");
  });

  it("ignores tampered cookies and falls back to defaults", async () => {
    state.cookieJar.set("tarmoto-format-locale", "!!bad!!");
    state.cookieJar.set("tarmoto-timezone", "Mars/Olympus_Mons");
    state.cookieJar.set("tarmoto-units", "cubits");
    await expect(readFormatPrefs()).resolves.toEqual({
      formatLocale: "en",
      timeZone: "UTC",
      units: "metric",
    });
  });

  it("defaults to en/UTC/metric with nothing to go on", async () => {
    await expect(readFormatPrefs()).resolves.toEqual({
      formatLocale: "en",
      timeZone: "UTC",
      units: "metric",
    });
  });
});
```

Note: `readFormatPrefs` is wrapped in react `cache()`, which memoizes per server request; under vitest there is no request boundary, but each call in these tests still resolves fresh because `cache()` outside a React render falls back to calling the function. If a memoization artifact ever surfaces here, call `vi.resetModules()` + dynamic-import `./server` per test instead.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/companion && pnpm test -- src/format/server.test.ts`
Expected: FAIL — `./server` doesn't exist.

- [ ] **Step 4: Write the server module**

Create `apps/companion/src/format/server.ts`:

```ts
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
export const readFormatPrefs = cache(async (): Promise<FormatPrefs> =>
  resolveFromRequest(),
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/companion && pnpm test -- src/format/server.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
(cd apps/companion && pnpm typecheck)
git add apps/companion/src/format/
git commit -m "feat(companion): add format-prefs cookies and server resolution"
```

---

### Task 6: `/api/format-prefs` capture route

**Files:**

- Create: `apps/companion/src/app/api/format-prefs/route.ts`
- Create: `apps/companion/src/app/api/format-prefs/route.test.ts`

**Interfaces:**

- Consumes: Task 5 cookie constants; Task 4 regenerated client (`apiServer.PATCH` body now accepts `preferences.format_locale`/`timezone`); `auth`/`apiServer` exactly as `src/app/api/locale/route.ts` does.
- Produces: `POST /api/format-prefs` `{ format_locale, timezone }` → 200 `{ format_locale: <canonical>, timezone }` + both cookies set + best-effort record sync. Task 8 calls it.

- [ ] **Step 1: Write the failing route tests**

Create `apps/companion/src/app/api/format-prefs/route.test.ts` (mirrors the locale route suite — same mock idioms, adapted payloads):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { POST } from "./route";
import { auth } from "@/lib/auth";
import { apiServer } from "@/lib/api/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/api/server", () => ({ apiServer: { PATCH: vi.fn() } }));

// Same type-only cast rationale as api/locale/route.test.ts: `auth` is
// overloaded and vi.mocked only sees the last overload.
const mockedAuth = vi.mocked(auth as unknown as () => Promise<Session | null>);
const patch = vi.mocked(apiServer.PATCH);

const AUTHENTICATED_SESSION: Session = {
  user: {
    id: "user-1",
    email: "rider@example.com",
    displayName: "Rider One",
  },
  accessToken: "access-token-abc",
  expires: "2099-01-01T00:00:00.000Z",
};

// Mirrors FORMAT_PREFS_SYNC_TIMEOUT_MS in route.ts (internal constant).
const SYNC_TIMEOUT_MS = 3000;

function postRequest(body: unknown) {
  return new Request("http://localhost/api/format-prefs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function patchResult(status: number, body: unknown = {}) {
  const ok = status >= 200 && status < 300;
  return {
    data: ok ? body : undefined,
    error: ok ? undefined : body,
    response: new Response(null, { status }),
  } as unknown as Awaited<ReturnType<typeof apiServer.PATCH>>;
}

const VALID = { format_locale: "cs-CZ", timezone: "Europe/Prague" };

describe("POST /api/format-prefs", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    patch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets both cookies and persists to the user record when authenticated", async () => {
    mockedAuth.mockResolvedValueOnce(AUTHENTICATED_SESSION);
    patch.mockResolvedValueOnce(patchResult(200, {}));

    const response = await POST(postRequest(VALID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(VALID);
    expect(response.cookies.get("tarmoto-format-locale")?.value).toBe("cs-CZ");
    expect(response.cookies.get("tarmoto-timezone")?.value).toBe(
      "Europe/Prague",
    );

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("/api/v1/users/me", {
      body: {
        preferences: { format_locale: "cs-CZ", timezone: "Europe/Prague" },
      },
      headers: { Authorization: "Bearer access-token-abc" },
      signal: expect.any(AbortSignal),
    });
  });

  it("canonicalizes the locale before storing and echoing it", async () => {
    mockedAuth.mockResolvedValueOnce(null);

    const response = await POST(
      postRequest({ format_locale: "CS-cz", timezone: "Europe/Prague" }),
    );

    expect(response.status).toBe(200);
    expect(response.cookies.get("tarmoto-format-locale")?.value).toBe("cs-CZ");
    await expect(response.json()).resolves.toMatchObject({
      format_locale: "cs-CZ",
    });
  });

  it("does not call the backend when unauthenticated, but still sets cookies", async () => {
    mockedAuth.mockResolvedValueOnce(null);

    const response = await POST(postRequest(VALID));

    expect(response.status).toBe(200);
    expect(response.cookies.get("tarmoto-format-locale")?.value).toBe("cs-CZ");
    expect(patch).not.toHaveBeenCalled();
  });

  it("returns the cookie response even when auth() hangs indefinitely", async () => {
    vi.useFakeTimers();
    mockedAuth.mockReturnValueOnce(new Promise<Session | null>(() => {}));

    const responsePromise = POST(postRequest(VALID));
    await vi.advanceTimersByTimeAsync(SYNC_TIMEOUT_MS + 1);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(response.cookies.get("tarmoto-timezone")?.value).toBe(
      "Europe/Prague",
    );
    expect(patch).not.toHaveBeenCalled();
  });

  it("does not fire a stale PATCH when auth() resolves after the deadline", async () => {
    vi.useFakeTimers();
    let releaseAuth!: (session: Session | null) => void;
    mockedAuth.mockReturnValueOnce(
      new Promise<Session | null>((resolve) => {
        releaseAuth = resolve;
      }),
    );

    const responsePromise = POST(postRequest(VALID));
    await vi.advanceTimersByTimeAsync(SYNC_TIMEOUT_MS + 1);
    await responsePromise;

    releaseAuth(AUTHENTICATED_SESSION);
    await vi.advanceTimersByTimeAsync(0);

    expect(patch).not.toHaveBeenCalled();
  });

  it("swallows backend failures and still returns the cookie-set response", async () => {
    mockedAuth.mockResolvedValueOnce(AUTHENTICATED_SESSION);
    patch.mockRejectedValueOnce(new Error("backend unreachable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(postRequest(VALID));

    expect(response.status).toBe(200);
    expect(response.cookies.get("tarmoto-format-locale")?.value).toBe("cs-CZ");
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to persist format preferences to user record",
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  it("rejects an invalid format_locale with 400, before auth or backend", async () => {
    const response = await POST(
      postRequest({ format_locale: "!!bad!!", timezone: "Europe/Prague" }),
    );
    expect(response.status).toBe(400);
    expect(mockedAuth).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("rejects an invalid or missing timezone with 400", async () => {
    expect(
      (
        await POST(
          postRequest({ format_locale: "cs-CZ", timezone: "Mars/Olympus" }),
        )
      ).status,
    ).toBe(400);
    expect((await POST(postRequest({ format_locale: "cs-CZ" }))).status).toBe(
      400,
    );
    expect((await POST(postRequest(null))).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/companion && pnpm test -- src/app/api/format-prefs`
Expected: FAIL — `./route` doesn't exist.

- [ ] **Step 3: Write the route**

Create `apps/companion/src/app/api/format-prefs/route.ts`:

```ts
import { NextResponse } from "next/server";
import { canonicalizeFormatLocale, isValidTimeZone } from "@tarmoto/shared";
import {
  FORMAT_LOCALE_COOKIE,
  FORMAT_PREFS_COOKIE_MAX_AGE_SECONDS,
  TIMEZONE_COOKIE,
} from "@/format";
import { auth } from "@/lib/auth";
import { apiServer } from "@/lib/api/server";

// Same bounded best-effort shape as /api/locale — see that route's comments
// for the full rationale (timeout owns an AbortController so a stalled
// auth()/PATCH can neither delay the cookie response nor fire late with
// since-superseded values).
const FORMAT_PREFS_SYNC_TIMEOUT_MS = 3000;

async function syncFormatPrefsToUserRecord(
  formatLocale: string,
  timezone: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    const session = await auth();
    if (!session?.user || signal.aborted) return;

    const { error, response } = await apiServer.PATCH("/api/v1/users/me", {
      body: { preferences: { format_locale: formatLocale, timezone } },
      headers: { Authorization: `Bearer ${session.accessToken}` },
      signal,
    });
    if (!response.ok) {
      console.error(
        "Failed to persist format preferences to user record",
        error,
      );
    }
  } catch (error) {
    console.error("Failed to persist format preferences to user record", error);
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = (body ?? {}) as { format_locale?: unknown; timezone?: unknown };
  const formatLocale = canonicalizeFormatLocale(raw.format_locale);
  if (!formatLocale) {
    return NextResponse.json(
      { error: "Invalid format_locale" },
      { status: 400 },
    );
  }
  if (!isValidTimeZone(raw.timezone)) {
    return NextResponse.json({ error: "Invalid timezone" }, { status: 400 });
  }
  const timezone = raw.timezone;

  const response = NextResponse.json({ format_locale: formatLocale, timezone });
  const cookieOptions = {
    path: "/",
    maxAge: FORMAT_PREFS_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
    httpOnly: false,
  } as const;
  response.cookies.set(FORMAT_LOCALE_COOKIE, formatLocale, cookieOptions);
  response.cookies.set(TIMEZONE_COOKIE, timezone, cookieOptions);

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    syncFormatPrefsToUserRecord(formatLocale, timezone, controller.signal),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve();
      }, FORMAT_PREFS_SYNC_TIMEOUT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);

  return response;
}

export const runtime = "edge";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/companion && pnpm test -- src/app/api/format-prefs`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck (the PATCH body must typecheck against the regenerated client) and commit**

```bash
(cd apps/companion && pnpm typecheck)
git add apps/companion/src/app/api/format-prefs/
git commit -m "feat(companion): add format-prefs capture route"
```

---

### Task 7: `FormatProvider` / `useFormat` + app wiring

**Files:**

- Create: `apps/companion/src/format/FormatProvider.tsx`
- Create: `apps/companion/src/format/FormatProvider.test.tsx`
- Modify: `apps/companion/src/components/AppProviders.tsx`
- Modify: `apps/companion/src/app/layout.tsx`
- Modify: `apps/companion/src/stores/preferences.ts` (add `hydrated` flag only — the rest of the store changes come in Task 9)

**Interfaces:**

- Consumes: Task 2 `createFormatters`/`Formatters`; Task 5 `FormatPrefs`/`readFormatPrefs`; `usePreferencesStore`.
- Produces: `FormatProvider({ children, formatLocale, timeZone, units })` and `useFormat(): Formatters` — THE client formatting seam every future call-site migration imports from `@/format/FormatProvider`.

- [ ] **Step 1: Add the `hydrated` flag to the preferences store**

In `apps/companion/src/stores/preferences.ts`:

1. Extend the interface:

```ts
interface PreferencesState {
  unitSystem: UnitSystem;
  /** True once localStorage has been read; the FormatProvider keeps using
   *  the server-seeded units until then so SSR and first paint agree. */
  hydrated: boolean;
  setUnitSystem: (units: UnitSystem) => void;
  hydrate: () => void;
}
```

2. Update the store creation:

```ts
export const usePreferencesStore = create<PreferencesState>((set) => ({
  unitSystem: "metric",
  hydrated: false,
  setUnitSystem: (units) => {
    saveUnitSystem(units);
    set({ unitSystem: units });
  },
  hydrate: () => {
    set({ unitSystem: loadUnitSystem(), hydrated: true });
  },
}));
```

- [ ] **Step 2: Write the failing provider tests**

Create `apps/companion/src/format/FormatProvider.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { act } from "react";
import { FormatProvider, useFormat } from "./FormatProvider";
import { usePreferencesStore } from "@/stores/preferences";

const norm = (s: string) => s.replace(/[  ]/g, " ");

function Probe() {
  const format = useFormat();
  return (
    <div>
      <span data-testid="date">{format.date("2025-04-18T22:30:00Z")}</span>
      <span data-testid="int">{format.integer(12345)}</span>
      <span data-testid="dist">{format.distanceKm(100)}</span>
    </div>
  );
}

function renderWithProvider() {
  return render(
    <FormatProvider
      formatLocale="cs-CZ"
      timeZone="Europe/Prague"
      units="metric"
    >
      <Probe />
    </FormatProvider>,
  );
}

afterEach(() => {
  act(() => {
    usePreferencesStore.setState({ unitSystem: "metric", hydrated: false });
  });
});

describe("FormatProvider", () => {
  it("formats via the server-seeded context (locale, timezone, units)", () => {
    renderWithProvider();
    // Prague is UTC+2 on 18 Apr 22:30Z — the local day is the 19th.
    expect(norm(screen.getByTestId("date").textContent ?? "")).toBe(
      "19. 4. 2025",
    );
    expect(norm(screen.getByTestId("int").textContent ?? "")).toBe("12 345");
    expect(norm(screen.getByTestId("dist").textContent ?? "")).toBe("100 km");
  });

  it("keeps server-seeded units until the store hydrates, then follows it", () => {
    renderWithProvider();
    expect(norm(screen.getByTestId("dist").textContent ?? "")).toBe("100 km");

    act(() => {
      usePreferencesStore.setState({ unitSystem: "imperial", hydrated: true });
    });
    expect(norm(screen.getByTestId("dist").textContent ?? "")).toBe("62,1 mi");
  });

  it("ignores a pre-hydration store value (SSR/client first paint must agree)", () => {
    act(() => {
      usePreferencesStore.setState({ unitSystem: "imperial", hydrated: false });
    });
    renderWithProvider();
    expect(norm(screen.getByTestId("dist").textContent ?? "")).toBe("100 km");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/companion && pnpm test -- src/format/FormatProvider`
Expected: FAIL — `./FormatProvider` doesn't exist.

- [ ] **Step 4: Write the provider**

Create `apps/companion/src/format/FormatProvider.tsx`:

```tsx
"use client";

import { createContext, useContext, useMemo } from "react";
import {
  createFormatters,
  DEFAULT_FORMAT_LOCALE,
  type Formatters,
  type UnitSystem,
} from "@tarmoto/shared";
import { usePreferencesStore } from "@/stores/preferences";

const FormatContext = createContext<Formatters>(
  createFormatters({ locale: DEFAULT_FORMAT_LOCALE, units: "metric" }),
);

/**
 * Binds `createFormatters` to the request's format preferences. Props are
 * ALWAYS the server-resolved cookie values (see format/server.ts) — never
 * read `navigator` here — so server HTML and the hydration pass agree by
 * construction. Units switch to the client store only after it hydrates
 * (a normal post-hydration state update); the units cookie keeps that
 * switch a no-op in the steady state.
 */
export function FormatProvider({
  children,
  formatLocale,
  timeZone,
  units,
}: {
  children: React.ReactNode;
  formatLocale: string;
  timeZone: string;
  units: UnitSystem;
}) {
  const hydrated = usePreferencesStore((s) => s.hydrated);
  const storeUnits = usePreferencesStore((s) => s.unitSystem);
  const effectiveUnits = hydrated ? storeUnits : units;

  const value = useMemo(
    () =>
      createFormatters({
        locale: formatLocale,
        timeZone,
        units: effectiveUnits,
      }),
    [formatLocale, timeZone, effectiveUnits],
  );

  return (
    <FormatContext.Provider value={value}>{children}</FormatContext.Provider>
  );
}

/** The client-side formatting seam. Server components use `getServerFormatters()`. */
export function useFormat(): Formatters {
  return useContext(FormatContext);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/companion && pnpm test -- src/format/FormatProvider`
Expected: PASS (3 tests).

- [ ] **Step 6: Wire the provider through AppProviders and the root layout**

Replace `apps/companion/src/components/AppProviders.tsx` with:

```tsx
"use client";

import dynamic from "next/dynamic";
import { I18nProvider } from "@/i18n/I18nProvider";
import { FormatProvider } from "@/format/FormatProvider";
import type { FormatPrefs } from "@/format";
import { usePathname } from "next/navigation";
import { NetworkStatusProvider } from "./NetworkStatusProvider";
import { ToastHost } from "./ToastHost";

const AuthenticatedAppProviders = dynamic(() =>
  import("./AuthenticatedAppProviders").then(
    (module) => module.AuthenticatedAppProviders,
  ),
);

export function AppProviders({
  children,
  locale,
  formatPrefs,
}: {
  children: React.ReactNode;
  locale?: string | null;
  formatPrefs: FormatPrefs;
}) {
  const pathname = usePathname();

  const localeProp = locale !== undefined ? { locale } : {};
  const formatProps = {
    formatLocale: formatPrefs.formatLocale,
    timeZone: formatPrefs.timeZone,
    units: formatPrefs.units,
  };

  if (pathname === "/embed" || pathname.startsWith("/embed/")) {
    return (
      <I18nProvider {...localeProp}>
        <FormatProvider {...formatProps}>{children}</FormatProvider>
      </I18nProvider>
    );
  }

  return (
    <I18nProvider {...localeProp}>
      <FormatProvider {...formatProps}>
        <NetworkStatusProvider />
        <AuthenticatedAppProviders>{children}</AuthenticatedAppProviders>
        <ToastHost />
      </FormatProvider>
    </I18nProvider>
  );
}
```

In `apps/companion/src/app/layout.tsx`, add the import and thread the prefs:

```tsx
import { readFormatPrefs } from "@/format/server";
```

and change the body of `RootLayout` to:

```tsx
const locale = await readLocale();
const formatPrefs = await readFormatPrefs();
return (
  <html
    lang={locale}
    className={`${spaceGrotesk.variable} ${jetbrains.variable} ${fraunces.variable}`}
  >
    <body className="bg-cream text-ink font-sans antialiased">
      <AppProviders locale={locale} formatPrefs={formatPrefs}>
        {children}
      </AppProviders>
    </body>
  </html>
);
```

- [ ] **Step 7: Full companion test + typecheck, commit**

```bash
(cd apps/companion && pnpm test && pnpm typecheck)
```

Expected: PASS — including all pre-existing tests (nothing consumes `useFormat` yet; output is unchanged).

```bash
git add apps/companion/src/format/ apps/companion/src/components/AppProviders.tsx apps/companion/src/app/layout.tsx apps/companion/src/stores/preferences.ts
git commit -m "feat(companion): mount FormatProvider with useFormat seam"
```

---

### Task 8: `FormatPrefsSync` autodetection component

**Files:**

- Create: `apps/companion/src/components/FormatPrefsSync.tsx`
- Create: `apps/companion/src/components/FormatPrefsSync.test.tsx`
- Modify: `apps/companion/src/components/AuthenticatedAppProviders.tsx`

**Interfaces:**

- Consumes: Task 1 validators; Task 5 cookie constants; Task 6 route; `useRouter` from `next/navigation`.
- Produces: headless component mounted in the authenticated shell; detects device locale/timezone, POSTs `/api/format-prefs` on change, `router.refresh()` once on success.

- [ ] **Step 1: Write the failing component tests**

Create `apps/companion/src/components/FormatPrefsSync.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { FormatPrefsSync } from "./FormatPrefsSync";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

// jsdom resolves the environment timezone; read it the same way the
// component does so assertions hold regardless of the host TZ.
const DEVICE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function clearCookies() {
  for (const cookie of document.cookie.split("; ")) {
    const name = cookie.split("=")[0];
    if (name) {
      document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    }
  }
}

describe("FormatPrefsSync", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    Object.defineProperty(window.navigator, "language", {
      value: "cs-CZ",
      configurable: true,
    });
    clearCookies();
    refresh.mockReset();
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs detected prefs and refreshes when cookies are missing", async () => {
    render(<FormatPrefsSync />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/format-prefs");
    expect(JSON.parse(String(init.body))).toEqual({
      format_locale: "cs-CZ",
      timezone: DEVICE_TZ,
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("no-ops when cookies already match the device", async () => {
    document.cookie = `tarmoto-format-locale=cs-CZ; path=/`;
    document.cookie = `tarmoto-timezone=${DEVICE_TZ}; path=/`;

    render(<FormatPrefsSync />);

    // Give the effect a tick to (not) fire.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("POSTs when the device timezone diverges from the cookie", async () => {
    document.cookie = `tarmoto-format-locale=cs-CZ; path=/`;
    document.cookie = `tarmoto-timezone=Pacific/Auckland; path=/`;

    render(<FormatPrefsSync />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("does not refresh when the POST fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 400 }));

    render(<FormatPrefsSync />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refresh).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/companion && pnpm test -- src/components/FormatPrefsSync`
Expected: FAIL — component doesn't exist.

- [ ] **Step 3: Write the component**

Create `apps/companion/src/components/FormatPrefsSync.tsx`:

```tsx
"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { canonicalizeFormatLocale, isValidTimeZone } from "@tarmoto/shared";
import { FORMAT_LOCALE_COOKIE, TIMEZONE_COOKIE } from "@/format";

function readCookie(name: string): string | null {
  const match = document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

/**
 * Follow-the-device autodetection (spec decision #2): compares the device's
 * regional format locale + IANA timezone against the format-prefs cookies
 * and, on divergence, POSTs /api/format-prefs — which sets the cookies and
 * best-effort mirrors the values to the user record — then refreshes once
 * so server components re-render with the new cookies. Steady state (and
 * every mount after the first sync) is a pure no-op: no POST, no refresh.
 * Headless: renders nothing.
 */
export function FormatPrefsSync() {
  const router = useRouter();
  const ran = useRef(false);

  useEffect(() => {
    // Guard against strict-mode double-mount firing two POSTs.
    if (ran.current) return;
    ran.current = true;

    const detectedLocale = canonicalizeFormatLocale(navigator.language);
    const detectedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timeZone = isValidTimeZone(detectedZone) ? detectedZone : null;
    // An exotic environment that reports neither is left on the
    // Accept-Language/UTC server fallbacks — nothing useful to persist.
    if (!detectedLocale || !timeZone) return;

    if (
      readCookie(FORMAT_LOCALE_COOKIE) === detectedLocale &&
      readCookie(TIMEZONE_COOKIE) === timeZone
    ) {
      return;
    }

    void fetch("/api/format-prefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format_locale: detectedLocale,
        timezone: timeZone,
      }),
    })
      .then((response) => {
        if (response.ok) router.refresh();
      })
      .catch((error) => {
        console.error("Failed to sync format preferences", error);
      });
  }, [router]);

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/companion && pnpm test -- src/components/FormatPrefsSync`
Expected: PASS (4 tests).

- [ ] **Step 5: Mount it in the authenticated shell**

In `apps/companion/src/components/AuthenticatedAppProviders.tsx`, add the import and mount next to `PreferencesSync`:

```tsx
import { FormatPrefsSync } from "@/components/FormatPrefsSync";
```

```tsx
        <AuthSync />
        <RealtimeProvider />
        <PreferencesSync />
        <FormatPrefsSync />
        {children}
```

- [ ] **Step 6: Typecheck and commit**

```bash
(cd apps/companion && pnpm test && pnpm typecheck)
git add apps/companion/src/components/FormatPrefsSync.tsx apps/companion/src/components/FormatPrefsSync.test.tsx apps/companion/src/components/AuthenticatedAppProviders.tsx
git commit -m "feat(companion): autodetect and sync format preferences"
```

---

### Task 9: Units account-sync

**Files:**

- Modify: `apps/companion/src/stores/preferences.ts`
- Modify: `apps/companion/src/components/PreferencesSync.tsx`
- Create: `apps/companion/src/components/PreferencesSync.test.tsx`
- Modify: `apps/companion/src/app/(dashboard)/settings/profile/page.tsx` (units radiogroup `onChange`, ~line 585)

**Interfaces:**

- Consumes: Task 5 `UNITS_COOKIE`; Task 1 validators; `usersApi.getMe/updateMe` (`@/lib/api/users`); `useSession` from `next-auth/react`.
- Produces: `getStoredUnitSystem(): UnitSystem | null` exported from the store module; account-wins units hydration; one-time localStorage units backfill; toggle PATCHes `preferences.units`; **record reconciliation for `format_locale`/`timezone`** — this is what guarantees the user record gets prefilled even when the cookies were already set while logged out (Task 8's cookie comparison alone would skip the POST in that flow, and the route's best-effort PATCH would never fire).

- [ ] **Step 1: Update the preferences store (cookie write + explicit-value read)**

Replace `apps/companion/src/stores/preferences.ts` with:

```ts
import { create } from "zustand";
import type { UnitSystem } from "@tarmoto/shared";
import { UNITS_COOKIE, FORMAT_PREFS_COOKIE_MAX_AGE_SECONDS } from "@/format";

/**
 * User-level display preferences. Backend stores everything in metric per
 * AGENTS.md, so every display formatter reads this store to decide whether
 * to convert. Persisted to localStorage AND mirrored into the
 * `tarmoto-units` cookie (so SSR renders the right units), and reconciled
 * with the account's `preferences.units` by PreferencesSync — the account
 * is the cross-device source of truth.
 */

const STORAGE_KEY = "tarmoto:preferences:unit-system";
const VALID_UNITS: readonly UnitSystem[] = ["metric", "imperial"];

function isUnitSystem(value: unknown): value is UnitSystem {
  return (
    typeof value === "string" &&
    (VALID_UNITS as readonly string[]).includes(value)
  );
}

/**
 * The EXPLICIT stored preference, or null when the rider never chose one.
 * The null/default distinction matters: only an explicit value may be
 * backfilled to the account (PreferencesSync) or stamped into the cookie.
 */
export function getStoredUnitSystem(): UnitSystem | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isUnitSystem(raw) ? raw : null;
  } catch {
    return null;
  }
}

function saveUnitSystem(units: UnitSystem): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, units);
  } catch {
    // Quota or private-mode failures are non-fatal — the in-memory state
    // still works for this session.
  }
  saveUnitsCookie(units);
}

function saveUnitsCookie(units: UnitSystem): void {
  if (typeof document === "undefined") return;
  document.cookie = `${UNITS_COOKIE}=${units}; path=/; max-age=${FORMAT_PREFS_COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
}

interface PreferencesState {
  unitSystem: UnitSystem;
  /** True once localStorage has been read; the FormatProvider keeps using
   *  the server-seeded units until then so SSR and first paint agree. */
  hydrated: boolean;
  setUnitSystem: (units: UnitSystem) => void;
  hydrate: () => void;
}

export const usePreferencesStore = create<PreferencesState>((set) => ({
  unitSystem: "metric",
  hydrated: false,
  setUnitSystem: (units) => {
    saveUnitSystem(units);
    set({ unitSystem: units });
  },
  hydrate: () => {
    const stored = getStoredUnitSystem();
    // Refresh the SSR cookie for riders whose explicit choice predates the
    // cookie's existence — without this their next request still SSRs the
    // default.
    if (stored) saveUnitsCookie(stored);
    set({ unitSystem: stored ?? "metric", hydrated: true });
  },
}));
```

- [ ] **Step 2: Write the failing PreferencesSync tests**

Create `apps/companion/src/components/PreferencesSync.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { PreferencesSync } from "./PreferencesSync";
import { usePreferencesStore } from "@/stores/preferences";
import { usersApi } from "@/lib/api/users";

let sessionStatus = "authenticated";
vi.mock("next-auth/react", () => ({
  useSession: () => ({ status: sessionStatus }),
}));
vi.mock("@/lib/api/users", () => ({
  usersApi: { getMe: vi.fn(), updateMe: vi.fn() },
}));

const getMe = vi.mocked(usersApi.getMe);
const updateMe = vi.mocked(usersApi.updateMe);

// The component reads the device the same way FormatPrefsSync does; pin the
// locale and read the jsdom timezone so assertions hold on any host.
const DEVICE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function meWithPreferences(preferences: Record<string, unknown>) {
  return { preferences } as unknown as Awaited<
    ReturnType<typeof usersApi.getMe>
  >;
}

/** Account state already fully mirroring this device (no PATCH expected). */
function convergedPreferences(extra: Record<string, unknown> = {}) {
  return { format_locale: "cs-CZ", timezone: DEVICE_TZ, ...extra };
}

describe("PreferencesSync", () => {
  beforeEach(() => {
    sessionStatus = "authenticated";
    getMe.mockReset();
    updateMe.mockReset();
    updateMe.mockResolvedValue(meWithPreferences({}));
    Object.defineProperty(window.navigator, "language", {
      value: "cs-CZ",
      configurable: true,
    });
    window.localStorage.clear();
    act(() => {
      usePreferencesStore.setState({ unitSystem: "metric", hydrated: false });
    });
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("account units win over the local store", async () => {
    window.localStorage.setItem("tarmoto:preferences:unit-system", "metric");
    getMe.mockResolvedValueOnce(
      meWithPreferences(convergedPreferences({ units: "imperial" })),
    );

    render(<PreferencesSync />);

    await waitFor(() =>
      expect(usePreferencesStore.getState().unitSystem).toBe("imperial"),
    );
    expect(updateMe).not.toHaveBeenCalled();
    // The account choice is now the device's explicit choice too.
    expect(window.localStorage.getItem("tarmoto:preferences:unit-system")).toBe(
      "imperial",
    );
  });

  it("backfills an explicit pre-account localStorage units value once", async () => {
    window.localStorage.setItem("tarmoto:preferences:unit-system", "imperial");
    getMe.mockResolvedValueOnce(meWithPreferences(convergedPreferences()));

    render(<PreferencesSync />);

    await waitFor(() => expect(updateMe).toHaveBeenCalledTimes(1));
    expect(updateMe).toHaveBeenCalledWith({
      preferences: { units: "imperial" },
    });
  });

  it("prefills format prefs when the record lacks them (cookies may already match)", async () => {
    getMe.mockResolvedValueOnce(meWithPreferences({ units: "metric" }));
    window.localStorage.setItem("tarmoto:preferences:unit-system", "metric");

    render(<PreferencesSync />);

    await waitFor(() => expect(updateMe).toHaveBeenCalledTimes(1));
    expect(updateMe).toHaveBeenCalledWith({
      preferences: { format_locale: "cs-CZ", timezone: DEVICE_TZ },
    });
  });

  it("writes nothing when the record already mirrors the device", async () => {
    window.localStorage.setItem("tarmoto:preferences:unit-system", "metric");
    getMe.mockResolvedValueOnce(
      meWithPreferences(convergedPreferences({ units: "metric" })),
    );

    render(<PreferencesSync />);

    await waitFor(() =>
      expect(usePreferencesStore.getState().hydrated).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updateMe).not.toHaveBeenCalled();
  });

  it("skips account sync entirely when unauthenticated", async () => {
    sessionStatus = "unauthenticated";

    render(<PreferencesSync />);

    await waitFor(() =>
      expect(usePreferencesStore.getState().hydrated).toBe(true),
    );
    expect(getMe).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/companion && pnpm test -- src/components/PreferencesSync`
Expected: FAIL — current component never calls `usersApi`, and the mocks/flags don't line up.

- [ ] **Step 4: Rewrite PreferencesSync**

Replace `apps/companion/src/components/PreferencesSync.tsx` with:

```tsx
"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { canonicalizeFormatLocale, isValidTimeZone } from "@tarmoto/shared";
import { getStoredUnitSystem, usePreferencesStore } from "@/stores/preferences";
import { usersApi } from "@/lib/api/users";

/**
 * Hydrates the unit preference and reconciles display preferences with the
 * account record.
 *
 * Local hydrate runs first (fast paint with the device's last choice).
 * Once the session is authenticated, one `/me` read reconciles in both
 * directions:
 *  - units: the account value wins when present (cross-device source of
 *    truth); a rider with only a pre-account localStorage value gets it
 *    backfilled once, so an expressed preference never silently stays
 *    device-local (spec decision #4).
 *  - format_locale / timezone: the RECORD follows the device (spec
 *    decision #2). This must live here, against `/me`, not only in
 *    FormatPrefsSync's cookie comparison — cookies set while logged out
 *    make that comparison a no-op after login, and the record would never
 *    be prefilled at all.
 * Headless: renders nothing.
 */
export function PreferencesSync() {
  const { status } = useSession();
  const hydrate = usePreferencesStore((s) => s.hydrate);
  const setUnitSystem = usePreferencesStore((s) => s.setUnitSystem);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    void (async () => {
      try {
        const me = await usersApi.getMe();
        if (cancelled) return;

        const prefsPatch: {
          units?: "metric" | "imperial";
          format_locale?: string;
          timezone?: string;
        } = {};

        const accountUnits = me.preferences?.units;
        const stored = getStoredUnitSystem();
        if (accountUnits === "metric" || accountUnits === "imperial") {
          if (accountUnits !== stored) setUnitSystem(accountUnits);
        } else if (stored) {
          prefsPatch.units = stored;
        }

        const deviceLocale = canonicalizeFormatLocale(navigator.language);
        if (deviceLocale && me.preferences?.format_locale !== deviceLocale) {
          prefsPatch.format_locale = deviceLocale;
        }
        const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (
          isValidTimeZone(deviceZone) &&
          me.preferences?.timezone !== deviceZone
        ) {
          prefsPatch.timezone = deviceZone;
        }

        if (Object.keys(prefsPatch).length > 0) {
          await usersApi.updateMe({ preferences: prefsPatch });
        }
      } catch (error) {
        console.error("Failed to sync display preferences with account", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, setUnitSystem]);

  return null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/companion && pnpm test -- src/components/PreferencesSync`
Expected: PASS (5 tests).

- [ ] **Step 6: Make the settings toggle persist to the account**

In `apps/companion/src/app/(dashboard)/settings/profile/page.tsx` (~line 585), the units radiogroup currently has:

```tsx
                onChange={() => setUnitSystem(value)}
```

Replace with:

```tsx
                onChange={() => {
                  setUnitSystem(value);
                  void usersApi
                    .updateMe({ preferences: { units: value } })
                    .catch((error) =>
                      console.error("Failed to save unit preference", error),
                    );
                }}
```

`usersApi` is already used by this page for profile saves — if the import is somehow absent, add `import { usersApi } from "@/lib/api/users";`. If `value`'s inferred type is wider than `"metric" | "imperial"`, tighten the options array it comes from (e.g. `as const`) rather than casting at the call.

- [ ] **Step 7: Full companion suite + typecheck, commit**

```bash
(cd apps/companion && pnpm test && pnpm typecheck)
git add apps/companion/src/stores/preferences.ts apps/companion/src/components/PreferencesSync.tsx apps/companion/src/components/PreferencesSync.test.tsx "apps/companion/src/app/(dashboard)/settings/profile/page.tsx"
git commit -m "feat(companion): sync unit preference to the account"
```

---

### Task 10: E2E coverage + final validation (PR 2 wrap)

**Files:**

- Create: `apps/companion/e2e/tests/format-prefs.spec.ts`

**Interfaces:**

- Consumes: everything above; e2e fixtures (`authedPage`, mock backend already implements `GET/PATCH /api/v1/users/me`).
- Produces: e2e proof of the capture loop; the full-repo validation sweep.

- [ ] **Step 1: Write the e2e spec**

Create `apps/companion/e2e/tests/format-prefs.spec.ts`:

```ts
import { test, expect } from "../fixtures";

// Simulate an EU rider: Czech browser locale, Prague timezone. Playwright
// sets both on the browser context, so navigator.language and
// Intl.DateTimeFormat().resolvedOptions().timeZone report these values.
test.use({ locale: "cs-CZ", timezoneId: "Europe/Prague" });

test.describe("format preferences autodetection", () => {
  test("captures device locale and timezone into cookies without a refresh loop", async ({
    authedPage: page,
  }) => {
    const hydrationErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && /hydrat/i.test(message.text())) {
        hydrationErrors.push(message.text());
      }
    });

    await page.goto("/rides");

    await expect
      .poll(
        async () => {
          const cookies = await page.context().cookies();
          return cookies.find((c) => c.name === "tarmoto-format-locale")?.value;
        },
        { timeout: 10_000 },
      )
      .toBe("cs-CZ");

    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === "tarmoto-timezone")?.value).toBe(
      "Europe/Prague",
    );

    // The sync must settle: navigating again with matching cookies fires
    // no further POST (a refresh loop would keep hitting the route).
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/format-prefs")) {
        posts.push(request.url());
      }
    });
    await page.goto("/rides");
    await page.waitForLoadState("networkidle");
    expect(posts).toHaveLength(0);

    expect(hydrationErrors).toEqual([]);
  });

  test("units toggle persists to the account", async ({ authedPage: page }) => {
    await page.goto("/settings/profile");

    // PreferencesSync fires its own reconciliation PATCH (format prefs) on
    // load — filter for the toggle's PATCH by its `units` payload.
    const [request] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.url().includes("/users/me") &&
          r.method() === "PATCH" &&
          (r.postData() ?? "").includes('"units"'),
        { timeout: 10_000 },
      ),
      page.getByRole("radio", { name: /imperial/i }).click(),
    ]);

    const payload = JSON.parse(request.postData() ?? "{}");
    expect(payload.preferences?.units).toBe("imperial");
  });
});
```

Note: if the radio's accessible name isn't literally "imperial", inspect the units radiogroup on `/settings/profile` and adjust the locator to the actual label (e.g. `/miles/i`) — do not change the assertion.

- [ ] **Step 2: Run the e2e spec**

Run: `cd apps/companion && pnpm test:e2e -- format-prefs`
Expected: PASS (2 tests). If browsers are missing, first run `pnpm test:e2e:install`.

- [ ] **Step 3: Full validation sweep**

```bash
pnpm shared:build
(cd packages/shared && pnpm test)
(cd apps/backend && pnpm test -- users && pnpm test -- update-profile.dto)
(cd apps/companion && pnpm test && pnpm typecheck && pnpm lint)
(cd apps/mobile && pnpm typecheck)
pnpm openapi:gen && git diff --exit-code packages/openapi-client
```

Expected: everything passes; the final `git diff --exit-code` proves no contract drift (regen is idempotent against the committed client).

- [ ] **Step 4: Commit and wrap PR 2**

```bash
git add apps/companion/e2e/tests/format-prefs.spec.ts
git commit -m "test(companion): e2e coverage for format preference capture"
```

PR 2 boundary — title suggestion: `feat(companion): format-preference autodetection, FormatProvider seam, units account-sync`. PR body must call out: additive contract usage only (fields landed in PR 1), no visible output changes yet (call-site migration is the follow-up), cookie names, and the follow-the-device sync semantics.

---

## Deferred (explicitly NOT in this plan)

- **PRs 3–4 (call-site migration):** planned separately once this foundation is merged — a per-surface recipe mapping each of the ~120 call sites and ~10 helpers (`lib/utils.ts` format family, `TripCollaborateModal` shadow helpers, `useNumberFormat` absorption, hardcoded-locale libs) onto the `useFormat()`/`getServerFormatters()` vocabulary, deleting emptied helpers, then landing the ESLint `no-restricted-*` guard. The instant-vs-calendar-date audit of each date field happens there.
- Settings editing UI, mobile call-site migration, email formatting, `duration()` localization (spec §8).
