import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import type { Trip } from "@/lib/types";

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
  if (type === "start") return "Start";
  if (type === "end") return "Finish";
  return type[0]?.toUpperCase() + type.slice(1);
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
