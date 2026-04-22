import type {
  AccommodationSuggestion,
  PoiKind,
  RoutePoiSuggestion,
} from "@/lib/api";
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

export type StopSuggestion = AccommodationSuggestion | RoutePoiSuggestion;

export function buildDayRoutePoints(
  day: Pick<TripDay, "routeGeometry" | "waypoints">,
): Array<{ lat: number; lng: number }> {
  const coords = day.routeGeometry?.coordinates;
  if (coords && coords.length >= 2) {
    return coords.map(([lng, lat]) => ({ lat, lng }));
  }

  if (day.waypoints.length >= 2) {
    return day.waypoints.map((waypoint) => waypoint.location);
  }

  return [];
}

export function buildDayEndAnchor(
  day: Pick<TripDay, "routeGeometry" | "waypoints">,
): { lat: number; lng: number } | null {
  const routePoints = buildDayRoutePoints(day);
  if (routePoints.length > 0)
    return routePoints[routePoints.length - 1] ?? null;
  return day.waypoints[day.waypoints.length - 1]?.location ?? null;
}

export function buildTripDayStops(
  trip: Trip,
  accommodationsByDay: Map<number, AccommodationSuggestion[]>,
  poisByDay: Map<number, RoutePoiSuggestion[]>,
): TripDayStops[] {
  return trip.days.map((day) => ({
    dayNumber: day.dayNumber,
    title: day.title,
    routeAvailable: buildDayRoutePoints(day).length >= 2,
    endLabel: day.waypoints[day.waypoints.length - 1]?.name ?? null,
    accommodations: accommodationsByDay.get(day.dayNumber) ?? [],
    pois: poisByDay.get(day.dayNumber) ?? [],
  }));
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

export function suggestionWaypointId(suggestion: StopSuggestion): string {
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
