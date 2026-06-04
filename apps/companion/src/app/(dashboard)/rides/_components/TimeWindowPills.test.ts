import { describe, it, expect } from "vitest";
import { windowStartISO, parseTimeWindow } from "./TimeWindowPills";
import type { TimeWindow } from "./TimeWindowPills";

const FIXED_NOW = new Date("2026-06-04T00:00:00Z");

describe("parseTimeWindow", () => {
  it.each<[string | null | undefined, TimeWindow]>([
    ["30d", "30d"],
    ["90d", "90d"],
    ["year", "year"],
    ["all", "all"],
  ])("returns %s for valid value %s", (input, expected) => {
    expect(parseTimeWindow(input)).toBe(expected);
  });

  it.each<string | null | undefined>([
    null,
    undefined,
    "",
    "7d",
    "random",
    "YEAR",
  ])("falls back to 'all' for %s", (input) => {
    expect(parseTimeWindow(input)).toBe("all");
  });
});

describe("windowStartISO", () => {
  it("returns null for 'all'", () => {
    expect(windowStartISO("all", FIXED_NOW)).toBeNull();
  });

  it("returns January 1st of the current UTC year for 'year'", () => {
    expect(windowStartISO("year", FIXED_NOW)).toBe("2026-01-01");
  });

  it("returns 30 days before now for '30d'", () => {
    // 2026-06-04 minus 30 days = 2026-05-05
    expect(windowStartISO("30d", FIXED_NOW)).toBe("2026-05-05");
  });

  it("returns 90 days before now for '90d'", () => {
    // 2026-06-04 minus 90 days = 2026-03-06
    expect(windowStartISO("90d", FIXED_NOW)).toBe("2026-03-06");
  });
});
