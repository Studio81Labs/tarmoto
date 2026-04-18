/**
 * Pure formatting + shaping helpers for the Trip screens.
 *
 * Kept out of the screen modules so unit tests can exercise them without
 * pulling React Native or navigation into the module graph.
 */

import type { TripDay, TripStatus, Waypoint, WaypointType } from "@/types";

export const DAILY_KM_PRESETS = [
  { label: "Relaxed", min: 100, max: 200 },
  { label: "Standard", min: 150, max: 300 },
  { label: "Long", min: 200, max: 400 },
  { label: "Epic", min: 300, max: 500 },
] as const;

export type DailyKmPreset = (typeof DAILY_KM_PRESETS)[number];

export const ROAD_PREFERENCES = [
  { value: "curvy", label: "Curvy" },
  { value: "scenic", label: "Scenic" },
  { value: "mixed", label: "Mixed" },
  { value: "fast", label: "Fast" },
] as const;

export type RoadPreferenceValue = (typeof ROAD_PREFERENCES)[number]["value"];

export const DAY_OPTIONS = [2, 3, 4, 5, 7, 10, 14] as const;

/**
 * Pick the preset whose (min,max) matches the stored trip values. Returns
 * `null` when the stored values don't line up — callers fall back to the
 * default preset so we don't silently coerce an unfamiliar range.
 */
export function findDailyKmPreset(
  min: number | undefined,
  max: number | undefined,
): DailyKmPreset | null {
  if (min == null || max == null) return null;
  return DAILY_KM_PRESETS.find((p) => p.min === min && p.max === max) ?? null;
}

export function formatKm(km: number): string {
  if (!Number.isFinite(km)) return "0 km";
  return `${Math.round(km)} km`;
}

/** "2h 30m" / "45m" — keep short for metric rows. */
export function formatDurationMin(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0m";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function formatStatus(status: TripStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function formatWaypointType(t: WaypointType): string {
  // "via" reads oddly capitalised — leave it lowercase so "Via" doesn't
  // appear as a proper noun in the UI.
  if (t === "via") return "Waypoint";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export const WAYPOINT_ICONS: Record<WaypointType, string> = {
  start: "flag-outline",
  via: "map-marker",
  fuel: "gas-station",
  food: "silverware-fork-knife",
  coffee: "coffee",
  hotel: "bed",
  photo: "camera-outline",
  end: "flag-checkered",
};

/**
 * Group waypoints by "logistics" buckets for the day breakdown. Everything
 * that isn't start/end/fuel/hotel collapses into "stops" since riders care
 * most about fuel range and where they're sleeping — the rest is just
 * turn-by-turn detail the map covers.
 */
export function summarizeWaypoints(waypoints: Waypoint[]): {
  fuelStops: Waypoint[];
  overnightStops: Waypoint[];
  otherStops: Waypoint[];
  start: Waypoint | null;
  end: Waypoint | null;
} {
  const sorted = [...waypoints].sort((a, b) => a.sequence - b.sequence);
  const fuelStops = sorted.filter((w) => w.waypoint_type === "fuel");
  const overnightStops = sorted.filter((w) => w.waypoint_type === "hotel");
  const otherStops = sorted.filter(
    (w) =>
      w.waypoint_type !== "fuel" &&
      w.waypoint_type !== "hotel" &&
      w.waypoint_type !== "start" &&
      w.waypoint_type !== "end",
  );
  const start = sorted.find((w) => w.waypoint_type === "start") ?? null;
  const end = sorted.find((w) => w.waypoint_type === "end") ?? null;
  return { fuelStops, overnightStops, otherStops, start, end };
}

export function sumDistance(days: TripDay[]): number {
  return days.reduce((acc, d) => acc + (d.distance_km || 0), 0);
}

export function averageQuality(days: TripDay[]): number {
  if (days.length === 0) return 0;
  // Weight by distance so a 400 km day of great asphalt doesn't get
  // averaged away by a 50 km gravel hop.
  const totalKm = sumDistance(days);
  if (totalKm <= 0) {
    const flat =
      days.reduce((acc, d) => acc + (d.avg_quality || 0), 0) / days.length;
    return Number.isFinite(flat) ? flat : 0;
  }
  const weighted = days.reduce(
    (acc, d) => acc + (d.avg_quality || 0) * (d.distance_km || 0),
    0,
  );
  return weighted / totalKm;
}

/**
 * Build a coarse bounding box around a start point for the generator API.
 * The backend refines this based on the number of days, but it needs *some*
 * envelope so the initial solver doesn't grind over the entire continent.
 *
 * Per-day budget: a ~100 km radius per ride day, capped at 600 km so a
 * 14-day epic doesn't ask the server for a 1500 km square.
 */
export function bboxAroundPoint(
  lat: number,
  lng: number,
  numDays: number,
): string {
  const safeDays = Math.max(1, Math.min(14, Math.round(numDays || 1)));
  const radiusKm = Math.min(600, safeDays * 100);
  // 1 degree latitude ≈ 111 km, longitude scales by cos(lat).
  const latDelta = radiusKm / 111;
  const latRad = (lat * Math.PI) / 180;
  const lngDelta = radiusKm / (111 * Math.max(0.1, Math.cos(latRad)));
  const minLng = lng - lngDelta;
  const minLat = lat - latDelta;
  const maxLng = lng + lngDelta;
  const maxLat = lat + latDelta;
  // West, South, East, North — the OGC convention the backend consumes.
  return `${minLng.toFixed(4)},${minLat.toFixed(4)},${maxLng.toFixed(4)},${maxLat.toFixed(4)}`;
}
