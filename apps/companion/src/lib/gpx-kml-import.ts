import type * as GeoJSON from "geojson";
import {
  parseImportedRoute as sharedParseImportedRoute,
  pointsDistanceKm as sharedPointsDistanceKm,
  type ImportedRoute,
  type ImportedWaypoint,
  type ImportResult,
} from "@tarmoto/shared";
import type { RoutePreviewSegment, Trip, Waypoint } from "@/lib/types";
import { scoreToTier } from "@/lib/utils";

/**
 * GPX/KML import (US-38 / US-20). Parses files exported from Garmin,
 * Calimoto, Kurviger, Scenic, Google Earth, etc. The actual parsing now
 * lives in `@tarmoto/shared` so the mobile app can reuse it without
 * dragging in a browser DOMParser polyfill; the planner-specific
 * `importedRouteToTrip` (segments, waypoint dedup, deterministic
 * preview quality) stays here because it depends on the planner's
 * `Trip`/`RoutePreviewSegment` shapes.
 *
 * Road-quality matching against Tarmoto's vector tiles requires the ML
 * pipeline (#6) + tile CDN (#79); until those land we synthesise a
 * deterministic preview score per segment so the overlay has something
 * meaningful to show. The score is derived from the segment's coords so
 * the same file always produces the same colours — callers get a stable
 * preview without a network round-trip.
 */

export type { ImportedRoute, ImportedWaypoint, ImportResult };

const MAX_PREVIEW_SEGMENTS = 20;
const MIN_SEGMENT_KM = 3;
const EARTH_RADIUS_KM = 6371;

export function parseImportedRoute(
  text: string,
  filename: string,
): ImportResult {
  return sharedParseImportedRoute(text, filename);
}

export function pointsDistanceKm(points: Array<[number, number]>): number {
  return sharedPointsDistanceKm(points);
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
    importSourceFormat: route.sourceFormat,
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

  // Only adopt an imported waypoint's name for start/end when it's actually
  // co-located with that endpoint — otherwise a mid-route "Viewpoint" placemark
  // would be labelled "Start" and also survive as a duplicate via below.
  const startMatch = route.waypoints.find((wp) =>
    samePoint({ lng: wp.lng, lat: wp.lat }, { lng: first[0], lat: first[1] }),
  );
  const endMatch = route.waypoints.find((wp) =>
    samePoint({ lng: wp.lng, lat: wp.lat }, { lng: last[0], lat: last[1] }),
  );

  const start: Waypoint = {
    id: "imp-wp-start",
    name: startMatch?.name ?? "Start",
    location: { lng: first[0], lat: first[1] },
    type: "start",
  };
  const end: Waypoint = {
    id: "imp-wp-end",
    name: endMatch?.name ?? "End",
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
  let chunkPoints: Array<[number, number]> = [route.points[0]];
  let chunkDistance = 0;
  let chunkIndex = 0;

  for (let i = 1; i < route.points.length; i++) {
    const step = haversineKm(route.points[i - 1], route.points[i]);
    chunkDistance += step;
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
