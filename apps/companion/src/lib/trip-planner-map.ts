import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import { haversineKm } from "@tarmoto/shared";
import type { RoutePreviewSegment, Trip, TripDay } from "@/lib/types";

export type PlannerBbox = [number, number, number, number];

/**
 * Distinct, readable hex colors for each trip day's route line on the cream
 * basemap. Cycled via `(dayNumber - 1) % DAY_COLORS.length` so trips with
 * more than 7 days reuse the palette from the beginning.
 */
export const DAY_COLORS = [
  "#2563EB", // blue-600
  "#16A34A", // green-600
  "#DC2626", // red-600
  "#9333EA", // purple-600
  "#EA580C", // orange-600
  "#0891B2", // cyan-700
  "#CA8A04", // yellow-600
] as const;

type RouteProperties = {
  dayNumber: number;
  title: string;
  distanceKm: number;
  pointCount: number;
  color: string;
  selected: boolean;
};

type WaypointProperties = {
  dayNumber: number;
  waypointId: string;
  waypointType: string;
  label: string;
};

type SegmentHighlightProperties = {
  segmentId: string;
  dayNumber: number;
  orderInDay: number;
};

export function buildTripPlannerRouteCollection(
  trip: Trip | null,
  selectedDayNumber?: number,
  focusSelectedDay?: boolean,
): FeatureCollection<LineString, RouteProperties> {
  if (!trip) return emptyLineCollection();

  const features = trip.days
    .map((day) => {
      // When focusSelectedDay is active, skip every day except the selected one.
      if (focusSelectedDay && day.dayNumber !== selectedDayNumber) return null;

      const coordinates = getDayRouteCoordinates(day);
      if (coordinates.length < 2) return null;

      const color = DAY_COLORS[(day.dayNumber - 1) % DAY_COLORS.length]!;
      const selected =
        selectedDayNumber !== undefined
          ? day.dayNumber === selectedDayNumber
          : true;

      const feature: Feature<LineString, RouteProperties> = {
        type: "Feature",
        properties: {
          dayNumber: day.dayNumber,
          title: day.title ?? `Day ${day.dayNumber}`,
          distanceKm: day.distanceKm,
          pointCount: coordinates.length,
          color,
          selected,
        },
        geometry: {
          type: "LineString",
          coordinates,
        },
      };
      return feature;
    })
    .filter((feature): feature is Feature<LineString, RouteProperties> =>
      Boolean(feature),
    );

  return {
    type: "FeatureCollection",
    features,
  };
}

export function buildTripPlannerWaypointCollection(
  trip: Trip | null,
): FeatureCollection<Point, WaypointProperties> {
  if (!trip) return emptyPointCollection();

  const features = trip.days.flatMap((day) =>
    day.waypoints.map((waypoint) => {
      const feature: Feature<Point, WaypointProperties> = {
        type: "Feature",
        properties: {
          dayNumber: day.dayNumber,
          waypointId: waypoint.id,
          waypointType: waypoint.type,
          label: waypoint.name ?? fallbackWaypointLabel(waypoint.type),
        },
        geometry: {
          type: "Point",
          coordinates: [waypoint.location.lng, waypoint.location.lat],
        },
      };
      return feature;
    }),
  );

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
  if (!normalizedType) return "Waypoint";

  return normalizedType[0].toUpperCase() + normalizedType.slice(1);
}

function emptyLineCollection(): FeatureCollection<LineString, RouteProperties> {
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
