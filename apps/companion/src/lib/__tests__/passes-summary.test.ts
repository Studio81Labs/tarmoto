import { describe, expect, it } from "vitest";
import {
  MONTH_NAMES,
  countByStatus,
  currentUtcMonth,
  monthLabel,
  partitionByStatus,
  type MountainPass,
} from "../passes-summary";

function pass(overrides: Partial<MountainPass> & { id: string }): MountainPass {
  return {
    id: overrides.id,
    name: "Stelvio",
    country_code: "IT",
    region: "Lombardy",
    lat: 46.528,
    lng: 10.452,
    elevation_m: 2757,
    typical_open_month: 6,
    typical_close_month: 10,
    status: "open",
    status_overridden: false,
    notes: null,
    last_updated: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

describe("monthLabel", () => {
  it("returns the English month name for 1..12", () => {
    expect(monthLabel(1)).toBe("January");
    expect(monthLabel(7)).toBe("July");
    expect(monthLabel(12)).toBe("December");
  });

  it("returns an empty string for out-of-range or non-integer input", () => {
    expect(monthLabel(0)).toBe("");
    expect(monthLabel(13)).toBe("");
    expect(monthLabel(-1)).toBe("");
    expect(monthLabel(4.5)).toBe("");
    expect(monthLabel(Number.NaN)).toBe("");
  });

  it("has exactly 12 month names in the canonical order", () => {
    expect(MONTH_NAMES).toHaveLength(12);
    expect(MONTH_NAMES[0]).toBe("January");
    expect(MONTH_NAMES[11]).toBe("December");
  });
});

describe("currentUtcMonth", () => {
  it("returns 1..12 derived from UTC month (not local timezone)", () => {
    // 2026-01-01T00:00:00Z — January in UTC regardless of the host TZ.
    expect(currentUtcMonth(new Date("2026-01-01T00:00:00Z"))).toBe(1);
    expect(currentUtcMonth(new Date("2026-07-15T12:00:00Z"))).toBe(7);
    expect(currentUtcMonth(new Date("2026-12-31T23:59:59Z"))).toBe(12);
  });
});

describe("countByStatus", () => {
  it("returns zero counts for an empty list", () => {
    expect(countByStatus([])).toEqual({
      open: 0,
      closed: 0,
      unknown: 0,
      total: 0,
    });
  });

  it("tallies each status and totals them", () => {
    const counts = countByStatus([
      pass({ id: "a", status: "open" }),
      pass({ id: "b", status: "closed" }),
      pass({ id: "c", status: "closed" }),
      pass({ id: "d", status: "unknown" }),
    ]);
    expect(counts).toEqual({ open: 1, closed: 2, unknown: 1, total: 4 });
  });
});

describe("partitionByStatus", () => {
  it("sorts each status group by elevation descending", () => {
    const groups = partitionByStatus([
      pass({ id: "a", status: "closed", elevation_m: 1500 }),
      pass({ id: "b", status: "closed", elevation_m: 2500 }),
      pass({ id: "c", status: "open", elevation_m: 800 }),
      pass({ id: "d", status: "closed", elevation_m: 2000 }),
    ]);
    expect(groups.closed.map((p) => p.id)).toEqual(["b", "d", "a"]);
    expect(groups.open.map((p) => p.id)).toEqual(["c"]);
    expect(groups.unknown).toEqual([]);
  });

  it("always returns all three status keys, even if some are empty", () => {
    const groups = partitionByStatus([pass({ id: "a", status: "open" })]);
    expect(Object.keys(groups).sort()).toEqual(["closed", "open", "unknown"]);
    expect(groups.closed).toEqual([]);
    expect(groups.unknown).toEqual([]);
  });
});
