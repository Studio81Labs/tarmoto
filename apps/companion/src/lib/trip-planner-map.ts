import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import { haversineKm } from "@tarmoto/shared";
import type { ExpressionSpecification } from "@/lib/maplibre-expression";
import { deriveQualitySegments } from "@/lib/planner/derive";
import { QUALITY_BAND_COLORS } from "@/lib/planner/quality-bands";
import type { QualityBand, RouteSegment } from "@/lib/planner/types";
import type { RoutePreviewSegment, Trip, TripDay } from "@/lib/types";

export type PlannerBbox = [number, number, number, number];

/** How the planner's route line is colored (independent of the basemap). */
export type PlannerLineColorMode = "quality" | "surface";

/**
 * Per-segment properties on the planner's quality-segmented route line.
 * `band`/`surface` drive the data-driven `line-color` expressions;
 * `segmentId` is the click target for the Road Preview Card; `selected`
 * dims the non-selected days' lines.
 */
export type QualityRouteProperties = {
  segmentId: string;
  dayNumber: number;
  band: QualityBand;
  surface: string;
  score: number | null;
  passes: number;
  lengthKm: number;
  selected: boolean;
};

type WaypointProperties = {
  dayNumber: number;
  waypointId: string;
  waypointType: string;
  label: string;
  /** POI category for POI-derived waypoints (glyph-in-circle pins). */
  poiCategory?: string;
};

type SegmentHighlightProperties = {
  segmentId: string;
  dayNumber: number;
  orderInDay: number;
};

/**
 * Quality-segmented route line: one feature per derived quality segment so
 * each section is individually colorable and clickable. Replaces the old
 * per-day single-color line — day context now comes from the day list plus
 * dimming of non-selected days (`selected`).
 */
export function buildPlannerQualityRouteCollection(
  trip: Trip | null,
  selectedDayNumber?: number,
  focusSelectedDay?: boolean,
): FeatureCollection<LineString, QualityRouteProperties> {
  if (!trip) return emptyQualityLineCollection();

  const features: Feature<LineString, QualityRouteProperties>[] = [];
  for (const day of trip.days) {
    // When focusSelectedDay is active, skip every day except the selected one.
    if (focusSelectedDay && day.dayNumber !== selectedDayNumber) continue;
    const selected =
      selectedDayNumber !== undefined
        ? day.dayNumber === selectedDayNumber
        : true;

    for (const segment of deriveDayQualitySegments(day)) {
      features.push({
        type: "Feature",
        properties: {
          segmentId: segment.id,
          dayNumber: segment.dayNumber,
          band: segment.band,
          surface: segment.surface,
          score: segment.score,
          passes: segment.passes,
          lengthKm: segment.lengthKm,
          selected,
        },
        geometry: segment.geometry,
      });
    }
  }

  return {
    type: "FeatureCollection",
    features,
  };
}

/**
 * Quality segments for one trip day, derived on demand from whatever
 * geometry the day has (routed polyline, or the raw waypoint line while
 * routing is still pending). Deterministic, so callers may re-derive freely
 * — the map collection, the Inspect strip, and segment lookups always agree.
 */
export function deriveDayQualitySegments(day: TripDay): RouteSegment[] {
  const coordinates = getDayRouteCoordinates(day);
  if (coordinates.length < 2) return [];
  const points = coordinates.map(([lng, lat]) => ({ lat, lng }));
  // Per-leg routed days (revision 3 §C): derive each leg's stretch on its
  // own so every segment carries its legId — but only when the leg map
  // actually describes THIS geometry (it always comes from the same
  // applyRouteResult; the guard covers the waypoint-line fallback).
  const legBreaks = day.legBreaks;
  if (
    legBreaks &&
    legBreaks.length > 0 &&
    day.routeGeometry?.coordinates.length === coordinates.length &&
    legBreaks.every((b) => b.startVertex < points.length)
  ) {
    return legBreaks.flatMap((brk, index) => {
      const endVertex =
        index < legBreaks.length - 1
          ? legBreaks[index + 1]!.startVertex
          : points.length - 1;
      const legPoints = points.slice(brk.startVertex, endVertex + 1);
      if (legPoints.length < 2) return [];
      return deriveQualitySegments(legPoints, day.dayNumber, {
        index,
        id: brk.legId,
      });
    });
  }
  return deriveQualitySegments(points, day.dayNumber);
}

