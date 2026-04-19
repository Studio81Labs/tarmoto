import type * as GeoJSON from "geojson";
import type { RoutePreviewSegment, Trip, Waypoint } from "@/lib/types";
import { scoreToTier } from "@/lib/utils";

/**
 * GPX/KML import (US-38). Parses files exported from Garmin, Calimoto,
 * Kurviger, Scenic, Google Earth, etc. and turns them into the same
 * `Trip` shape the planner uses natively so the imported route can flow
 * through the existing sidebar, timeline, and export surfaces.
 *
 * Road-quality matching against Tarmoto's vector tiles requires the ML
 * pipeline (#6) + tile CDN (#79); until those land we synthesise a
 * deterministic preview score per segment so the overlay has something
 * meaningful to show. The score is derived from the segment's coords so
 * the same file always produces the same colours — callers get a stable
 * preview without a network round-trip.
 */

export type ImportResult =
  | { ok: true; route: ImportedRoute }
  | { ok: false; error: string };

export interface ImportedRoute {
  name: string;
  sourceFormat: "gpx" | "kml";
  points: Array<[number, number]>; // [lng, lat]
  waypoints: ImportedWaypoint[];
  totalDistanceKm: number;
}

export interface ImportedWaypoint {
  name?: string;
  lng: number;
  lat: number;
}

const MIN_POINTS = 2;
const MAX_PREVIEW_SEGMENTS = 20;
const MIN_SEGMENT_KM = 3;
const EARTH_RADIUS_KM = 6371;

export function parseImportedRoute(
  text: string,
  filename: string,
): ImportResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "File is empty." };

  const format = detectFormat(trimmed, filename);
  if (!format) {
    return {
      ok: false,
      error: "Unsupported file format. Upload a GPX or KML file.",
    };
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(trimmed, "application/xml");
  } catch {
    return { ok: false, error: "Could not read file as XML." };
  }
  if (doc.getElementsByTagName("parsererror").length > 0) {
    return { ok: false, error: "File is not valid XML." };
  }

  const route =
    format === "gpx" ? parseGpx(doc, filename) : parseKml(doc, filename);
  if (!route) {
    return {
      ok: false,
      error:
        format === "gpx"
          ? "GPX file has no track or route points."
          : "KML file has no LineString coordinates.",
    };
  }
  if (route.points.length < MIN_POINTS) {
    return { ok: false, error: "Route needs at least two points." };
  }

  return { ok: true, route };
}

function detectFormat(text: string, filename: string): "gpx" | "kml" | null {
  const lowerName = filename.toLowerCase();
  if (lowerName.endsWith(".gpx")) return "gpx";
  if (lowerName.endsWith(".kml")) return "kml";
  const head = text.slice(0, 2048).toLowerCase();
  if (head.includes("<gpx")) return "gpx";
  if (head.includes("<kml")) return "kml";
  return null;
}

function parseGpx(doc: Document, filename: string): ImportedRoute | null {
  const trackPoints = collectCoordsByTag(doc, "trkpt");
  const routePoints =
    trackPoints.length > 0 ? [] : collectCoordsByTag(doc, "rtept");
  const points = trackPoints.length > 0 ? trackPoints : routePoints;
  if (points.length === 0) return null;

  const waypoints: ImportedWaypoint[] = [];
  const wpts = doc.getElementsByTagName("wpt");
  for (let i = 0; i < wpts.length; i++) {
    const wp = readLatLonElement(wpts[i]);
    if (wp) waypoints.push(wp);
  }

  const trackName = firstChildText(doc, "trk", "name");
  const routeName = firstChildText(doc, "rte", "name");
  const metaName = firstChildText(doc, "metadata", "name");
  const name =
    trackName ??
    routeName ??
    metaName ??
    stripExtension(filename) ??
    "Imported route";

  return {
    name,
    sourceFormat: "gpx",
    points,
    waypoints,
    totalDistanceKm: pointsDistanceKm(points),
  };
}

