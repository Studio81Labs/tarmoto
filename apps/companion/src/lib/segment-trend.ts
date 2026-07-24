/**
 * Pure helpers backing the road quality trend graph (US-45).
 *
 * The segment sidebar ships only `qualityHistory` (per-segment) and
 * optionally `regionalQualityHistory` (area average). This module derives
 * everything the chart renders — range-filtered series, repair/deterioration
 * markers, and summary deltas — from those two arrays so the React layer
 * stays thin and everything is unit-testable without a DOM.
 */

import type { EnglishMessageKey } from "@/i18n";

export type TrendRange = "3m" | "6m" | "1y" | "all";

export interface QualityPoint {
  date: string;
  score: number;
}

export interface TrendChangeEvent {
  /**
   * Index of the later point in the **date-sorted** series used by
   * `detectChangeEvents` for diffing — not the original caller-supplied
   * input order. `detectChangeEvents` sorts internally before pair-wise
   * comparison, so consumers should not use this to look up into the
   * original array.
   */
  index: number;
  date: string;
  score: number;
  previousScore: number;
  delta: number;
  kind: "repair" | "deterioration";
}

export interface TrendSummary {
  firstScore: number;
  latestScore: number;
  delta: number;
  direction: "improving" | "declining" | "stable";
}

export interface TrendChartPoint {
  date: string;
  score: number | null;
  regional: number | null;
  /** Set on points flagged as significant changes so recharts can style them. */
  changeKind?: "repair" | "deterioration";
}

export const TREND_RANGES: readonly TrendRange[] = ["3m", "6m", "1y", "all"];

export const TREND_RANGE_LABEL: Record<TrendRange, EnglishMessageKey> = {
  "3m": "3 months",
  "6m": "6 months",
  "1y": "1 year",
  all: "All time",
};

export const TREND_RANGE_SHORT_LABEL: Record<TrendRange, EnglishMessageKey> = {
  "3m": "3M",
  "6m": "6M",
  "1y": "1Y",
  all: "All",
};

/**
 * A ±0.5 jump across a single reading is roughly a full quality tier shift,
 * which is the point at which riders would perceive "this road feels
 * different". Smaller moves are noise from small sample counts.
 */
export const SIGNIFICANT_CHANGE_THRESHOLD = 0.5;

/** Clamp a quality reading into the 1–5 scoring band for rendering. */
export function clampScore(score: number): number {
  if (Number.isNaN(score)) return 1;
  if (score < 1) return 1;
  if (score > 5) return 5;
  return score;
}

/**
 * Shift a date backwards by whole months without the `setMonth` overflow
 * quirk: on end-of-month anchors (e.g. May 31 minus 3 months) the naive
 * `setMonth` lands on March 3 instead of February 28, which silently
 * shrinks the window by a few days and drops valid points. We clamp to
 * the last day of the target month instead.
 *
 * UTC accessors are used throughout because `filterByRange` compares via
 * `toISOString()` (UTC) — mixing local-time arithmetic here would let the
 * viewer's timezone flip the cutoff by ±1 day. Same pattern as
 * `rider-profile.ts`'s day bucketing.
 */
function subtractMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - months);
  const daysInTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(originalDay, daysInTargetMonth));
  return result;
}

function rangeCutoff(range: TrendRange, now: Date): Date | null {
  switch (range) {
    case "3m":
      return subtractMonths(now, 3);
    case "6m":
      return subtractMonths(now, 6);
    case "1y":
      // Also routed through subtractMonths to avoid a symmetric overflow:
      // raw `setFullYear` on Feb 29 of a leap year rolls to March 1 of the
      // target year, shrinking the window by a day.
      return subtractMonths(now, 12);
    case "all":
      return null;
  }
}

function sortByDate(points: readonly QualityPoint[]): QualityPoint[] {
  return [...points].sort((a, b) => a.date.localeCompare(b.date));
}

export function filterByRange(
  points: readonly QualityPoint[],
  range: TrendRange,
  now: Date = new Date(),
): QualityPoint[] {
  const sorted = sortByDate(points);
  const cutoff = rangeCutoff(range, now);
  if (!cutoff) return sorted;
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  return sorted.filter((p) => p.date >= cutoffIso);
}

/**
 * Find consecutive-pair jumps whose absolute delta meets the threshold.
 * Returns events in chronological order; `kind: "repair"` for positive jumps,
 * `"deterioration"` for negative ones. The index refers to the *later* point
 * in the input so callers can surface the moment the change was observed.
 */
export function detectChangeEvents(
  points: readonly QualityPoint[],
  threshold: number = SIGNIFICANT_CHANGE_THRESHOLD,
): TrendChangeEvent[] {
  const sorted = sortByDate(points);
  const events: TrendChangeEvent[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    const delta = curr.score - prev.score;
    if (Math.abs(delta) < threshold) continue;
    events.push({
      index: i,
      date: curr.date,
      score: curr.score,
      previousScore: prev.score,
      delta,
      kind: delta > 0 ? "repair" : "deterioration",
    });
  }
  return events;
}

/**
 * First-vs-last summary over the (already range-filtered) series. Stable is
 * reserved for deltas below a tight threshold so tiny ripples don't get
 * labelled as improving/declining.
 */
export function summariseTrend(
  points: readonly QualityPoint[],
  stableThreshold = 0.2,
): TrendSummary | null {
  const sorted = sortByDate(points);
  if (sorted.length === 0) return null;
  const first = sorted[0]!;
  const latest = sorted[sorted.length - 1]!;
  const delta = latest.score - first.score;
  let direction: TrendSummary["direction"];
  if (Math.abs(delta) < stableThreshold) direction = "stable";
  else if (delta > 0) direction = "improving";
  else direction = "declining";
  return {
    firstScore: first.score,
    latestScore: latest.score,
    delta,
    direction,
  };
}

/**
 * Merge the segment series and the regional series into a single array keyed
 * by date, so recharts can render both lines off one `data` prop. Gaps are
 * emitted as `null` on whichever series is missing that date — recharts
 * breaks the line across null values, which is the behaviour we want for
 * "we don't have a reading here".
 *
 * `events` is used to tag points (by date match against the segment series)
 * with a `changeKind` so the chart can render repair/deterioration markers
 * without a second pass.
 */
export function buildChartPoints(
  segment: readonly QualityPoint[],
  regional: readonly QualityPoint[],
  events: readonly TrendChangeEvent[],
): TrendChartPoint[] {
  const segmentMap = new Map<string, number>();
  for (const p of segment) segmentMap.set(p.date, p.score);
  const regionalMap = new Map<string, number>();
  for (const p of regional) regionalMap.set(p.date, p.score);
  const dates = Array.from(
    new Set<string>([...segmentMap.keys(), ...regionalMap.keys()]),
  ).sort();

  const eventByDate = new Map<string, TrendChangeEvent>();
  for (const ev of events) eventByDate.set(ev.date, ev);

  return dates.map((date) => {
    const rawScore = segmentMap.get(date);
    const rawRegional = regionalMap.get(date);
    const event = eventByDate.get(date);
    const point: TrendChartPoint = {
      date,
      score: rawScore == null ? null : clampScore(rawScore),
      regional: rawRegional == null ? null : clampScore(rawRegional),
    };
    if (event) point.changeKind = event.kind;
    return point;
  });
}
