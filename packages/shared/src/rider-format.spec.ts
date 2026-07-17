import { describe, expect, it } from "vitest";
import { formatCount, formatJoinedLabel } from "./rider-format";
import { makeTranslator } from "./i18n";

describe("formatJoinedLabel", () => {
  const NOW = new Date("2026-07-15T12:00:00Z");

  it("keeps the legacy English output when no translator is passed (mobile contract)", () => {
    expect(formatJoinedLabel("2026-07-01T00:00:00Z", NOW)).toBe(
      "Joined this month",
    );
    expect(formatJoinedLabel("2026-06-01T00:00:00Z", NOW)).toBe(
      "Joined 1 month ago",
    );
    expect(formatJoinedLabel("2026-02-01T00:00:00Z", NOW)).toBe(
      "Joined 5 months ago",
    );
    expect(formatJoinedLabel("2024-05-01T00:00:00Z", NOW)).toBe(
      "Joined 2 years ago",
    );
    expect(formatJoinedLabel("not-a-date", NOW)).toBe("Joined recently");
  });

  it("routes through the translator when one is passed", () => {
    const t = makeTranslator<string>({
      en: {
        "Joined {count, plural, one {# month} other {# months}} ago":
          "Joined {count, plural, one {# month} other {# months}} ago",
        "Joined {count, plural, one {# year} other {# years}} ago":
          "Joined {count, plural, one {# year} other {# years}} ago",
        "Joined this month": "Joined this month",
        "Joined recently": "Joined recently",
      },
    });
    expect(formatJoinedLabel("2026-06-01T00:00:00Z", NOW, t)).toBe(
      "Joined 1 month ago",
    );
    expect(formatJoinedLabel("2026-02-01T00:00:00Z", NOW, t)).toBe(
      "Joined 5 months ago",
    );
    expect(formatJoinedLabel("2024-05-01T00:00:00Z", NOW, t)).toBe(
      "Joined 2 years ago",
    );
    expect(formatJoinedLabel("2026-07-01T00:00:00Z", NOW, t)).toBe(
      "Joined this month",
    );
  });
});

describe("formatCount", () => {
  it("localizes grouping when a locale is passed", () => {
    expect(formatCount(1234000, "de-DE")).toBe("1.234k");
  });
  it("keeps runtime-default behavior when locale is omitted (mobile contract)", () => {
    // Derived from the runtime's own ICU default via `toLocaleString()`
    // rather than a hardcoded "1,234k" — the assertion holds regardless of
    // which locale the test runner's ICU data treats as the ambient default.
    expect(formatCount(1234000)).toBe(`${(1234).toLocaleString()}k`);
  });
  it("keeps the compact k form", () => {
    expect(formatCount(12600, "en-US")).toBe("13k");
  });
  it("localizes the compact decimal when a locale is supplied", () => {
    expect(formatCount(1500, "de-DE")).toBe("1,5k");
    expect(formatCount(1500, "en-US")).toBe("1.5k");
  });
  it("keeps the legacy period form for the compact decimal when locale is omitted (mobile contract)", () => {
    expect(formatCount(1500)).toBe("1.5k");
  });
});
