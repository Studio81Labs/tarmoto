import type { LatLng, Trip, Waypoint } from "@/types";
import type { NavigateParams } from "@/navigation/RootNavigator";
import { t as translate } from "@/i18n";
import { getFormatters } from "@/format";

export interface ResolvedNavigationRoute {
  polyline: LatLng[];
  title: string;
  waypoints: Waypoint[];
}

/**
 * Normalise the polymorphic `Navigate` params into the polyline-shaped
 * inputs the rest of NavigationScreen consumes. Trip-day callers carry
 * only IDs and rely on `useTripStore` for the geometry; polyline callers
 * pass everything inline. When the trip-day lookup misses (no active
 * trip in the store, or the trip ID has rotated) we still return a
 * well-formed object so the screen falls through to its empty state.
 */
export function resolveNavigationRoute(
  params: NavigateParams,
  activeTrip: Trip | null,
): ResolvedNavigationRoute {
  if (params.source === "polyline") {
    return {
      polyline: params.polyline,
      // Default the vehicle-display title to a neutral "Navigation" so
      // the CarPlay / Android Auto card has something readable when the
      // commute caller doesn't have a labelled route in hand.
      title: params.title ?? translate("Navigation"),
      waypoints: params.waypoints ?? [],
    };
  }
  const day =
    activeTrip && activeTrip.id === params.tripId
      ? (activeTrip.days.find((d) => d.day_number === params.dayNumber) ?? null)
      : null;
  return {
    polyline: day?.route_geometry ?? [],
    title:
      day?.title ?? translate("Day {value0}", { value0: params.dayNumber }),
    waypoints: day?.waypoints ?? [],
  };
}

/** Format a horizontal navigation distance supplied in meters. */
export function formatNavigationDistanceM(meters: number): string {
  return getFormatters().distanceM(Math.max(0, meters));
}
