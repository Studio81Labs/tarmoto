/**
 * Pure helpers that derive aggregate riding statistics from a flat list of
 * rides as returned by `GET /api/v1/rides`. Kept side-effect free so the stats
 * dashboard can re-derive every view (totals, monthly, calendar, YoY) from one
 * fetch and re-run cheaply when filters change.
 */

export const RIDE_TYPES = ["free", "commute", "trip", "tracked"] as const;
export type RideType = (typeof RIDE_TYPES)[number];

export const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

// Minimal shape consumed by every helper. Both `RideSummaryDto` and
// `RideDetailDto` from the OpenAPI spec satisfy this contract; using an
// open interface here means the dashboard can also feed in mock data in tests
// without depending on the generated types.
export interface RideForStats {
  id: string;
  started_at: string;
  ended_at?: string | null;
  distance_km?: number | null;
  duration_min?: number | null;
  ride_type?: string | null;
  /** Distance-weighted road-quality score (0–5); drives the quality trend. */
  avg_road_quality?: number | null;
}

export interface AllTimeTotals {
  totalDistanceKm: number;
  totalRides: number;
  totalHours: number;
  avgRideDistanceKm: number;
  avgRideDurationMin: number;
  ridingDays: number;
}

export interface MonthlyBucket {
  monthIndex: number;
  monthLabel: (typeof MONTH_LABELS)[number];
  distanceKm: number;
  rides: number;
}

export interface YearlyTotal {
  year: number;
  distanceKm: number;
  rides: number;
}

export interface CalendarDay {
  date: string;
  distanceKm: number;
  rides: number;
}

export type YearOverYearPoint = {
  monthIndex: number;
  monthLabel: (typeof MONTH_LABELS)[number];
} & Record<string, number | string>;

/**
 * Time window for the stats filter — mirrors the Ride History time pills so the
 * two screens share one mental model (All time / This year / Last 90 / Last 30).
 */
export type StatsWindow = "all" | "year" | "90d" | "30d";

export const STATS_WINDOWS: { value: StatsWindow; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "year", label: "This year" },
  { value: "90d", label: "Last 90 days" },
  { value: "30d", label: "Last 30 days" },
];

export interface RideFilters {
  window: StatsWindow;
  rideType: RideType | "all";
}

export const DEFAULT_RIDE_FILTERS: RideFilters = {
  window: "all",
  rideType: "all",
};

/** Inclusive lower bound for a window, or null for "all". */
export function windowStart(
  window: StatsWindow,
  now = new Date(),
): Date | null {
  if (window === "all") return null;
  if (window === "year") return new Date(now.getFullYear(), 0, 1);
  // Start of the calendar day `days - 1` before today, so the window spans
  // exactly `days` calendar days including today. This keeps the rolling KPI
  // filter, the daily chart buckets (`computeDistanceSeries`) and the server
  // breakdown bound on the same day — no ride lands in one but not the others.
  const days = window === "90d" ? 90 : 30;
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - (days - 1),
  );
}

export function isRideType(value: unknown): value is RideType {
  return (
    typeof value === "string" &&
    (RIDE_TYPES as readonly string[]).includes(value)
  );
}

