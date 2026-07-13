/**
 * Reusable "My rides" route overlay for a MapLibre map: the signed-in rider's
 * finished rides drawn as indigo route lines from `/rides/tracks`. The caller
 * owns the fetch and the click handler (open the ride drawer); this module owns
 * the source, the line layer, its visibility, and the feature projection.
 * Mirrors TripRouteLayer.
 */

import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { ExpressionSpecification } from "@/lib/maplibre-expression";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { components } from "@tarmoto/openapi-client";

/** One ride's id + its route geometry, from `GET /api/v1/rides/tracks`. */
export type RideTrack = components["schemas"]["RideTrackDto"];

export const RIDE_ROUTE_SOURCE = "explorer-ride-routes";
export const RIDE_ROUTE_LAYER = "explorer-ride-routes";

/** Indigo — distinct from the coral trips + the green/amber/red quality lines. */
export const RIDE_ROUTE_COLOR = "#4F46E5";

interface RideRouteProps {
  rideId: string;
}

const EMPTY: FeatureCollection<Geometry, RideRouteProps> = {
  type: "FeatureCollection",
  features: [],
};

/**
 * Project ride tracks into route features. Each track's `geometry` is already a
 * GeoJSON geometry (Line/MultiLineString) from the backend; wrap it in a
 * feature carrying the ride id so a click resolves it. Tracks with no geometry
 * (never routed) are skipped.
 */
export function rideTracksToRouteCollection(
  tracks: readonly RideTrack[],
): FeatureCollection<Geometry, RideRouteProps> {
  const features: Feature<Geometry, RideRouteProps>[] = [];
  for (const track of tracks) {
    if (!track.geometry) continue;
    features.push({
      type: "Feature",
      geometry: track.geometry as unknown as Geometry,
      properties: { rideId: track.id },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * Register the ride-route source + line layer (once). `beforeId` slots the line
 * UNDER the point markers so a marker on a route still owns the click.
 */
export function ensureRideRouteLayers(
  map: MapLibreMap,
  { visible, beforeId }: { visible: boolean; beforeId?: string },
): void {
  if (!map.getSource(RIDE_ROUTE_SOURCE)) {
    map.addSource(RIDE_ROUTE_SOURCE, { type: "geojson", data: EMPTY });
  }
  if (!map.getLayer(RIDE_ROUTE_LAYER)) {
    const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
    map.addLayer(
      {
        id: RIDE_ROUTE_LAYER,
        type: "line",
        source: RIDE_ROUTE_SOURCE,
        layout: {
          visibility: visible ? "visible" : "none",
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": RIDE_ROUTE_COLOR,
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
          "line-opacity": 0.85,
        },
      },
      before,
    );
  }
}

/** Replace the ride-route features (no-op if the source isn't ready). */
export function setRideRouteSourceData(
  map: MapLibreMap,
  tracks: readonly RideTrack[],
): void {
  const src = map.getSource(RIDE_ROUTE_SOURCE) as GeoJSONSource | undefined;
  src?.setData(rideTracksToRouteCollection(tracks));
}

/** Toggle the ride-route layer's visibility. */
export function setRideRouteLayersVisible(
  map: MapLibreMap,
  visible: boolean,
): void {
  if (map.getLayer(RIDE_ROUTE_LAYER)) {
    map.setLayoutProperty(
      RIDE_ROUTE_LAYER,
      "visibility",
      visible ? "visible" : "none",
    );
  }
}