/** Locate a derived quality segment by id across all days of the trip. */
export function findPlannerQualitySegment(
  trip: Trip | null,
  segmentId: string | null,
): RouteSegment | null {
  if (!trip || !segmentId) return null;
  for (const day of trip.days) {
    const match = deriveDayQualitySegments(day).find(
      (segment) => segment.id === segmentId,
    );
    if (match) return match;
  }
  return null;
}

/** Bounding box of a single quality segment (for flyTo from the panel). */
export function plannerSegmentBounds(
  segment: RouteSegment,
): PlannerBbox | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const coordinate of segment.geometry.coordinates) {
    const [lng, lat] = coordinate;
    if (typeof lng !== "number" || typeof lat !== "number") continue;
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  if (!Number.isFinite(west) || !Number.isFinite(south)) return null;
  return [west, south, east, north];
}

/**
 * Data-driven `line-color` expression for the planner route line. Quality
 * mode colors by band; surface mode colors by surface type using the same
 * palette as the all-roads tile overlay (passed in by the map component so
 * the two can't drift apart).
 */
export function plannerRouteLineColor(
  mode: PlannerLineColorMode,
  surfaceColors: Record<string, string>,
): ExpressionSpecification {
  if (mode === "surface") {
    return [
      "match",
      ["get", "surface"],
      "asphalt",
      surfaceColors.asphalt ?? QUALITY_BAND_COLORS.no_data,
      "concrete",
      surfaceColors.concrete ?? QUALITY_BAND_COLORS.no_data,
      "cobblestone",
      surfaceColors.cobblestone ?? QUALITY_BAND_COLORS.no_data,
      "gravel",
      surfaceColors.gravel ?? QUALITY_BAND_COLORS.no_data,
      "dirt",
      surfaceColors.dirt ?? QUALITY_BAND_COLORS.no_data,
      surfaceColors.unknown ?? QUALITY_BAND_COLORS.no_data,
    ] as ExpressionSpecification;
  }
  return [
    "match",
    ["get", "band"],
    "good",
    QUALITY_BAND_COLORS.good,
    "fair",
    QUALITY_BAND_COLORS.fair,
    "rough",
    QUALITY_BAND_COLORS.rough,
    QUALITY_BAND_COLORS.no_data,
  ] as ExpressionSpecification;
}

/** Midpoint vertex of a segment (Street View link, popover anchoring). */
export function plannerSegmentMidpoint(
  segment: RouteSegment,
): { lng: number; lat: number } | null {
  const coordinates = segment.geometry.coordinates;
  const middle = coordinates[Math.floor(coordinates.length / 2)];
  const [lng, lat] = middle ?? [];
  if (typeof lng !== "number" || typeof lat !== "number") return null;
  return { lng, lat };
}

export function buildTripPlannerWaypointCollection(
  trip: Trip | null,
  selectedDayNumber?: number,
  focusSelectedDay?: boolean,
): FeatureCollection<Point, WaypointProperties> {
  if (!trip) return emptyPointCollection();

  const features = trip.days.flatMap((day) => {
    // In focus mode, emit markers only for the selected day — the marker layer
    // is also the drag source, so this prevents editing a hidden day while the
    // map is isolated to one day.
    if (focusSelectedDay && day.dayNumber !== selectedDayNumber) return [];
    return day.waypoints.flatMap((waypoint) => {
      // Suppress the linked start: the shared overnight stop is already drawn
      // as the previous day's end, so rendering it again here would overlap.
      // EXCEPT in focus mode — the predecessor day is filtered out above, so
      // its end isn't drawn; suppressing here too would leave the focused
      // linked leg with no start/overnight marker at all.
      if (waypoint.type === "start" && day.startLinked && !focusSelectedDay)
        return [];
      const feature: Feature<Point, WaypointProperties> = {
        type: "Feature",
        properties: {
          dayNumber: day.dayNumber,
          waypointId: waypoint.id,
          waypointType: waypoint.type,
          label: waypoint.name ?? fallbackWaypointLabel(waypoint.type),
          ...(waypoint.poiCategory
            ? { poiCategory: waypoint.poiCategory }
            : {}),
        },
        geometry: {
          type: "Point",
          coordinates: [waypoint.location.lng, waypoint.location.lat],
        },
      };
      return feature;
    });
  });

  return {
    type: "FeatureCollection",
    features,
  };
}

