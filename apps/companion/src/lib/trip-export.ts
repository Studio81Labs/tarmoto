import type { Trip, TripDay, Waypoint } from "@/lib/types";

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

export function buildMobileDeepLink(trip: Trip): string {
  return `${MOBILE_URL_SCHEME}://trips/${encodeURIComponent(trip.id)}`;
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
