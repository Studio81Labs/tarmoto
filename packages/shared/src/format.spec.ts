import { describe, expect, it } from "vitest";
import {
  canonicalizeFormatLocale,
  createFormatters,
  isValidFormatLocale,
  isValidTimeZone,
  resolveFormatLocaleFromAcceptLanguage,
  formatCurrencyAmount,
  formatCurrencyMinorAmount,
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

  it("parses q-weights case-insensitively", () => {
    expect(
      resolveFormatLocaleFromAcceptLanguage("fr-FR;Q=0.9,de-DE;q=0.8"),
    ).toBe("fr-FR");
  });

  it("skips wildcards and malformed tags, falling through to the next candidate", () => {
    expect(resolveFormatLocaleFromAcceptLanguage("*,fr-FR;q=0.7")).toBe(
      "fr-FR",
    );
    expect(resolveFormatLocaleFromAcceptLanguage("!!bad!!,en-GB;q=0.1")).toBe(
      "en-GB",
    );
  });

  it("rejects explicitly unacceptable and out-of-range quality values", () => {
    expect(resolveFormatLocaleFromAcceptLanguage("cs-CZ;q=0")).toBeNull();
    expect(
      resolveFormatLocaleFromAcceptLanguage("de-DE;q=1.5,en-GB;q=0.8"),
    ).toBe("en-GB");
    expect(
      resolveFormatLocaleFromAcceptLanguage("de-DE;q=garbage,en-GB;q=0.8"),
    ).toBe("en-GB");
    expect(
      resolveFormatLocaleFromAcceptLanguage("de-DE;q=0.1234,en-GB;q=0.8"),
    ).toBe("en-GB");
  });

  it("returns null for empty/absent/unusable headers", () => {
    expect(resolveFormatLocaleFromAcceptLanguage(null)).toBeNull();
    expect(resolveFormatLocaleFromAcceptLanguage(undefined)).toBeNull();
    expect(resolveFormatLocaleFromAcceptLanguage("*")).toBeNull();
  });
});

/**
 * ICU renders some locales with NBSP (U+00A0) or narrow NBSP (U+202F)
 * where ASCII expectations would use a plain space, and the exact choice
 * shifts between ICU versions. Normalize so the tests assert separators
 * and ordering — the locale-correctness that matters — not ICU trivia.
 */
const norm = (s: string) => s.replace(/[\u00A0\u202F ]/g, " ");