/**
 * Build a single-feature collection containing the geometry of the focused
 * segment so the map can render a highlight layer (issue #473). Returns an
 * empty collection when no segment is focused, the segment can't be located,
 * or the day has no geometry to slice.
 *
 * Segments don't carry their own line geometry; they're built as ordered,
 * equal-traveled-kilometer chunks of the day's `routeGeometry` (see
 * `gpx-kml-import`, which accumulates haversine distance until each chunk
 * hits its target). We mirror that
 * contract here by slicing the day's polyline along its cumulative
 * distance — using each segment's own `distanceKm` for the boundaries —
 * so the highlight stays aligned even when route vertices are unevenly
 * spaced (e.g., dense at junctions, sparse on long straights).
 */
export function buildTripPlannerSegmentHighlightCollection(
  trip: Trip | null,
  segmentId: string | null,
): FeatureCollection<LineString, SegmentHighlightProperties> {
  if (!trip || !segmentId) return emptySegmentHighlightCollection();

  for (const day of trip.days) {
    const segments = day.segments;
    if (!segments || segments.length === 0) continue;
    const segment = segments.find((entry) => entry.id === segmentId);
    if (!segment) continue;

    const coordinates = sliceDayCoordinatesForSegment(day, segment, segments);
    if (coordinates.length < 2) continue;

    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {
            segmentId: segment.id,
            dayNumber: segment.dayNumber,
            orderInDay: segment.orderInDay,
          },
          geometry: { type: "LineString", coordinates },
        },
      ],
    };
  }

  return emptySegmentHighlightCollection();
}

function sliceDayCoordinatesForSegment(
  day: TripDay,
  segment: RoutePreviewSegment,
  segments: RoutePreviewSegment[],
): [number, number][] {
  const dayCoordinates = getDayRouteCoordinates(day);
  if (dayCoordinates.length < 2) return [];

  // Sort segments deterministically by `orderInDay` so the highlight slice
  // matches the rider's visual ordering in the sidebar even if the array
  // arrived out of order.
  const orderedSegments = [...segments].sort(
    (a, b) => a.orderInDay - b.orderInDay,
  );
  const segmentIndex = orderedSegments.findIndex(
    (entry) => entry.id === segment.id,
  );
  if (segmentIndex < 0) return [];

  const cumLengthsKm: number[] = [0];
  for (let index = 1; index < dayCoordinates.length; index++) {
    const previous = dayCoordinates[index - 1]!;
    const current = dayCoordinates[index]!;
    cumLengthsKm.push(
      cumLengthsKm[index - 1]! +
        haversineKm(previous[1], previous[0], current[1], current[0]),
    );
  }
  const totalPolylineKm = cumLengthsKm[cumLengthsKm.length - 1]!;
  if (totalPolylineKm <= 0) return [];

  const segmentDistancesKm = orderedSegments.map((entry) =>
    Math.max(0, entry.distanceKm),
  );
  const totalSegmentKm = segmentDistancesKm.reduce(
    (sum, value) => sum + value,
    0,
  );

  let startFraction: number;
  let endFraction: number;
  if (totalSegmentKm > 0) {
    // Treat segment distances as proportions of the polyline so small
    // rounding drift between `segment.distanceKm` and the recomputed
    // haversine total doesn't push the highlight off the end.
    let cumStartKm = 0;
    for (let index = 0; index < segmentIndex; index++) {
      cumStartKm += segmentDistancesKm[index]!;
    }
    const cumEndKm = cumStartKm + segmentDistancesKm[segmentIndex]!;
    startFraction = clampUnit(cumStartKm / totalSegmentKm);
    endFraction = clampUnit(cumEndKm / totalSegmentKm);
  } else {
    // Fall back to even fractions if no segment carries a usable distance.
    startFraction = segmentIndex / orderedSegments.length;
    endFraction = (segmentIndex + 1) / orderedSegments.length;
  }

  const startKm = startFraction * totalPolylineKm;
  const endKm = endFraction * totalPolylineKm;
  return slicePolylineByDistance(dayCoordinates, cumLengthsKm, startKm, endKm);
}

