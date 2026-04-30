/**
 * Client-side trip → GPX rendering. Backend has no `/trips/:id/gpx`
 * endpoint (only the per-day GPX baked into the data-export bundle), so
 * the companion and mobile both build the file locally from the same
 * Trip shape they already render. Keeping the rendering in shared means
 * a fix to the GPX format only needs to land in one place.
 */

export interface TripGpxWaypoint {
  lat: number;
  lng: number;
  name?: string;
  /** Free-form type label (start / via / fuel / hotel / end / etc.). */
  type?: string;
}

export interface TripGpxDay {
  dayNumber: number;
  title?: string;
  waypoints: TripGpxWaypoint[];
  /** GeoJSON-style [lng, lat] pairs for the day's polyline, if known. */
  routeGeometry?: Array<[number, number]>;
}

export interface TripGpxInput {
  name: string;
  description?: string;
  days: TripGpxDay[];
}

const GPX_CREATOR = "Tarmoto";
const GPX_XMLNS = "http://www.topografix.com/GPX/1/1";

export function tripToGpx(trip: TripGpxInput, now: Date = new Date()): string {
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

    if (day.routeGeometry && day.routeGeometry.length > 1) {
      parts.push("  <trk>");
      parts.push(`    <name>${escapeText(dayLabel)}</name>`);
      parts.push("    <trkseg>");
      for (const [lng, lat] of day.routeGeometry) {
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

export function tripGpxFileName(name: string): string {
  const slug = slugify(name) || "trip";
  return `tarmoto-${slug}.gpx`;
}

function formatDayLabel(day: TripGpxDay): string {
  return day.title
    ? `Day ${day.dayNumber} — ${day.title}`
    : `Day ${day.dayNumber}`;
}

function renderRoutePoint(wp: TripGpxWaypoint): string {
  const lat = formatCoord(wp.lat);
  const lng = formatCoord(wp.lng);
  const lines = [`    <rtept lat="${lat}" lon="${lng}">`];
  if (wp.name) {
    lines.push(`      <name>${escapeText(wp.name)}</name>`);
  }
  if (wp.type) {
    lines.push(`      <type>${escapeText(wp.type)}</type>`);
  }
  lines.push("    </rtept>");
  return lines.join("\n");
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
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
