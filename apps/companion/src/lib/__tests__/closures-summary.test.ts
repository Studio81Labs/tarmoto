import { describe, expect, it } from "vitest";
import { createFormatters } from "@tarmoto/shared";
import {
  buildTripClosureRoutes,
  countClosuresBySeverity,
  detourLengthKm,
  formatClosureWindow,
  previewDateForMonth,
  type PlannerClosure,
} from "../closures-summary";
import type { Trip } from "../types";

// Deterministic en/UTC/metric context — mirrors the component-test default
// (no FormatProvider) so lib-level assertions stay locale-neutral.
const format = createFormatters({ locale: "en", units: "metric" });
// A non-UTC context: proves the closure window is UTC-pinned regardless of
// the formatter's configured viewer timezone, not just when it happens to
// match UTC.
const nonUtcFormat = createFormatters({
  locale: "en",
  units: "metric",
  timeZone: "Pacific/Kiritimati", // UTC+14 — the furthest-ahead real zone.
});
const negativeOffsetFormat = createFormatters({
  locale: "en",
  units: "metric",
  timeZone: "Etc/GMT+12", // UTC-12 — the furthest-behind real zone.
});

function closure(
  overrides: Partial<PlannerClosure> & { id: string },
): PlannerClosure {
  const { id, ...rest } = overrides;
  return {
    id,
    title: "Bridge resurfacing",
    reason: "roadworks",
    severity: "partial",
    geometry: [
      { lat: 46.53, lng: 10.45 },
      { lat: 46.54, lng: 10.46 },
    ],
    detour: null,
    country_code: "IT",
    region: "South Tyrol",
    starts_at: "2026-07-01T00:00:00Z",
    ends_at: "2026-07-18T00:00:00Z",
    notes: null,
    source: "operator",
    created_by: null,
    created_at: "2026-06-20T00:00:00Z",
    updated_at: "2026-06-20T00:00:00Z",
    ...rest,
  };
}

describe("previewDateForMonth", () => {
  it("pins the preview to the middle of the selected UTC month", () => {
    expect(
      previewDateForMonth(7, new Date("2026-04-22T09:00:00Z")).toISOString(),
    ).toBe("2026-07-15T12:00:00.000Z");
  });

  it("rolls into the next year when the chosen month has already passed", () => {
    expect(
      previewDateForMonth(1, new Date("2026-10-22T09:00:00Z")).toISOString(),
    ).toBe("2027-01-15T12:00:00.000Z");
  });

  it("rejects out-of-range or non-integer months", () => {
    expect(() => previewDateForMonth(0)).toThrow(RangeError);
    expect(() => previewDateForMonth(13)).toThrow(RangeError);
    expect(() => previewDateForMonth(4.5)).toThrow(RangeError);
  });
});

describe("countClosuresBySeverity", () => {
  it("tallies all severities and the overall total", () => {
    expect(
      countClosuresBySeverity([
        closure({ id: "a", severity: "full" }),
        closure({ id: "b", severity: "partial" }),
        closure({ id: "c", severity: "partial" }),
        closure({ id: "d", severity: "advisory" }),
      ]),
    ).toEqual({
      full: 1,
      partial: 2,
      advisory: 1,
      total: 4,
    });
  });
});

describe("detourLengthKm", () => {
  it("measures the length of a closure detour polyline in kilometers", () => {
    expect(
      detourLengthKm(
        closure({
          id: "detour",
          detour: [
            { lat: 0, lng: 0 },
            { lat: 0, lng: 0.01 },
            { lat: 0, lng: 0.02 },
          ],
        }),
      ),
    ).toBeCloseTo(2.22, 2);
  });

  it("returns null when no detour polyline is present", () => {
    expect(detourLengthKm(closure({ id: "no-detour", detour: null }))).toBe(
      null,
    );
  });
});

describe("formatClosureWindow", () => {
  it("renders a bounded window as a compact UTC calendar-date range", () => {
    // Intl's formatRange wraps the en dash in thin spaces (U+2009), not
    // regular spaces — spelled out explicitly rather than pasted as an
    // invisible literal.
    expect(
      formatClosureWindow(
        closure({
          id: "bounded",
          starts_at: "2026-07-01T00:00:00Z",
          ends_at: "2026-07-18T00:00:00Z",
        }),
        format,
      ),
    ).toBe("Jul 1 – 18");
  });

  it("renders an open-ended window as a calendar date + 'onward'", () => {
    expect(
      formatClosureWindow(
        closure({
          id: "open-ended",
          starts_at: "2026-07-01T00:00:00Z",
          ends_at: null,
        }),
        format,
      ),
    ).toBe("Jul 1, 2026 onward");
  });

  it("keeps the start day stable across a month boundary regardless of the formatter's timezone context", () => {
    // 22:30Z on the last day of June. `calendarDate`/`calendarDateRange` are
    // UTC-pinned by construction (unlike the instant-based `date()`), so the
    // rendered calendar day must NOT shift even when the Formatters context
    // is built for a viewer far ahead of or behind UTC — an instant-based
    // formatter WOULD roll this into July (ahead) or stay June 30 (behind)
    // inconsistently, which is exactly the bug this guards against.
    const lateJuneClosure = closure({
      id: "day-shift",
      starts_at: "2026-06-30T22:30:00Z",
      ends_at: null,
    });

    const utc = formatClosureWindow(lateJuneClosure, format);
    const aheadOfUtc = formatClosureWindow(lateJuneClosure, nonUtcFormat);
    const behindUtc = formatClosureWindow(
      lateJuneClosure,
      negativeOffsetFormat,
    );

    expect(utc).toBe("Jun 30, 2026 onward");
    expect(aheadOfUtc).toBe(utc);
    expect(behindUtc).toBe(utc);
  });
});

describe("buildTripClosureRoutes", () => {
  it("extracts one route-check payload per trip day that has geometry", () => {
    const trip: Trip = {
      id: "trip-1",
      name: "Dolomites",
      status: "planned",
      num_days: 2,
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-02T00:00:00Z",
      parameters: {
        days: 2,
        dailyKmTarget: 250,
        roadPreference: "curvy",
        surfacePreference: ["asphalt"],
        avoidHighways: true,
        avoidTolls: false,
        avoidUnpaved: true,
        minQuality: 3,
      },
      collaborators: [],
      days: [
        {
          dayNumber: 1,
          title: "Passo Sella",
          waypoints: [],
          distanceKm: 210,
          durationMinutes: 320,
          elevationGain: 2100,
          avgQuality: 4.2,
          routeGeometry: {
            type: "LineString",
            coordinates: [
              [11.76, 46.51],
              [11.78, 46.52],
              [11.8, 46.53],
            ],
          },
        },
        {
          dayNumber: 2,
          title: "No geometry yet",
          waypoints: [],
          distanceKm: 190,
          durationMinutes: 290,
          elevationGain: 1800,
          avgQuality: 3.9,
        },
      ],
    };

    expect(buildTripClosureRoutes(trip)).toEqual([
      {
        id: "day-1",
        label: "Day 1 · Passo Sella",
        points: [
          { lng: 11.76, lat: 46.51 },
          { lng: 11.78, lat: 46.52 },
          { lng: 11.8, lat: 46.53 },
        ],
      },
    ]);
  });
});