function slicePolylineByDistance(
  coordinates: [number, number][],
  cumLengthsKm: number[],
  startKm: number,
  endKm: number,
): [number, number][] {
  if (endKm <= startKm) return [];
  const totalKm = cumLengthsKm[cumLengthsKm.length - 1]!;
  if (totalKm <= 0) return [];
  const clampedStart = Math.max(0, startKm);
  const clampedEnd = Math.min(totalKm, endKm);
  if (clampedEnd <= clampedStart) return [];

  const result: [number, number][] = [];
  result.push(pointAtDistance(coordinates, cumLengthsKm, clampedStart));
  for (let index = 0; index < cumLengthsKm.length; index++) {
    const km = cumLengthsKm[index]!;
    if (km > clampedStart && km < clampedEnd) result.push(coordinates[index]!);
  }
  result.push(pointAtDistance(coordinates, cumLengthsKm, clampedEnd));

  return dedupeAdjacentPoints(result);
}

function pointAtDistance(
  coordinates: [number, number][],
  cumLengthsKm: number[],
  targetKm: number,
): [number, number] {
  if (targetKm <= 0) return coordinates[0]!;
  const lastIndex = cumLengthsKm.length - 1;
  if (targetKm >= cumLengthsKm[lastIndex]!) return coordinates[lastIndex]!;

  for (let index = 1; index < cumLengthsKm.length; index++) {
    if (cumLengthsKm[index]! < targetKm) continue;
    const segmentLengthKm = cumLengthsKm[index]! - cumLengthsKm[index - 1]!;
    const t =
      segmentLengthKm > 0
        ? (targetKm - cumLengthsKm[index - 1]!) / segmentLengthKm
        : 0;
    const start = coordinates[index - 1]!;
    const end = coordinates[index]!;
    return [
      start[0] + (end[0] - start[0]) * t,
      start[1] + (end[1] - start[1]) * t,
    ];
  }
  return coordinates[lastIndex]!;
}

function dedupeAdjacentPoints(points: [number, number][]): [number, number][] {
  const result: [number, number][] = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (
      !previous ||
      Math.abs(previous[0] - point[0]) > 1e-9 ||
      Math.abs(previous[1] - point[1]) > 1e-9
    ) {
      result.push(point);
    }
  }
  return result;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function getTripPlannerBounds(trip: Trip | null): PlannerBbox | null {
  if (!trip) return null;

  const coordinates: [number, number][] = [];
  for (const day of trip.days) {
    coordinates.push(...getDayRouteCoordinates(day));
    for (const waypoint of day.waypoints) {
      coordinates.push([waypoint.location.lng, waypoint.location.lat]);
    }
  }

  if (coordinates.length === 0) return null;

  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lng, lat] of coordinates) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }

  return [west, south, east, north];
}

function emptySegmentHighlightCollection(): FeatureCollection<
  LineString,
  SegmentHighlightProperties
> {
  return {
    type: "FeatureCollection",
    features: [],
  };
}

function getDayRouteCoordinates(day: Trip["days"][number]): [number, number][] {
  if (day.routeGeometry?.coordinates.length) {
    const routeCoordinates = day.routeGeometry.coordinates
      .filter(
        (coordinate): coordinate is [number, number] =>
          Array.isArray(coordinate) &&
          coordinate.length >= 2 &&
          typeof coordinate[0] === "number" &&
          typeof coordinate[1] === "number",
      )
      .map(([lng, lat]): [number, number] => [lng, lat]);
    if (routeCoordinates.length >= 2) return routeCoordinates;
  }

  return day.waypoints.map((waypoint) => [
    waypoint.location.lng,
    waypoint.location.lat,
  ]);
}

function fallbackWaypointLabel(type: string): string {
  const normalizedType = type.trim();

  if (normalizedType === "start") return "Start";
  if (normalizedType === "end") return "Finish";
  const firstChar = normalizedType[0];
  if (!firstChar) return "Waypoint";

  return firstChar.toUpperCase() + normalizedType.slice(1);
}

function emptyQualityLineCollection(): FeatureCollection<
  LineString,
  QualityRouteProperties
> {
  return {
    type: "FeatureCollection",
    features: [],
  };
}

function emptyPointCollection(): FeatureCollection<Point, WaypointProperties> {
  return {
    type: "FeatureCollection",
    features: [],
  };
}
