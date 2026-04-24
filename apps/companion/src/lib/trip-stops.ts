import type {
  AccommodationSuggestion,
  PoiKind,
  RoutePoiSuggestion,
} from "@/lib/api";
import { filterRoutingWaypoints } from "@/lib/trip-routing";
import type { Trip, TripDay, Waypoint } from "@/lib/types";

export type { AccommodationSuggestion, RoutePoiSuggestion, PoiKind };

export interface TripStopsOptions {
  poiKinds: PoiKind[];
  minAccommodationStars?: number;
}

export interface TripDayStops {
  dayNumber: number;
  title?: string;
  routeAvailable: boolean;
  endLabel: string | null;
  accommodations: AccommodationSuggestion[];
  pois: RoutePoiSuggestion[];
}

export interface TripStopsRequestDay {
  dayNumber: number;
  title: string | null;
  endAnchor: { lat: number; lng: number } | null;
  routePoints: Array<{ lat: number; lng: number }>;
}

export interface TripStopsRequestPlan {
  tripId: string;
  days: TripStopsRequestDay[];
}

export type StopSuggestion = AccommodationSuggestion | RoutePoiSuggestion;

function findLastMatching<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && predicate(item)) return item;
  }

  return undefined;
}

function routingWaypoints(
  waypoints: Pick<Waypoint, "type" | "location" | "name" | "id">[],
) {
  const filtered = filterRoutingWaypoints(waypoints);
  return filtered.length > 0 ? filtered : waypoints;
}

export function buildDayRoutePoints(
  day: Pick<TripDay, "routeGeometry" | "waypoints">,
): Array<{ lat: number; lng: number }> {
  const coords = day.routeGeometry?.coordinates;
  if (coords && coords.length >= 2) {
    return coords.map(([lng, lat]) => ({ lat, lng }));
  }

  const routeWaypoints = routingWaypoints(day.waypoints);
  if (routeWaypoints.length >= 2) {
    return routeWaypoints.map((waypoint) => waypoint.location);
  }

  return [];
}

export function buildDayEndAnchor(
  day: Pick<TripDay, "routeGeometry" | "waypoints">,
): { lat: number; lng: number } | null {
  const routeWaypoints = routingWaypoints(day.waypoints);
  const explicitEnd = findLastMatching(
    routeWaypoints,
    (waypoint) => waypoint.type === "end",
  );
  if (explicitEnd) return explicitEnd.location;

  const routePoints = buildDayRoutePoints(day);
  if (routePoints.length > 0)
    return routePoints[routePoints.length - 1] ?? null;
  return routeWaypoints[routeWaypoints.length - 1]?.location ?? null;
}

export function buildTripDayStops(
  trip: Trip,
  accommodationsByDay: Map<number, AccommodationSuggestion[]>,
  poisByDay: Map<number, RoutePoiSuggestion[]>,
): TripDayStops[] {
  return trip.days.map((day) => {
    const routeWaypoints = routingWaypoints(day.waypoints);
    const explicitEnd = findLastMatching(
      routeWaypoints,
      (waypoint) => waypoint.type === "end",
    );

    return {
      dayNumber: day.dayNumber,
      title: day.title,
      routeAvailable: buildDayRoutePoints(day).length >= 2,
      endLabel:
        explicitEnd?.name ??
        routeWaypoints[routeWaypoints.length - 1]?.name ??
        null,
      accommodations: accommodationsByDay.get(day.dayNumber) ?? [],
      pois: poisByDay.get(day.dayNumber) ?? [],
    };
  });
}

export function buildTripStopsRequestPlan(
  trip: Trip | null,
): TripStopsRequestPlan | null {
  if (!trip) return null;

  return {
    tripId: trip.id,
    days: trip.days.map((day) => ({
      dayNumber: day.dayNumber,
      title: day.title ?? null,
      endAnchor: buildDayEndAnchor(day),
      routePoints: buildDayRoutePoints(day),
    })),
  };
}

export function buildSuggestionWaypoint(suggestion: StopSuggestion): Waypoint {
  const type = waypointTypeForSuggestion(suggestion);
  return {
    id: suggestionWaypointId(suggestion),
    name: suggestion.name ?? fallbackStopName(suggestion),
    location: { lat: suggestion.lat, lng: suggestion.lng },
    type,
  };
}

export function isSuggestionWaypointAdded(
  day: Pick<TripDay, "waypoints">,
  suggestion: StopSuggestion,
): boolean {
  const id = suggestionWaypointId(suggestion);
  return day.waypoints.some((waypoint) => waypoint.id === id);
}

function suggestionWaypointId(suggestion: StopSuggestion): string {
  const scope = "stars" in suggestion ? "accommodation" : suggestion.kind;
  return `suggestion-${scope}-${suggestion.external_id}`;
}

function waypointTypeForSuggestion(
  suggestion: StopSuggestion,
): Waypoint["type"] {
  if ("stars" in suggestion) return "accommodation";

  switch (suggestion.kind) {
    case "fuel_station":
      return "fuel";
    case "viewpoint":
      return "photo";
    case "restaurant":
    case "cafe":
    default:
      return "rest";
  }
}

function fallbackStopName(suggestion: StopSuggestion): string {
  if ("stars" in suggestion) return "Suggested stay";

  switch (suggestion.kind) {
    case "fuel_station":
      return "Fuel stop";
    case "viewpoint":
      return "Viewpoint";
    case "restaurant":
      return "Restaurant stop";
    case "cafe":
      return "Cafe stop";
    default:
      return "Suggested stop";
  }
}
