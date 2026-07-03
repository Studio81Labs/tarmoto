import type * as GeoJSON from "geojson";
import { haversineKm } from "@tarmoto/shared";

/**
 * Splits a routed polyline into contiguous display segments for the
 * quality-colored route line. Pure geometry — the quality join happens in
 * the planner API layer, so the split must be deterministic for a given
 * input polyline.
 */

export interface SegmentSlice {
  id: string;
  geometry: GeoJSON.LineString;
  lengthKm: number;
  dayNumber: number;
}

/** Aim for roughly this many km per display segment. */
const TARGET_SEGMENT_KM = 12;
const MIN_SEGMENTS = 2;
const MAX_SEGMENTS = 12;

export function polylineLengthKm(
  points: ReadonlyArray<{ lat: number; lng: number }>,
): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) total += haversineKm(a.lat, a.lng, b.lat, b.lng);
  }
  return total;
}

export function segmentCountForDistance(distanceKm: number): number {
  if (distanceKm <= 0) return MIN_SEGMENTS;
  return Math.min(
    MAX_SEGMENTS,
    Math.max(MIN_SEGMENTS, Math.round(distanceKm / TARGET_SEGMENT_KM)),
  );
}

/**
 * Splits `points` (backend routing geometry, lat/lng order) into contiguous
 * slices of roughly equal length. Cuts land on existing vertices — no
 * interpolation — and adjacent slices share their boundary vertex so the
 * rendered line stays gap-free.
 */
export function segmentizeRoute(
  points: ReadonlyArray<{ lat: number; lng: number }>,
  dayNumber: number,
): SegmentSlice[] {
  if (points.length < 2) return [];

  const stepKm: number[] = [0];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const prev = stepKm[i - 1] ?? 0;
    stepKm.push(prev + (a && b ? haversineKm(a.lat, a.lng, b.lat, b.lng) : 0));
  }
  const totalKm = stepKm[stepKm.length - 1] ?? 0;
  if (totalKm === 0) {
    return [
      {
        id: segmentId(dayNumber, 0),
        geometry: toLineString(points),
        lengthKm: 0,
        dayNumber,
      },
    ];
  }

  const count = Math.min(
    segmentCountForDistance(totalKm),
    // A slice needs its own edge, so never ask for more slices than edges.
    points.length - 1,
  );

  const slices: SegmentSlice[] = [];
  let startIdx = 0;
  for (let seg = 0; seg < count; seg += 1) {
    const targetKm = (totalKm * (seg + 1)) / count;
    let endIdx =
      seg === count - 1 ? points.length - 1 : nearestVertex(stepKm, targetKm);
    // Keep at least one edge in this slice and leave one per remaining slice.
    endIdx = Math.max(endIdx, startIdx + 1);
    endIdx = Math.min(endIdx, points.length - 1 - (count - 1 - seg));

    const slicePoints = points.slice(startIdx, endIdx + 1);
    slices.push({
      id: segmentId(dayNumber, seg),
      geometry: toLineString(slicePoints),
      lengthKm: (stepKm[endIdx] ?? 0) - (stepKm[startIdx] ?? 0),
      dayNumber,
    });
    startIdx = endIdx;
  }
  return slices;
}

function segmentId(dayNumber: number, index: number): string {
  return `d${dayNumber}-s${index}`;
}

function toLineString(
  points: ReadonlyArray<{ lat: number; lng: number }>,
): GeoJSON.LineString {
  return {
    type: "LineString",
    coordinates: points.map((p) => [p.lng, p.lat]),
  };
}

function nearestVertex(stepKm: readonly number[], targetKm: number): number {
  let best = 0;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let i = 0; i < stepKm.length; i += 1) {
    const delta = Math.abs((stepKm[i] ?? 0) - targetKm);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = i;
    }
  }
  return best;
}
