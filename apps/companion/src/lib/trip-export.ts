import type { RoutePreviewSegment, Trip, TripDay, Waypoint } from "@/lib/types";

/**
 * Route export (US-39): GPX generation, share links, and mobile deep links
 * for a planned Trip. Frontend-only — the planner Trip state is the source of
 * truth; no backend round-trip is required to emit a file the user can hand
 * to Garmin, Calimoto, Kurviger, etc.
 */

const GPX_CREATOR = "Tarmoto Companion";
const GPX_XMLNS = "http://www.topografix.com/GPX/1/1";
const MOBILE_URL_SCHEME = "tarmoto";

const WAYPOINT_LABEL: Record<Waypoint["type"], string> = {
  start: "Start",
  end: "End",
  via: "Via",
  fuel: "Fuel stop",
  rest: "Rest",
  photo: "Photo stop",
  accommodation: "Overnight",
};

export interface TurnListItem {
  dayNumber: number;
  dayTitle: string | undefined;
  distanceKm: number;
  durationMinutes: number;
  waypoints: Array<{
    label: string;
    typeLabel: string;
    lat: number;
    lng: number;
  }>;
}

export function tripToGpx(trip: Trip, now: Date = new Date()): string {
  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(
    `<gpx version="1.1" creator="${escapeAttr(GPX_CREATOR)}" xmlns="${GPX_XMLNS}">`,
  );
  parts.push("  <metadata>");
  parts.push(`    <name>${escapeText(trip.name)}</name>`);
  if (trip.description) {
    parts.push(`    <desc>${escapeText(trip.description)}</desc>`);
  }
  parts.push(`    <time>${now.toISOString()}</time>`);
  parts.push("  </metadata>");

  for (const day of trip.days) {
    const dayLabel = formatDayLabel(day);
    if (day.waypoints.length > 0) {
      parts.push("  <rte>");
      parts.push(`    <name>${escapeText(dayLabel)}</name>`);
      for (const wp of day.waypoints) {
        parts.push(renderRoutePoint(wp));
      }
      parts.push("  </rte>");
    }

    const geometry = day.routeGeometry;
    if (geometry && geometry.coordinates.length > 1) {
      parts.push("  <trk>");
      parts.push(`    <name>${escapeText(dayLabel)}</name>`);
      parts.push("    <trkseg>");
      for (const [lng, lat] of geometry.coordinates) {
        if (lng === undefined || lat === undefined) continue;
        parts.push(
          `      <trkpt lat="${formatCoord(lat)}" lon="${formatCoord(lng)}" />`,
        );
      }
      parts.push("    </trkseg>");
      parts.push("  </trk>");
    }
  }

  parts.push("</gpx>");
  return parts.join("\n");
}

export function tripFileName(trip: Trip, ext: string): string {
  // Slugify the id as well — trip ids are opaque and can contain slashes or
  // spaces (see `buildTripShareUrl` which url-encodes them), which would
  // otherwise leak into the download filename.
  const slug = slugify(trip.name) || slugify(trip.id) || "trip";
  const cleanExt = ext.replace(/^\./, "");
  return `tarmoto-${slug}.${cleanExt}`;
}

export function buildTripShareUrl(trip: Trip, origin: string): string {
  const base = origin.replace(/\/$/, "");
  return `${base}/trips/${encodeURIComponent(trip.id)}`;
}

/**
 * Build the mobile deep link the "Push to mobile" action launches. The
 * mobile app routes `tarmoto://trips/import?tripId=...&token=...` to its
 * import screen, where the rider confirms and the snapshot is fetched
 * from `/trip-shares/:token` (no auth, read-only) and copied into their
 * library. The token is the share token returned by `POST /trip-shares`.
 */
export function buildMobileDeepLink(tripId: string, token: string): string {
  const params = new URLSearchParams({ tripId, token });
  return `${MOBILE_URL_SCHEME}://trips/import?${params.toString()}`;
}

/**
 * Key used by the planner to hand a Trip to the print tab via localStorage.
 * The planner Zustand store is tab-scoped, so a new tab opened via
 * `window.open` starts empty and needs the trip re-hydrated explicitly.
 * We use localStorage (not sessionStorage) because `window.open` with the
 * `noopener` flag severs the creator relationship, which per the HTML spec
 * skips the sessionStorage copy; localStorage is shared across same-origin
 * tabs so the handoff works regardless of `noopener`.
 */
export const TRIP_PRINT_STORAGE_KEY = "tarmoto-print-trip";

export interface WaypointGroup {
  label: string;
  waypoints: Array<{
    label: string;
    typeLabel: string;
    lat: number;
    lng: number;
  }>;
}