describe("formatCurrencyAmount", () => {
  it("applies locale decimal separators and currency placement", () => {
    expect(norm(formatCurrencyAmount(29.99, "EUR", "en-US"))).toBe("€29.99");
    expect(norm(formatCurrencyAmount(29.99, "EUR", "cs-CZ"))).toBe("29,99 €");
  });

  it("honors each currency's minor-unit exponent", () => {
    expect(norm(formatCurrencyMinorAmount(2999, "EUR", "en-US"))).toBe(
      "€29.99",
    );
    expect(norm(formatCurrencyMinorAmount(3000, "JPY", "en-US"))).toBe(
      "¥3,000",
    );
  });
});

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

  it("can localize identifier digits without grouping", () => {
    const en = createFormatters({ locale: "en-US", units: "metric" });
    const ar = createFormatters({ locale: "ar-EG", units: "metric" });
    const options: Intl.NumberFormatOptions = {
      useGrouping: false,
      maximumFractionDigits: 0,
    };
    expect(en.number(2026, options)).toBe("2026");
    expect(ar.number(2026, options)).toBe("٢٠٢٦");
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

  it("renders a locale month name only, UTC-pinned regardless of context timezone", () => {
    const en = createFormatters({
      locale: "en-US",
      timeZone: "Europe/Prague",
      units: "metric",
    });
    const cs = createFormatters({
      locale: "cs-CZ",
      timeZone: "Europe/Prague",
      units: "metric",
    });
    expect(en.month(INSTANT)).toBe("Apr");
    expect(norm(cs.month(INSTANT))).toMatch(/dub/);
    // Discriminating case: 23:30 UTC on Apr 30 is already 01:30 May 1 in
    // Prague (UTC+2) — the context timezone `en` is pinned to above. month()
    // must ignore it and stay UTC-pinned (chart axes compare the same
    // calendar month across years regardless of viewer timezone), so this
    // must render "Apr". If month() ever switched to reading the context
    // timezone the way the instant-based formatters (date/shortDate/etc.)
    // do, this would render "May" instead.
    expect(en.month("2025-04-30T23:30:00Z")).toBe("Apr");
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

  it("renders an em-dash for non-finite input instead of NaN math", () => {
    expect(en.duration(Number.NaN)).toBe("—");
  });

  it("localizes duration numerals and unit tokens", () => {
    const ar = createFormatters({ locale: "ar-EG", units: "metric" });
    expect(ar.duration(132)).toContain("٢");
    expect(ar.duration(132)).toContain("١٢");
    expect(ar.duration(132)).not.toContain("2h");
  });
});

describe("createFormatters — monthYearCompact", () => {
  it("renders a compact localized month + 2-digit year, UTC-pinned", () => {
    const en = createFormatters({ locale: "en-US", units: "metric" });
    const cs = createFormatters({
      locale: "cs-CZ",
      timeZone: "Europe/Prague",
      units: "metric",
    });
    expect(en.monthYearCompact("2026-01-15T12:00:00Z")).toBe("Jan 26");
    // UTC-pinned like month(): 23:30Z on Apr 30 must not roll into May
    // even under a Prague context.
    expect(en.monthYearCompact("2025-04-30T23:30:00Z")).toBe("Apr 25");
    expect(norm(cs.monthYearCompact("2026-01-15T12:00:00Z"))).toMatch(/led/);
  });
});

describe("createFormatters — durationCompact", () => {
  const en = createFormatters({ locale: "en-US", units: "metric" });
  it("keeps the tight compact style used by ride tables", () => {
    expect(en.durationCompact(252)).toBe("4h 12m");
    expect(en.durationCompact(52)).toBe("52m");
    expect(en.durationCompact(120)).toBe("2h");
  });

  it("renders an em-dash for non-finite input instead of NaN math", () => {
    expect(en.durationCompact(Number.NaN)).toBe("—");
  });

  it("uses locale-aware narrow duration units", () => {
    const ar = createFormatters({ locale: "ar-EG", units: "metric" });
    expect(ar.durationCompact(52)).toContain("٥٢");
    expect(ar.durationCompact(52)).not.toBe("52m");
  });
});

describe("createFormatters — durationClock", () => {
  const en = createFormatters({ locale: "en-US", units: "metric" });

  it("formats active timers without rounding into the next second", () => {
    expect(en.durationClock(0)).toBe("0:00");
    expect(en.durationClock(65.9)).toBe("1:05");
    expect(en.durationClock(3661)).toBe("1:01:01");
    expect(en.durationClock(Number.NaN)).toBe("0:00");
    expect(en.durationClock(-5)).toBe("0:00");
  });

  it("localizes every numeral, including padded fields", () => {
    const ar = createFormatters({ locale: "ar-EG", units: "metric" });
    expect(ar.durationClock(3661)).toBe("١:٠١:٠١");
    expect(ar.durationClock(0)).toBe("٠:٠٠");
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
    expect(metric.splitSpeed(90)).toEqual({
      value: "90",
      unit: "km/h",
      unitPosition: "after",
    });
    expect(norm(imperial.splitDistanceKm(100).value)).toBe("62.1");
    expect(imperial.splitDistanceKm(100).unit).toBe("mi");
    expect(metric.splitElevation(1234)).toEqual({
      value: "1,234",
      unit: "m",
      unitPosition: "after",
    });
  });

  it("retains locale-specific unit placement when splitting values", () => {
    const swahili = createFormatters({ locale: "sw", units: "metric" });

    expect(
      swahili.splitUnit(12.5, "hour", {
        unitDisplay: "narrow",
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    ).toEqual({
      value: "12.5",
      unit: "saa",
      unitPosition: "before",
    });
  });

  it("keeps compact unit labels invariant across regional locales", () => {
    const turkishImperial = createFormatters({
      locale: "tr-TR",
      units: "imperial",
    });
    const turkishMetric = createFormatters({
      locale: "tr-TR",
      units: "metric",
    });

    expect(turkishImperial.unitLabel("distance")).toBe("MI");
    expect(turkishImperial.unitLabel("speed")).toBe("MPH");
    expect(turkishImperial.unitLabel("elevation")).toBe("FT");
    expect(turkishMetric.unitLabel("distance")).toBe("KM");
    expect(turkishMetric.unitLabel("speed")).toBe("KM/H");
    expect(turkishMetric.unitLabel("elevation")).toBe("M");
  });
});

describe("createFormatters — Intl memo cache cap", () => {
  it("keeps formatting correctly after growing past the cache cap", () => {
    // Private-use BCP-47 tags (`en-x-p0`, `en-x-p1`, ...) canonicalize to
    // themselves with no CLDR aliasing, so 300 of them reliably produce
    // 300 distinct (locale, options) cache keys — comfortably past the
    // module's FORMAT_CACHE_MAX (256) — without depending on real-world
    // locale/region data that could collide. Each cache (number,
    // dateTime, relativeTime) should clear itself wholesale past the cap
    // rather than growing unboundedly or throwing.
    const locales = Array.from({ length: 300 }, (_, i) => `en-x-p${i}`);
    for (const locale of locales) {
      const f = createFormatters({ locale, units: "metric" });
      f.integer(1234);
      f.date(INSTANT);
      f.relativeTime("2025-04-18T11:55:00Z", new Date("2025-04-18T12:00:00Z"));
    }

    // Re-requesting an early (now-evicted) key and a fresh locale both
    // still format correctly post-churn — the cap must not corrupt or
    // wedge the cache.
    const first = createFormatters({ locale: locales[0]!, units: "metric" });
    expect(first.integer(12345)).toBe("12,345");
    const en = createFormatters({ locale: "en-US", units: "metric" });
    expect(en.integer(12345)).toBe("12,345");
    expect(en.date(INSTANT)).toBe("Apr 18, 2025");
  });
});
