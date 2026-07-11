/**
 * Reusable hazard pin layer for a MapLibre map: a clustered GeoJSON source with
 * teal cluster circles and per-hazard emoji-in-circle markers, faded by report
 * age. Extracted from the road explorer so every map surface can show hazards.
 * The caller owns the fetch/websocket merge and the click handlers; this module
 * owns the source, the layers, their visibility, and the feature projection.
 */

import type {
  GeoJSONSource,
  Map as MapLibreMap,
  MapGeoJSONFeature,
} from "maplibre-gl";
import type { ExpressionSpecification } from "@/lib/maplibre-expression";
import type { Feature, FeatureCollection, Point } from "geojson";
import { HAZARD_CONFIG, HAZARD_TYPES_UI, hazardFadeOpacity } from "@/lib/utils";
import type { HazardResponse } from "@/lib/api";
import { haversineMeters, type HazardType } from "@tarmoto/shared";

/** Below this zoom hazards are hidden — the viewport radius is too coarse. */
export const HAZARD_MIN_ZOOM = 9;
/** Debounce for the viewport hazard fetch. */
export const HAZARD_FETCH_DEBOUNCE_MS = 300;
const HAZARD_MAX_RADIUS_M = 50_000;
const HAZARD_MIN_RADIUS_M = 500;

/** Radius (m) covering the current viewport for `hazardsApi.findNearby`. */
export function viewportRadiusMeters(map: MapLibreMap): number {
  const bounds = map.getBounds();
  const center = map.getCenter();
  const ne = bounds.getNorthEast();
  const sw = bounds.getSouthWest();
  const diagonal = Math.max(
    haversineMeters(center.lat, center.lng, ne.lat, ne.lng),
    haversineMeters(center.lat, center.lng, sw.lat, sw.lng),
  );
  return Math.max(
    HAZARD_MIN_RADIUS_M,
    Math.min(HAZARD_MAX_RADIUS_M, Math.round(diagonal)),
  );
}

export const HAZARDS_SOURCE = "hazards-src";
export const HAZARD_CLUSTERS = "tarmoto-hazard-clusters";
export const HAZARD_CLUSTER_COUNT = "tarmoto-hazard-cluster-count";
export const HAZARD_BG = "tarmoto-hazard-bg";
export const HAZARD_ICON = "tarmoto-hazard-icon";

/** All hazard layer ids, e.g. for hover cursors or blocking hit-tests. */
export const HAZARD_LAYERS = [HAZARD_CLUSTERS, HAZARD_BG, HAZARD_ICON] as const;

/**
 * GeoJSON feature-properties bag for a hazard marker. The passthrough wire
 * fields are derived from the generated `HazardResponse` (a backend rename
 * breaks here at typecheck time); `hazard_type` is the normalised shared enum,
 * and `emoji` / `opacity` are computed client-side for the map paint.
 */
export type HazardProps = Pick<
  HazardResponse,
  | "id"
  | "note"
  | "photo_url"
  | "confirmations"
  | "reporter"
  | "road_name"
  | "created_at"
  | "expires_at"
> & {
  hazard_type: HazardType;
  severity: string;
  emoji: string;
  opacity: number;
};

const EMPTY_COLLECTION: FeatureCollection<Point, HazardProps> = {
  type: "FeatureCollection",
  features: [],
};

function buildHazardColorExpression(): ExpressionSpecification {
  const pairs = HAZARD_TYPES_UI.flatMap((type) => [
    type,
    HAZARD_CONFIG[type].hex,
  ]);
  return [
    "match",
    ["get", "hazard_type"],
    ...pairs,
    HAZARD_CONFIG.other.hex,
  ] as unknown as ExpressionSpecification;
}

export function normalizeHazardType(raw: string): HazardType {
  return HAZARD_CONFIG[raw as HazardType] ? (raw as HazardType) : "other";
}

/** Filter raw hazards to the active type set (all → passthrough, none → empty). */
export function selectHazards(
  raw: HazardResponse[],
  types: Set<HazardType>,
): HazardResponse[] {
  if (types.size === HAZARD_TYPES_UI.length) return raw;
  if (types.size === 0) return [];
  return raw.filter((h) => types.has(normalizeHazardType(h.hazard_type)));
}

/** Project hazards into the source's feature collection (age-fade computed). */
export function hazardsToFeatureCollection(
  hazards: HazardResponse[],
  now: number,
): FeatureCollection<Point, HazardProps> {
  const features: Feature<Point, HazardProps>[] = hazards.map((h) => {
    const type = normalizeHazardType(h.hazard_type);
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [h.lng, h.lat] },
      properties: {
        id: h.id,
        hazard_type: type,
        severity: h.severity,
        note: h.note,
        photo_url: h.photo_url ?? null,
        confirmations: h.confirmations,
        reporter: h.reporter,
        road_name: h.road_name,
        created_at: h.created_at,
        expires_at: h.expires_at,
        emoji: HAZARD_CONFIG[type].emoji,
        opacity: hazardFadeOpacity(h.created_at, h.expires_at, now),
      },
    };
  });
  return { type: "FeatureCollection", features };
}

