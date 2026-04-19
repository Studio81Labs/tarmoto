import { describe, expect, it } from "vitest";
import {
  SIGNIFICANT_CHANGE_THRESHOLD,
  buildChartPoints,
  clampScore,
  detectChangeEvents,
  filterByRange,
  summariseTrend,
  type QualityPoint,
} from "@/lib/segment-trend";

const HISTORY: QualityPoint[] = [
  { date: "2025-05-01", score: 3.6 },
  { date: "2025-08-01", score: 3.4 },
  { date: "2025-11-01", score: 3.2 },
  // +0.9 jump — repair
  { date: "2026-01-10", score: 4.1 },
  { date: "2026-03-01", score: 4.2 },
];

const NOW = new Date("2026-04-15T00:00:00Z");

describe("clampScore", () => {
  it("clamps into the 1–5 band", () => {
    expect(clampScore(0.5)).toBe(1);
    expect(clampScore(1.2)).toBe(1.2);
    expect(clampScore(5.8)).toBe(5);
  });

  it("defaults NaN to the floor", () => {
    expect(clampScore(Number.NaN)).toBe(1);
  });
});

describe("filterByRange", () => {
  it("keeps only points inside the window and sorts them", () => {
    const unsorted: QualityPoint[] = [
      { date: "2026-03-01", score: 4.2 },
      { date: "2025-05-01", score: 3.6 },
      { date: "2026-01-10", score: 4.1 },
    ];
    const result = filterByRange(unsorted, "6m", NOW);
    expect(result.map((p) => p.date)).toEqual(["2026-01-10", "2026-03-01"]);
  });

  it("returns everything for 'all' sorted ascending", () => {
    const result = filterByRange(HISTORY, "all", NOW);
    expect(result.map((p) => p.date)).toEqual([
      "2025-05-01",
      "2025-08-01",
      "2025-11-01",
      "2026-01-10",
      "2026-03-01",
    ]);
  });

  it("returns empty when nothing falls inside the window", () => {
    const result = filterByRange(HISTORY, "3m", new Date("2030-01-01"));
    expect(result).toEqual([]);
  });
});

describe("detectChangeEvents", () => {
  it("flags jumps above the threshold as repairs and drops as deterioration", () => {
    const events = detectChangeEvents(HISTORY);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      date: "2026-01-10",
      kind: "repair",
    });
    expect(events[0]!.delta).toBeCloseTo(0.9, 5);
  });

  it("returns deterioration events when scores drop by ≥ threshold", () => {
    const declining: QualityPoint[] = [
      { date: "2025-07-01", score: 4.0 },
      { date: "2025-10-01", score: 3.8 },
      { date: "2026-01-01", score: 3.0 },
      { date: "2026-03-01", score: 2.4 },
    ];
    const events = detectChangeEvents(declining);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["deterioration", "deterioration"]);
  });

  it("ignores noise below the threshold", () => {
    const noise: QualityPoint[] = [
      { date: "2025-07-01", score: 3.5 },
      { date: "2025-10-01", score: 3.6 },
      { date: "2026-01-01", score: 3.4 },
    ];
    expect(detectChangeEvents(noise)).toEqual([]);
  });

  it("is sensitive to a custom threshold", () => {
    expect(detectChangeEvents(HISTORY, 1.0)).toEqual([]);
    expect(detectChangeEvents(HISTORY, 0.3)).toHaveLength(1);
  });

  it("uses the canonical threshold constant", () => {
    expect(SIGNIFICANT_CHANGE_THRESHOLD).toBe(0.5);
  });

  it("sorts input before diffing", () => {
    const shuffled = [...HISTORY].reverse();
    const events = detectChangeEvents(shuffled);
    expect(events[0]?.date).toBe("2026-01-10");
  });
});

describe("summariseTrend", () => {
  it("labels a clear upward trajectory as improving", () => {
    const summary = summariseTrend(HISTORY);
    expect(summary?.direction).toBe("improving");
    expect(summary?.delta).toBeCloseTo(0.6, 5);
  });

  it("labels deltas under the stable threshold as stable", () => {
    const flat: QualityPoint[] = [
      { date: "2025-07-01", score: 3.5 },
      { date: "2026-01-01", score: 3.6 },
    ];
    expect(summariseTrend(flat)?.direction).toBe("stable");
  });

  it("returns null on empty input", () => {
    expect(summariseTrend([])).toBeNull();
  });
});

describe("buildChartPoints", () => {
  it("unions segment + regional dates and fills gaps with null", () => {
    const segment: QualityPoint[] = [
      { date: "2026-01-01", score: 3.0 },
      { date: "2026-03-01", score: 4.0 },
    ];
    const regional: QualityPoint[] = [
      { date: "2026-02-01", score: 3.5 },
      { date: "2026-03-01", score: 3.6 },
    ];
    const points = buildChartPoints(segment, regional, []);
    expect(points).toEqual([
      { date: "2026-01-01", score: 3, regional: null },
      { date: "2026-02-01", score: null, regional: 3.5 },
      { date: "2026-03-01", score: 4, regional: 3.6 },
    ]);
  });

  it("tags change events by date", () => {
    const events = detectChangeEvents(HISTORY);
    const points = buildChartPoints(HISTORY, [], events);
    const tagged = points.find((p) => p.changeKind);
    expect(tagged?.date).toBe("2026-01-10");
    expect(tagged?.changeKind).toBe("repair");
  });

  it("clamps out-of-band scores at the 1–5 boundaries", () => {
    const points = buildChartPoints(
      [
        { date: "2026-01-01", score: -1 },
        { date: "2026-02-01", score: 9 },
      ],
      [],
      [],
    );
    expect(points.map((p) => p.score)).toEqual([1, 5]);
  });
});
