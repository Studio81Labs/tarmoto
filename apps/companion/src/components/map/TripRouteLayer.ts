/**
 * Reusable "My trips" route overlay for a MapLibre map: the signed-in rider's
 * planned trips drawn as coral route lines from each trip's per-day overview
 * geometry. The caller owns the fetch (`useUserTrips`) and the click handler
 * (open the trip drawer); this module owns the source, the line layer, its
 * visibility, and the feature projection. Mirrors PoiPinLayer/HazardPinLayer.
 */

import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { ExpressionSpecification } from "@/lib/maplibre-expression";
import type { Feature, FeatureCollection, LineString } from "geojson";
import type { TripSummary } from "@/lib/types";

export const TRIP_ROUTE_SOURCE = "explorer-trip-routes";
export const TRIP_ROUTE_LAYER = "explorer-trip-routes";

/** Coral — trips are the rider's plans (the brand accent). */
export const TRIP_ROUTE_COLOR = "#FF6A1A";

interface TripRouteProps {
  tripId: string;
  name: string;
}

const EMPTY: FeatureCollection<LineString, TripRouteProps> = {
  type: "FeatureCollection",
  features: [],
};

/**
 * Project trips into route LineStrings — one feature per day polyline (a trip
 * spans multiple days), each carrying the trip id so a click resolves it.
 * `overviewGeometry` is already `[lng, lat]`, so it drops straight in.
 */
export function tripsToRouteCollection(
  trips: readonly TripSummary[],
): FeatureCollection<LineString, TripRouteProps> {
  const features: Feature<LineString, TripRouteProps>[] = [];
  for (const trip of trips) {
    for (const day of trip.overviewGeometry ?? []) {
      if (day.length < 2) continue;
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: day.map((point) => [point[0]!, point[1]!]),
        },
        properties: { tripId: trip.id, name: trip.name },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

/**
 * Register the trip-route source + line layer (once). `beforeId` slots the line
 * UNDER the point markers (hazards/conditions/POIs) so a marker on a route still
 * owns the click, while the line stays above the road-quality tiles.
 */
export function ensureTripRouteLayers(
  map: MapLibreMap,
  { visible, beforeId }: { visible: boolean; beforeId?: string },
): void {
  if (!map.getSource(TRIP_ROUTE_SOURCE)) {
    map.addSource(TRIP_ROUTE_SOURCE, { type: "geojson", data: EMPTY });
  }
  if (!map.getLayer(TRIP_ROUTE_LAYER)) {
    const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
    map.addLayer(
      {
        id: TRIP_ROUTE_LAYER,
        type: "line",
        source: TRIP_ROUTE_SOURCE,
        layout: {
          visibility: visible ? "visible" : "none",
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": TRIP_ROUTE_COLOR,
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            8,
            3,
            12,
            5,
            16,
            7,
          ] as ExpressionSpecification,
          "line-opacity": 0.9,
        },
      },
      before,
    );
  }
}

/** Replace the trip-route features (no-op if the source isn't ready). */
export function setTripRouteSourceData(
  map: MapLibreMap,
  trips: readonly TripSummary[],
): void {
  const src = map.getSource(TRIP_ROUTE_SOURCE) as GeoJSONSource | undefined;
  src?.setData(tripsToRouteCollection(trips));
}

/** Toggle the trip-route layer's visibility. */
export function setTripRouteLayersVisible(
  map: MapLibreMap,
  visible: boolean,
): void {
  if (map.getLayer(TRIP_ROUTE_LAYER)) {
    map.setLayoutProperty(
      TRIP_ROUTE_LAYER,
      "visibility",
      visible ? "visible" : "none",
    );
  }
}
