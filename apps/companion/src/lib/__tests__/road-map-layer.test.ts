import { describe, expect, it } from "vitest";
import {
  buildMapShareSnapshot,
  filterRiddenByPeriod,
  indexRiddenSegments,
  parseMapShareSnapshot,
  type MapShareSnapshot,
  type RiddenSegment,
} from "../road-map-layer";

function seg(
  overrides: Partial<RiddenSegment> & { id: string },
): RiddenSegment {
  return {
    last_ridden_at: "2026-04-01T08:30:00.000Z",
    last_quality_score: 4.2,
    ride_count: 1,
    ...overrides,
  };
}

describe("filterRiddenByPeriod", () => {
  const now = new Date("2026-04-19T12:00:00Z");
  const segments: RiddenSegment[] = [
    seg({ id: "today", last_ridden_at: "2026-04-19T09:00:00Z" }),
    seg({ id: "60d", last_ridden_at: "2026-02-18T09:00:00Z" }),
    seg({ id: "lastyear", last_ridden_at: "2025-12-01T09:00:00Z" }),
    seg({ id: "2years", last_ridden_at: "2024-06-01T09:00:00Z" }),
  ];

  it("'all' returns every segment unchanged", () => {
    const result = filterRiddenByPeriod(segments, "all", now);
    expect(result.map((s) => s.id)).toEqual([
      "today",
      "60d",
      "lastyear",
      "2years",
    ]);
  });

  it("'year' keeps segments ridden in the current calendar year", () => {
    const result = filterRiddenByPeriod(segments, "year", now);
    expect(result.map((s) => s.id)).toEqual(["today", "60d"]);
  });

  it("'90d' keeps segments inside the rolling window", () => {
    const result = filterRiddenByPeriod(segments, "90d", now);
    expect(result.map((s) => s.id)).toEqual(["today", "60d"]);
  });

  it("'30d' keeps only segments ridden in the last 30 days", () => {
    const result = filterRiddenByPeriod(segments, "30d", now);
    expect(result.map((s) => s.id)).toEqual(["today"]);
  });

  it("drops segments with an unparseable last_ridden_at", () => {
    const result = filterRiddenByPeriod(
      [...segments, seg({ id: "bad", last_ridden_at: "not-a-date" })],
      "year",
      now,
    );
    expect(result.find((s) => s.id === "bad")).toBeUndefined();
  });
});

describe("indexRiddenSegments", () => {
  it("returns an O(1) lookup keyed by segment id", () => {
    const map = indexRiddenSegments([seg({ id: "a" }), seg({ id: "b" })]);
    expect(map.get("a")?.id).toBe("a");
    expect(map.get("b")?.id).toBe("b");
    expect(map.get("missing")).toBeUndefined();
  });
});

describe("buildMapShareSnapshot", () => {
  const stats = {
    ridden_segments: 1234,
    total_segments: 5678,
    percent_explored: 22,
    total_distance_km: 842,
  };
  const now = new Date("2026-04-25T10:00:00Z");

  it("captures stats, period, and a defensive copy of the segment list", () => {
    const segments = [seg({ id: "a" }), seg({ id: "b" })];
    const snapshot = buildMapShareSnapshot({
      stats,
      period: "year",
      segments,
      now,
    });

    expect(snapshot.version).toBe(1);
    expect(snapshot.generated_at).toBe("2026-04-25T10:00:00.000Z");
    expect(snapshot.period).toBe("year");
    expect(snapshot.stats).toEqual(stats);
    expect(snapshot.segments).toHaveLength(2);
    expect(snapshot.segments).not.toBe(segments);
    expect(snapshot.initial_center).toBeUndefined();
  });

  it("includes initial_center when supplied", () => {
    const snapshot = buildMapShareSnapshot({
      stats,
      period: "all",
      segments: [],
      initialCenter: { lat: 50.0, lng: 14.4, zoom: 8 },
      now,
    });
    expect(snapshot.initial_center).toEqual({ lat: 50.0, lng: 14.4, zoom: 8 });
  });
});

describe("parseMapShareSnapshot", () => {
  const valid: MapShareSnapshot = {
    version: 1,
    generated_at: "2026-04-25T10:00:00.000Z",
    period: "year",
    stats: {
      ridden_segments: 10,
      total_segments: 100,
      percent_explored: 10,
      total_distance_km: 50,
    },
    segments: [seg({ id: "a" })],
  };

  it("returns the snapshot when shape is valid", () => {
    expect(parseMapShareSnapshot(valid)).toEqual(valid);
  });

  it("returns null when version is missing or wrong", () => {
    expect(parseMapShareSnapshot({ ...valid, version: 0 })).toBeNull();
    const { version: _v, ...withoutVersion } = valid;
    expect(parseMapShareSnapshot(withoutVersion)).toBeNull();
  });

  it("returns null when period is unknown", () => {
    expect(
      parseMapShareSnapshot({ ...valid, period: "decade" as never }),
    ).toBeNull();
  });

  it("returns null when stats are malformed", () => {
    expect(
      parseMapShareSnapshot({
        ...valid,
        stats: { ridden_segments: "ten" } as never,
      }),
    ).toBeNull();
  });

  it("returns null when any segment row is malformed", () => {
    expect(
      parseMapShareSnapshot({
        ...valid,
        segments: [
          { id: "ok", last_ridden_at: "2026-04-01T00:00:00Z" },
        ] as never,
      }),
    ).toBeNull();
  });

  it("accepts a snapshot with initial_center", () => {
    const withCenter = {
      ...valid,
      initial_center: { lat: 50, lng: 14, zoom: 9 },
    };
    expect(parseMapShareSnapshot(withCenter)).toEqual(withCenter);
  });

  it("returns null when initial_center is malformed", () => {
    expect(
      parseMapShareSnapshot({
        ...valid,
        initial_center: { lat: 50 } as never,
      }),
    ).toBeNull();
  });
});