/**
 * Register the clustered hazard source + cluster/marker layers (once).
 * `beforeId` slots them under a given layer (e.g. route pins on the planner);
 * omit it on maps with no higher-priority markers so hazards sit on top.
 */
export function ensureHazardLayers(
  map: MapLibreMap,
  { visible, beforeId }: { visible: boolean; beforeId?: string },
): void {
  const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  if (!map.getSource(HAZARDS_SOURCE)) {
    map.addSource(HAZARDS_SOURCE, {
      type: "geojson",
      data: EMPTY_COLLECTION,
      cluster: true,
      clusterRadius: 50,
      clusterMaxZoom: 13,
    });
  }
  const visibility = visible ? "visible" : "none";
  if (!map.getLayer(HAZARD_CLUSTERS)) {
    map.addLayer(
      {
        id: HAZARD_CLUSTERS,
        type: "circle",
        source: HAZARDS_SOURCE,
        filter: ["has", "point_count"],
        layout: { visibility },
        paint: {
          "circle-color": "#0ED3CF",
          "circle-opacity": 0.85,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
          "circle-radius": [
            "step",
            ["get", "point_count"],
            14,
            10,
            18,
            25,
            24,
          ] as ExpressionSpecification,
        },
      },
      before,
    );
  }
  if (!map.getLayer(HAZARD_CLUSTER_COUNT)) {
    map.addLayer(
      {
        id: HAZARD_CLUSTER_COUNT,
        type: "symbol",
        source: HAZARDS_SOURCE,
        filter: ["has", "point_count"],
        layout: {
          visibility,
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 12,
          "text-font": [
            "Noto Sans Bold",
            "Open Sans Bold",
            "Arial Unicode MS Bold",
          ],
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#0f172a" },
      },
      before,
    );
  }
  if (!map.getLayer(HAZARD_BG)) {
    map.addLayer(
      {
        id: HAZARD_BG,
        type: "circle",
        source: HAZARDS_SOURCE,
        filter: ["!", ["has", "point_count"]],
        layout: { visibility },
        paint: {
          "circle-color": buildHazardColorExpression(),
          "circle-opacity": ["coalesce", ["get", "opacity"], 1],
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            9,
            10,
            14,
            14,
            18,
            18,
          ] as ExpressionSpecification,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
          "circle-stroke-opacity": ["coalesce", ["get", "opacity"], 1],
        },
      },
      before,
    );
  }
  if (!map.getLayer(HAZARD_ICON)) {
    map.addLayer(
      {
        id: HAZARD_ICON,
        type: "symbol",
        source: HAZARDS_SOURCE,
        filter: ["!", ["has", "point_count"]],
        layout: {
          visibility,
          "text-field": ["get", "emoji"],
          "text-size": 16,
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: { "text-opacity": ["coalesce", ["get", "opacity"], 1] },
      },
      before,
    );
  }
}

/** Toggle every hazard layer's visibility. */
export function setHazardLayersVisible(
  map: MapLibreMap,
  visible: boolean,
): void {
  for (const id of [
    HAZARD_CLUSTERS,
    HAZARD_CLUSTER_COUNT,
    HAZARD_BG,
    HAZARD_ICON,
  ]) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  }
}

/** Replace the hazard source features (no-op if the source isn't ready). */
export function setHazardSourceData(
  map: MapLibreMap,
  hazards: HazardResponse[],
  now: number,
): void {
  const src = map.getSource(HAZARDS_SOURCE) as GeoJSONSource | undefined;
  src?.setData(hazardsToFeatureCollection(hazards, now));
}

/** Zoom a hazard cluster open, given the clicked cluster feature. */
export function expandHazardCluster(
  map: MapLibreMap,
  feature: MapGeoJSONFeature,
): void {
  const clusterId = feature.properties?.cluster_id as number | undefined;
  const src = map.getSource(HAZARDS_SOURCE) as GeoJSONSource | undefined;
  if (clusterId == null || !src) return;
  src
    .getClusterExpansionZoom(clusterId)
    .then((expZoom) => {
      if (feature.geometry.type !== "Point") return;
      map.easeTo({
        center: feature.geometry.coordinates as [number, number],
        zoom: expZoom,
      });
    })
    .catch(() => {
      // Cluster may have been superseded by a refetch; drop the zoom-in.
    });
}
