import { haversineKm, SURFACE_TYPES, type SurfaceType } from "@tarmoto/shared";
import {
  poiApi,
  routingApi,
  type AccommodationSuggestion,
  type PoiKind,
  type RouteRequestBody,
  type RouteResponse,
  type RoutePoiSuggestion,
} from "@/lib/api";
import { sampleRoutePoints } from "@/lib/route-sampling";
import { deriveQualitySegments } from "./derive";
import { mockRoadPreview } from "./mocks";
import type {
  FlaggedSection,
  GeneratedPlannerRoute,
  PlannerApi,
  PlannerPoi,
  PlannerPoiType,
  RoadPreview,
  RouteQualitySummary,
  RouteSegment,
} from "./types";
import { QUALITY_BAND_LABELS_SHORT } from "./quality-bands";

/**
 * The planner's single data seam. Real sources: backend Valhalla routing
 * (`routingApi`) and the `/poi/*` endpoints. Mock sources (see `./mocks/`):
 * per-segment quality join and road previews. Swapping a mock for its real
 * source only ever touches this file.
 */

const SURFACE_TYPE_SET: ReadonlySet<string> = new Set(SURFACE_TYPES);

function asSurfaceType(key: string): SurfaceType {
  return SURFACE_TYPE_SET.has(key) ? (key as SurfaceType) : "unknown";
}

/** `surface_mix` arrives as metres per surface; render as whole-number %. */
export function surfaceMixToPercents(
  surfaceMixMetres: Record<string, number>,
): RouteQualitySummary["surfaceMix"] {
  const metresBySurface = new Map<SurfaceType, number>();
  let total = 0;
  for (const [key, metres] of Object.entries(surfaceMixMetres)) {
    if (!(metres > 0)) continue;
    const surface = asSurfaceType(key);
    metresBySurface.set(surface, (metresBySurface.get(surface) ?? 0) + metres);
    total += metres;
  }
  if (total === 0) return [];
  return [...metresBySurface.entries()]
    .map(([surface, metres]) => ({
      surface,
      pct: Math.round((metres / total) * 100),
    }))
    .sort((a, b) => b.pct - a.pct);
}

export function deriveFlaggedSections(
  segments: readonly RouteSegment[],
): FlaggedSection[] {
  const flagged: FlaggedSection[] = [];
  for (const segment of segments) {
    const lengthKm = Math.round(segment.lengthKm * 10) / 10;
    if (segment.band === "rough") {
      flagged.push({
        segmentId: segment.id,
        kind: "rough",
        lengthKm,
        label: `${QUALITY_BAND_LABELS_SHORT.rough} · ${segment.surface}, ${lengthKm} km`,
      });
    } else if (segment.band === "no_data") {
      flagged.push({
        segmentId: segment.id,
        kind: "no_data",
        lengthKm,
        label: `No data yet · ${lengthKm} km`,
      });
    }
  }
  return flagged;
}

export function buildRouteQualitySummary(
  raw: RouteResponse,
  segments: readonly RouteSegment[],
): RouteQualitySummary {
  return {
    distanceKm: raw.distance_km,
    timeMin: raw.duration_min,
    score: raw.avg_quality,
    surfaceMix: surfaceMixToPercents(raw.surface_mix),
    flagged: deriveFlaggedSections(segments),
  };
}

const ALONG_ROUTE_KIND_BY_TYPE: Partial<Record<PlannerPoiType, PoiKind>> = {
  fuel: "fuel_station",
  restaurant: "restaurant",
  cafe: "cafe",
  viewpoint: "viewpoint",
};

const TYPE_BY_ALONG_ROUTE_KIND: Record<PoiKind, PlannerPoiType> = {
  fuel_station: "fuel",
  restaurant: "restaurant",
  cafe: "cafe",
  viewpoint: "viewpoint",
};

function alongRoutePoiToPlannerPoi(poi: RoutePoiSuggestion): PlannerPoi {
  return {
    id: poi.external_id,
    type: TYPE_BY_ALONG_ROUTE_KIND[poi.kind],
    name: poi.name ?? "Unnamed",
    lat: poi.lat,
    lng: poi.lng,
    distanceFromRouteKm: poi.distance_from_route_km,
    kmAlongRoute: poi.distance_along_route_km,
  };
}

function accommodationToPlannerPoi(stay: AccommodationSuggestion): PlannerPoi {
  return {
    id: stay.external_id,
    type: "stay",
    name: stay.name ?? "Unnamed",
    lat: stay.lat,
    lng: stay.lng,
    distanceFromRouteKm: stay.distance_km,
  };
}