/**
 * Group a day's waypoints into the buckets the printable trip plan renders
 * separately ("Stops" / "Fuel" / "Accommodation"). Used by the PDF layout
 * (US-39) so a rider can scan refuel and overnight points without sifting
 * through the full waypoint list.
 */
export function groupDayWaypoints(day: TripDay): WaypointGroup[] {
  const stops: WaypointGroup["waypoints"] = [];
  const fuel: WaypointGroup["waypoints"] = [];
  const accommodation: WaypointGroup["waypoints"] = [];
  day.waypoints.forEach((wp, index) => {
    const entry = {
      label: wp.name ?? fallbackWaypointLabel(wp, index),
      typeLabel: WAYPOINT_LABEL[wp.type],
      lat: wp.location.lat,
      lng: wp.location.lng,
    };
    if (wp.type === "fuel") fuel.push(entry);
    else if (wp.type === "accommodation") accommodation.push(entry);
    else stops.push(entry);
  });
  const groups: WaypointGroup[] = [];
  if (stops.length > 0) groups.push({ label: "Stops", waypoints: stops });
  if (fuel.length > 0) groups.push({ label: "Fuel", waypoints: fuel });
  if (accommodation.length > 0)
    groups.push({ label: "Accommodation", waypoints: accommodation });
  return groups;
}

/**
 * Pick the most "preview-worthy" road segments across all days for the PDF
 * appendix (US-39). Sorted by quality * distance so the rider sees the
 * highlights first; capped at `limit` (default 6) so the appendix stays
 * within roughly one printed page.
 */
export function pickAppendixSegments(
  trip: Trip,
  limit = 6,
): RoutePreviewSegment[] {
  const all: RoutePreviewSegment[] = [];
  for (const day of trip.days) {
    if (day.segments?.length) {
      for (const seg of day.segments) all.push(seg);
    }
  }
  return all
    .slice()
    .sort(
      (a, b) => b.qualityScore * b.distanceKm - a.qualityScore * a.distanceKm,
    )
    .slice(0, Math.max(0, limit));
}

/**
 * Sample an elevation profile down to ~80 points so the printed sparkline
 * stays readable without paying for hundreds of <line> elements per day.
 * Returns the original array unchanged when it's already short.
 */
export function sampleElevationProfile(
  profile: readonly number[],
  maxPoints = 80,
): number[] {
  if (profile.length <= maxPoints) return profile.slice();
  const out: number[] = [];
  const step = (profile.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    const value = profile[Math.round(i * step)];
    if (value !== undefined) out.push(value);
  }
  return out;
}

/**
 * Concatenate the per-segment elevation profiles for a day so the print
 * page can draw one sparkline covering the whole day's ride. Returns null
 * when the day carries no segment data (e.g. imported GPX trips that skip
 * the road-segment lookup).
 */
export function buildDayElevationProfile(day: TripDay): number[] | null {
  if (!day.segments?.length) return null;
  const points: number[] = [];
  for (const seg of day.segments) {
    if (!Array.isArray(seg.elevationProfile)) continue;
    for (const value of seg.elevationProfile) {
      if (Number.isFinite(value)) points.push(value);
    }
  }
  if (points.length < 2) return null;
  return sampleElevationProfile(points);
}

export function buildTurnList(trip: Trip): TurnListItem[] {
  return trip.days.map((day) => ({
    dayNumber: day.dayNumber,
    dayTitle: day.title,
    distanceKm: day.distanceKm,
    durationMinutes: day.durationMinutes,
    waypoints: day.waypoints.map((wp, index) => ({
      label: wp.name ?? fallbackWaypointLabel(wp, index),
      typeLabel: WAYPOINT_LABEL[wp.type],
      lat: wp.location.lat,
      lng: wp.location.lng,
    })),
  }));
}

function fallbackWaypointLabel(wp: Waypoint, index: number): string {
  return `${WAYPOINT_LABEL[wp.type]} ${index + 1}`;
}

function formatDayLabel(day: TripDay): string {
  return day.title
    ? `Day ${day.dayNumber} — ${day.title}`
    : `Day ${day.dayNumber}`;
}

function renderRoutePoint(wp: Waypoint): string {
  const name = wp.name ?? WAYPOINT_LABEL[wp.type];
  const lat = formatCoord(wp.location.lat);
  const lng = formatCoord(wp.location.lng);
  return [
    `    <rtept lat="${lat}" lon="${lng}">`,
    `      <name>${escapeText(name)}</name>`,
    `      <type>${escapeText(wp.type)}</type>`,
    `    </rtept>`,
  ].join("\n");
}

function formatCoord(value: number): string {
  // 6 decimals ≈ 11 cm of precision, plenty for route planning while keeping
  // the file small and matching what Garmin/Calimoto emit.
  return value.toFixed(6);
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
