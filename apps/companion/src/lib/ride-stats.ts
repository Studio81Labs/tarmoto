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

export interface RideFilters {
  year: number | "all";
  rideType: RideType | "all";
}

export const DEFAULT_RIDE_FILTERS: RideFilters = {
  year: "all",
  rideType: "all",
};

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
): RideForStats[] {
  return rides.filter((ride) => {
    if (filters.rideType !== "all" && ride.ride_type !== filters.rideType) {
      return false;
    }
    if (filters.year !== "all") {
      const date = parseStartedAt(ride.started_at);
      if (!date || date.getFullYear() !== filters.year) return false;
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