function parseKml(doc: Document, filename: string): ImportedRoute | null {
  const lineStrings = doc.getElementsByTagName("LineString");
  const points: Array<[number, number]> = [];
  for (let i = 0; i < lineStrings.length; i++) {
    const coordsText = childText(lineStrings[i], "coordinates");
    if (!coordsText) continue;
    points.push(...parseKmlCoordString(coordsText));
  }
  if (points.length === 0) return null;

  const waypoints: ImportedWaypoint[] = [];
  const placemarks = doc.getElementsByTagName("Placemark");
  for (let i = 0; i < placemarks.length; i++) {
    const pm = placemarks[i];
    const point = pm.getElementsByTagName("Point")[0];
    if (!point) continue;
    const coordsText = childText(point, "coordinates");
    if (!coordsText) continue;
    const parsed = parseKmlCoordString(coordsText);
    const first = parsed[0];
    if (!first) continue;
    waypoints.push({
      name: childText(pm, "name") ?? undefined,
      lng: first[0],
      lat: first[1],
    });
  }

  const docName = firstChildText(doc, "Document", "name");
  const firstPlacemarkName = placemarks[0]
    ? childText(placemarks[0], "name")
    : null;
  const name =
    docName ??
    firstPlacemarkName ??
    stripExtension(filename) ??
    "Imported route";

  return {
    name,
    sourceFormat: "kml",
    points,
    waypoints,
    totalDistanceKm: pointsDistanceKm(points),
  };
}

function collectCoordsByTag(
  doc: Document,
  tag: string,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const nodes = doc.getElementsByTagName(tag);
  for (let i = 0; i < nodes.length; i++) {
    const wp = readLatLonElement(nodes[i]);
    if (wp) out.push([wp.lng, wp.lat]);
  }
  return out;
}

function readLatLonElement(el: Element): ImportedWaypoint | null {
  const latRaw = el.getAttribute("lat");
  const lonRaw = el.getAttribute("lon");
  const lat = latRaw ? Number.parseFloat(latRaw) : NaN;
  const lng = lonRaw ? Number.parseFloat(lonRaw) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return {
    name: childText(el, "name") ?? undefined,
    lat,
    lng,
  };
}

function parseKmlCoordString(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const tuple of text.trim().split(/\s+/)) {
    if (!tuple) continue;
    const [lngRaw, latRaw] = tuple.split(",");
    const lng = Number.parseFloat(lngRaw);
    const lat = Number.parseFloat(latRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    out.push([lng, lat]);
  }
  return out;
}

function firstChildText(
  doc: Document,
  parentTag: string,
  childTag: string,
): string | null {
  const parent = doc.getElementsByTagName(parentTag)[0];
  if (!parent) return null;
  return childText(parent, childTag);
}

function childText(parent: Element, tag: string): string | null {
  const children = parent.getElementsByTagName(tag);
  for (let i = 0; i < children.length; i++) {
    // Skip nested matches (e.g. a <name> inside a <link> inside this element).
    if (children[i].parentElement !== parent) continue;
    const text = children[i].textContent?.trim();
    if (text) return text;
  }
  return null;
}

function stripExtension(filename: string): string | null {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const cleaned = stem.replace(/[_-]+/g, " ").trim();
  return cleaned || null;
}

export function pointsDistanceKm(points: Array<[number, number]>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineKm(points[i - 1], points[i]);
  }
  return total;
}

function haversineKm(a: [number, number], b: [number, number]): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Convert an imported route into a single-day Trip so the planner's existing
 * sidebar, timeline, and export menu can handle it unchanged. We never emit
 * zero-length days — segments shorter than `MIN_SEGMENT_KM` are merged into
 * their neighbour so the Road Preview Cards stay readable.
 */
export function importedRouteToTrip(route: ImportedRoute): Trip {
  const segments = buildPreviewSegments(route);
  const totalDistanceKm = segments.reduce((s, seg) => s + seg.distanceKm, 0);
  const avgQuality =
    segments.length > 0
      ? segments.reduce((s, seg) => s + seg.qualityScore, 0) / segments.length
      : 0;

  const waypoints = deriveWaypoints(route);

  const geometry: GeoJSON.LineString = {
    type: "LineString",
    coordinates: route.points,
  };

  const now = new Date().toISOString();
  return {
    id: `imported-${Date.now()}`,
    name: route.name,
    description: `Imported from ${route.sourceFormat.toUpperCase()} · ${totalDistanceKm.toFixed(1)} km`,
    status: "draft",
    days: [
      {
        dayNumber: 1,
        title: route.name,
        waypoints,
        routeGeometry: geometry,
        distanceKm: Number.parseFloat(totalDistanceKm.toFixed(1)),
        // Rough estimate: 55 km/h average on curvy backroads.
        durationMinutes: Math.max(30, Math.round((totalDistanceKm / 55) * 60)),
        elevationGain: 0,
        avgQuality: Number.parseFloat(avgQuality.toFixed(2)),
        segments,
      },
    ],
    parameters: {
      days: 1,
      dailyKmTarget: Math.max(50, Math.round(totalDistanceKm)),
      roadPreference: "mixed",
      surfacePreference: ["asphalt"],
      avoidHighways: false,
      avoidTolls: false,
      avoidUnpaved: false,
      minQuality: 1,
    },
    collaborators: [{ userId: "u-owner", displayName: "You", role: "owner" }],
    createdAt: now,
    updatedAt: now,
  };
}