async function fetchPois(
  route: ReadonlyArray<{ lat: number; lng: number }>,
  types: PlannerPoiType[],
  init?: { signal?: AbortSignal },
): Promise<PlannerPoi[]> {
  if (route.length === 0 || types.length === 0) return [];

  const alongRouteKinds = types
    .map((type) => ALONG_ROUTE_KIND_BY_TYPE[type])
    .filter((kind): kind is PoiKind => kind !== undefined);
  const finish = route[route.length - 1];

  const [alongRoute, stays] = await Promise.all([
    alongRouteKinds.length > 0
      ? poiApi.getAlongRoute(
          // Downsampled — the check buffers by km and dense polylines
          // can exceed the backend's JSON body limit.
          { route: [...sampleRoutePoints(route)], kinds: alongRouteKinds },
          init,
        )
      : Promise.resolve(null),
    types.includes("stay") && finish
      ? poiApi.getAccommodations({ lat: finish.lat, lng: finish.lng }, init)
      : Promise.resolve(null),
  ]);

  return [
    ...(alongRoute?.data.pois.map(alongRoutePoiToPlannerPoi) ?? []),
    ...(stays?.data.accommodations.map(accommodationToPlannerPoi) ?? []),
  ];
}

/**
 * Overnight-town candidates for day-break snapping: one small
 * accommodations query around each raw break target (real /poi endpoint).
 * A failed query just yields no candidates for that break — the splitter
 * falls back to the raw distance there.
 */
export async function fetchOvernightTowns(
  coordinates: ReadonlyArray<ReadonlyArray<number>>,
  targetKms: readonly number[],
  init?: { signal?: AbortSignal },
): Promise<PlannerPoi[]> {
  if (coordinates.length < 2 || targetKms.length === 0) return [];
  // Cumulative km per vertex to locate each target's coordinate.
  const kms: number[] = [0];
  for (let i = 1; i < coordinates.length; i += 1) {
    const [lng1, lat1] = coordinates[i - 1] ?? [];
    const [lng2, lat2] = coordinates[i] ?? [];
    const step =
      typeof lng1 === "number" &&
      typeof lat1 === "number" &&
      typeof lng2 === "number" &&
      typeof lat2 === "number"
        ? haversineKm(lat1, lng1, lat2, lng2)
        : 0;
    kms.push((kms[i - 1] ?? 0) + step);
  }
  const anchors = targetKms.map((target) => {
    let best = 0;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let i = 0; i < kms.length; i += 1) {
      const delta = Math.abs((kms[i] ?? 0) - target);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i;
      }
    }
    const [lng, lat] = coordinates[best] ?? [];
    return typeof lng === "number" && typeof lat === "number"
      ? { lat, lng }
      : null;
  });

  const results = await Promise.allSettled(
    anchors.map((anchor) =>
      anchor
        ? poiApi.getAccommodations(
            { lat: anchor.lat, lng: anchor.lng, radius_km: 25 },
            init,
          )
        : Promise.reject(new Error("no anchor")),
    ),
  );
  const towns = new Map<string, PlannerPoi>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const stay of result.value.data.accommodations) {
      const poi = accommodationToPlannerPoi(stay);
      towns.set(poi.id, poi);
    }
  }
  return [...towns.values()];
}

export function createPlannerApi(): PlannerApi {
  return {
    async generateRoute(
      waypoints: ReadonlyArray<{ lat: number; lng: number }>,
      options: RouteRequestBody["options"],
      init?: { signal?: AbortSignal; dayNumber?: number },
    ): Promise<GeneratedPlannerRoute> {
      const { data: raw } = await routingApi.route(
        {
          waypoints: [...waypoints],
          ...(options !== undefined ? { options } : {}),
        },
        init?.signal !== undefined ? { signal: init.signal } : {},
      );
      const segments = deriveQualitySegments(
        raw.geometry,
        init?.dayNumber ?? 1,
      );
      return {
        raw,
        segments,
        summary: buildRouteQualitySummary(raw, segments),
      };
    },

    getRoadPreview(segment: RouteSegment): Promise<RoadPreview> {
      return Promise.resolve(mockRoadPreview(segment));
    },

    getPois(
      route: ReadonlyArray<{ lat: number; lng: number }>,
      types: PlannerPoiType[],
      init?: { signal?: AbortSignal },
    ): Promise<PlannerPoi[]> {
      return fetchPois(route, types, init);
    },
  };
}

export const plannerApi: PlannerApi = createPlannerApi();