// Shared across this module and `exploration.ts` — any fix here (e.g. timezone
// handling in `localDateKey`) needs to be consistent between stats and the
// personal road map.
export function toNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseStartedAt(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function localDateKey(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function filterRides(
  rides: readonly RideForStats[],
  filters: RideFilters,
  now = new Date(),
): RideForStats[] {
  const start = windowStart(filters.window, now);
  return rides.filter((ride) => {
    if (filters.rideType !== "all" && ride.ride_type !== filters.rideType) {
      return false;
    }
    if (start) {
      const date = parseStartedAt(ride.started_at);
      if (!date || date < start) return false;
    }
    return true;
  });
}

export function availableYears(rides: readonly RideForStats[]): number[] {
  const years = new Set<number>();
  for (const ride of rides) {
    const date = parseStartedAt(ride.started_at);
    if (date) years.add(date.getFullYear());
  }
  return [...years].sort((a, b) => b - a);
}

export function computeAllTimeTotals(
  rides: readonly RideForStats[],
): AllTimeTotals {
  let totalDistanceKm = 0;
  let totalDurationMin = 0;
  const ridingDayKeys = new Set<string>();

  for (const ride of rides) {
    totalDistanceKm += toNumber(ride.distance_km);
    totalDurationMin += toNumber(ride.duration_min);
    const date = parseStartedAt(ride.started_at);
    if (date) ridingDayKeys.add(localDateKey(date));
  }

  const totalRides = rides.length;
  return {
    totalDistanceKm,
    totalRides,
    totalHours: totalDurationMin / 60,
    avgRideDistanceKm: totalRides > 0 ? totalDistanceKm / totalRides : 0,
    avgRideDurationMin: totalRides > 0 ? totalDurationMin / totalRides : 0,
    ridingDays: ridingDayKeys.size,
  };
}

export function computeMonthlyDistance(
  rides: readonly RideForStats[],
  year: number,
): MonthlyBucket[] {
  const buckets: MonthlyBucket[] = MONTH_LABELS.map((label, index) => ({
    monthIndex: index,
    monthLabel: label,
    distanceKm: 0,
    rides: 0,
  }));

  for (const ride of rides) {
    const date = parseStartedAt(ride.started_at);
    if (!date || date.getFullYear() !== year) continue;
    const bucket = buckets[date.getMonth()];
    if (!bucket) continue;
    bucket.distanceKm += toNumber(ride.distance_km);
    bucket.rides += 1;
  }

  return buckets;
}

export type ChartGranularity = "month" | "day";

/** A single bar in the distance chart — a month or a day, per the window. */
export interface DistancePoint {
  /** Stable bucket key: `YYYY-MM` (month) or `YYYY-MM-DD` (day). */
  key: string;
  /** Compact x-axis tick: month abbreviation, or day-of-month. */
  axisLabel: string;
  /** Full, unambiguous label for the tooltip ("Jun 2026" / "5 Jun 2026"). */
  tooltipLabel: string;
  distanceKm: number;
  rides: number;
}

/** Short rolling windows render one bar per day; the rest, one per month. */
export function distanceGranularity(window: StatsWindow): ChartGranularity {
  return window === "30d" || window === "90d" ? "day" : "month";
}

const monthKeyOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

function monthPoint(year: number, monthIndex: number): DistancePoint {
  return {
    key: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
    axisLabel: MONTH_LABELS[monthIndex]!,
    tooltipLabel: `${MONTH_LABELS[monthIndex]} ${year}`,
    distanceKm: 0,
    rides: 0,
  };
}

function dayPoint(date: Date): DistancePoint {
  return {
    key: localDateKey(date),
    axisLabel: String(date.getDate()),
    tooltipLabel: `${date.getDate()} ${MONTH_LABELS[date.getMonth()]} ${date.getFullYear()}`,
    distanceKm: 0,
    rides: 0,
  };
}

function fillSeries(
  points: DistancePoint[],
  rides: readonly RideForStats[],
  keyOf: (date: Date) => string,
): DistancePoint[] {
  const index = new Map(points.map((p) => [p.key, p]));
  for (const ride of rides) {
    const date = parseStartedAt(ride.started_at);
    if (!date) continue;
    const bucket = index.get(keyOf(date));
    if (!bucket) continue;
    bucket.distanceKm += toNumber(ride.distance_km);
    bucket.rides += 1;
  }
  return points;
}

/**
 * Distance bars shaped to the active window (oldest → newest). Feed
 * already-type-filtered rides; the time window is applied here:
 *  - "all": the last 12 calendar months (rolling) ending at `now`.
 *  - "year": Jan → Dec of the current year — future months stay empty.
 *  - "90d"/"30d": one bar per day for the last 90 / 30 days.
 * Out-of-range rides simply have no bucket and don't appear.
 */
export function computeDistanceSeries(
  rides: readonly RideForStats[],
  window: StatsWindow,
  now = new Date(),
): DistancePoint[] {
  if (window === "30d" || window === "90d") {
    const daysBack = window === "90d" ? 90 : 30;
    const points: DistancePoint[] = [];
    for (let i = daysBack - 1; i >= 0; i -= 1) {
      points.push(
        dayPoint(
          new Date(now.getFullYear(), now.getMonth(), now.getDate() - i),
        ),
      );
    }
    return fillSeries(points, rides, localDateKey);
  }
  if (window === "year") {
    const year = now.getFullYear();
    const points = MONTH_LABELS.map((_, m) => monthPoint(year, m));
    return fillSeries(points, rides, monthKeyOf);
  }
  const points: DistancePoint[] = [];
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    points.push(monthPoint(d.getFullYear(), d.getMonth()));
  }
  return fillSeries(points, rides, monthKeyOf);
}

export interface QualityPoint {
  /** `YYYY-MM` key for the calendar month. */
  key: string;
  /** Compact x-axis tick (month abbreviation). */
  axisLabel: string;
  /** Full tooltip label, e.g. "Jun 2026". */
  tooltipLabel: string;
  /** Distance-weighted average road quality (0–5), or null with no scored rides. */
  avgQuality: number | null;
  rides: number;
}

/**
 * Monthly distance-weighted road-quality average for the last 12 calendar
 * months ending at `now` (oldest → newest) — the "Quality trend · 12 months"
 * card. Backed entirely by `ride.avg_road_quality` already on the ride list;
 * a month with no scored rides yields `avgQuality: null` so the chart can gap
 * it rather than plot a misleading zero.
 */
export function computeQualityTrend(
  rides: readonly RideForStats[],
  now = new Date(),
): QualityPoint[] {
  interface Acc {
    point: QualityPoint;
    weighted: number;
    weight: number;
    sum: number;
    scored: number;
  }
  const accs: Acc[] = [];
  const index = new Map<string, Acc>();
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const base = monthPoint(d.getFullYear(), d.getMonth());
    const acc: Acc = {
      point: { ...base, avgQuality: null, rides: 0 },
      weighted: 0,
      weight: 0,
      sum: 0,
      scored: 0,
    };
    accs.push(acc);
    index.set(base.key, acc);
  }

  for (const ride of rides) {
    const date = parseStartedAt(ride.started_at);
    if (!date) continue;
    const acc = index.get(monthKeyOf(date));
    if (!acc) continue;
    acc.point.rides += 1;
    const quality = ride.avg_road_quality;
    if (typeof quality !== "number" || !Number.isFinite(quality)) continue;
    const distance = toNumber(ride.distance_km);
    acc.weighted += quality * distance;
    acc.weight += distance;
    acc.sum += quality;
    acc.scored += 1;
  }

  return accs.map(({ point, weighted, weight, sum, scored }) => {
    if (scored === 0) return point;
    // Distance-weight when distances exist; fall back to a plain mean so a
    // month of zero-distance rides still reports its quality.
    const avg = weight > 0 ? weighted / weight : sum / scored;
    return { ...point, avgQuality: Math.round(avg * 100) / 100 };
  });
}

