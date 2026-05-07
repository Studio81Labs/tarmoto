import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import type { RoutePreviewSegment, Trip, TripDay } from "@/lib/types";

export type PlannerBbox = [number, number, number, number];

type RouteProperties = {
  dayNumber: number;
  title: string;
  distanceKm: number;
  pointCount: number;
};

type WaypointProperties = {
  dayNumber: number;
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
): FeatureCollection<LineString, RouteProperties> {
  if (!trip) return emptyLineCollection();

  const features = trip.days
    .map((day) => {
      const coordinates = getDayRouteCoordinates(day);
      if (coordinates.length < 2) return null;
      const feature: Feature<LineString, RouteProperties> = {
        type: "Feature",
        properties: {
          dayNumber: day.dayNumber,
          title: day.title ?? `Day ${day.dayNumber}`,
          distanceKm: day.distanceKm,
          pointCount: coordinates.length,
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
 * Segments don't carry their own line geometry; they're built as
 * equal-distance chunks of the day's `routeGeometry` (see
 * `trip-planner-builder` and `gpx-kml-import`). We mirror that contract here
 * by slicing the day's polyline by `orderInDay` / segment count, which keeps
 * the highlight visually aligned with what the rider sees in the sidebar.
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

  const segmentCount = orderedSegments.length;
  const lastIndex = dayCoordinates.length - 1;
  const startFraction = segmentIndex / segmentCount;
  const endFraction = (segmentIndex + 1) / segmentCount;
  const startIdx = Math.max(0, Math.floor(startFraction * lastIndex));
  const endIdx = Math.min(lastIndex, Math.ceil(endFraction * lastIndex));
  if (endIdx <= startIdx) return [];

  return dayCoordinates.slice(startIdx, endIdx + 1);
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