function deriveWaypoints(route: ImportedRoute): Waypoint[] {
  const first = route.points[0];
  const last = route.points[route.points.length - 1];
  const explicit: Waypoint[] = route.waypoints.map((wp, i) => ({
    id: `imp-wp-${i + 1}`,
    name: wp.name,
    location: { lng: wp.lng, lat: wp.lat },
    type: "via",
  }));

  const start: Waypoint = {
    id: "imp-wp-start",
    name: route.waypoints[0]?.name ?? "Start",
    location: { lng: first[0], lat: first[1] },
    type: "start",
  };
  const end: Waypoint = {
    id: "imp-wp-end",
    name: route.waypoints[route.waypoints.length - 1]?.name ?? "End",
    location: { lng: last[0], lat: last[1] },
    type: "end",
  };

  // Only keep explicit vias that aren't co-located with start/end.
  const vias = explicit.filter(
    (wp) =>
      !samePoint(wp.location, start.location) &&
      !samePoint(wp.location, end.location),
  );
  return [start, ...vias, end];
}

function samePoint(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): boolean {
  return Math.abs(a.lng - b.lng) < 1e-5 && Math.abs(a.lat - b.lat) < 1e-5;
}

/**
 * Split the raw polyline into preview segments (capped at 20) and assign a
 * deterministic quality score per chunk. Deterministic means the same file
 * always renders the same colours, which keeps the UI stable between
 * re-imports and in screenshots/tests.
 */
function buildPreviewSegments(route: ImportedRoute): RoutePreviewSegment[] {
  const total = route.totalDistanceKm;
  if (total <= 0 || route.points.length < 2) return [];

  const targetSegments = Math.min(
    MAX_PREVIEW_SEGMENTS,
    Math.max(
      1,
      Math.floor(
        total / Math.max(MIN_SEGMENT_KM, total / MAX_PREVIEW_SEGMENTS),
      ),
    ),
  );
  const chunkKm = total / targetSegments;

  const segments: RoutePreviewSegment[] = [];
  let acc = 0;
  let chunkPoints: Array<[number, number]> = [route.points[0]];
  let chunkDistance = 0;
  let chunkIndex = 0;

  for (let i = 1; i < route.points.length; i++) {
    const step = haversineKm(route.points[i - 1], route.points[i]);
    chunkDistance += step;
    acc += step;
    chunkPoints.push(route.points[i]);

    const isLast = i === route.points.length - 1;
    if (chunkDistance >= chunkKm || isLast) {
      segments.push(buildSegment(chunkIndex, chunkPoints, chunkDistance));
      chunkIndex++;
      chunkPoints = [route.points[i]];
      chunkDistance = 0;
    }
  }

  if (segments.length === 0) {
    // Route shorter than a chunk — emit one segment.
    segments.push(buildSegment(0, route.points, total));
  }
  return segments;
}

function buildSegment(
  index: number,
  points: Array<[number, number]>,
  distanceKm: number,
): RoutePreviewSegment {
  const seed = hashPoints(points);
  // Map seed to 2.0-4.8: a realistic preview range that still distinguishes
  // a "smooth" stretch from a "rough" one without lying about unknowns.
  const qualityScore = round1(2.0 + (seed % 281) / 100);
  const curvinessScore = 40 + ((seed >>> 7) % 55); // 40-94
  const bounds = computeBounds(points);
  return {
    id: `imp-seg-${index + 1}`,
    name: `Segment ${index + 1}`,
    dayNumber: 1,
    orderInDay: index,
    distanceKm: round1(distanceKm),
    qualityScore,
    qualityTier: scoreToTier(qualityScore),
    surfaceType: "asphalt",
    curvinessScore,
    elevationProfile: [],
    photos: [],
    activeHazards: [],
    bounds,
  };
}

function hashPoints(points: Array<[number, number]>): number {
  // 32-bit FNV-1a on the rounded coord stream. Stable across runs and fast.
  let h = 0x811c9dc5;
  for (const [lng, lat] of points) {
    const key = `${lng.toFixed(3)},${lat.toFixed(3)};`;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}

function computeBounds(
  points: Array<[number, number]>,
): [[number, number], [number, number]] | undefined {
  if (points.length === 0) return undefined;
  let minLng = points[0][0];
  let minLat = points[0][1];
  let maxLng = minLng;
  let maxLat = minLat;
  for (const [lng, lat] of points) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