export function computeYearlyTotals(
  rides: readonly RideForStats[],
): YearlyTotal[] {
  const totals = new Map<number, YearlyTotal>();
  for (const ride of rides) {
    const date = parseStartedAt(ride.started_at);
    if (!date) continue;
    const year = date.getFullYear();
    const existing = totals.get(year) ?? {
      year,
      distanceKm: 0,
      rides: 0,
    };
    existing.distanceKm += toNumber(ride.distance_km);
    existing.rides += 1;
    totals.set(year, existing);
  }
  return [...totals.values()].sort((a, b) => a.year - b.year);
}

export function computeCalendarHeatmap(
  rides: readonly RideForStats[],
  year: number,
): CalendarDay[] {
  const byDate = new Map<string, CalendarDay>();
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInYear = isLeap ? 366 : 365;

  // Pre-fill every day of the year so the UI can render a stable grid even
  // when there are no rides at all.
  for (let dayOfYear = 0; dayOfYear < daysInYear; dayOfYear += 1) {
    const date = new Date(year, 0, 1 + dayOfYear);
    const key = localDateKey(date);
    byDate.set(key, { date: key, distanceKm: 0, rides: 0 });
  }

  for (const ride of rides) {
    const date = parseStartedAt(ride.started_at);
    if (!date || date.getFullYear() !== year) continue;
    const key = localDateKey(date);
    const day = byDate.get(key);
    if (!day) continue;
    day.distanceKm += toNumber(ride.distance_km);
    day.rides += 1;
  }

  return [...byDate.values()];
}

export function computeYearOverYear(
  rides: readonly RideForStats[],
  years: readonly number[],
): YearOverYearPoint[] {
  const points: YearOverYearPoint[] = MONTH_LABELS.map((label, index) => {
    const point: YearOverYearPoint = {
      monthIndex: index,
      monthLabel: label,
    };
    for (const year of years) {
      point[String(year)] = 0;
    }
    return point;
  });

  const yearSet = new Set(years.map(String));
  for (const ride of rides) {
    const date = parseStartedAt(ride.started_at);
    if (!date) continue;
    const yearKey = String(date.getFullYear());
    if (!yearSet.has(yearKey)) continue;
    const point = points[date.getMonth()];
    if (!point) continue;
    const current = point[yearKey];
    point[yearKey] =
      (typeof current === "number" ? current : 0) + toNumber(ride.distance_km);
  }

  return points;
}
