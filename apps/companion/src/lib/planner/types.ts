import type * as GeoJSON from "geojson";
import type { SurfaceType } from "@tarmoto/shared";
import type { RouteRequestBody, RouteResponse } from "@/lib/api";

/**
 * Plan & inspect planner contracts.
 *
 * The planner UI is built against these types and talks to data exclusively
 * through {@link PlannerApi}. Routing geometry/time/surface-mix are REAL
 * (backend Valhalla proxy); per-segment quality, rider-pass counts, and
 * street-level previews are MOCKED in `./mocks/` until the quality pipeline
 * serves them. Swapping mock → real is a change to `./api.ts` only.
 */

export type QualityBand = "good" | "fair" | "rough" | "no_data";

export interface RouteSegment {
  id: string;
  geometry: GeoJSON.LineString;
  band: QualityBand;
  surface: SurfaceType;
  /** 0–5 measured quality; null when the band is `no_data`. */
  score: number | null;
  /** Rider passes backing the score — drives the confidence treatment. */
  passes: number;
  lengthKm: number;
  /** Trip day the segment belongs to (1-based). */
  dayNumber: number;
}

export interface FlaggedSection {
  segmentId: string;
  kind: "rough" | "no_data";
  lengthKm: number;
  label: string;
}

export interface RouteQualitySummary {
  distanceKm: number;
  timeMin: number;
  /** Route-level 0–5 score; null when the backend has no quality data. */
  score: number | null;
  surfaceMix: { surface: SurfaceType; pct: number }[];
  flagged: FlaggedSection[];
}

export interface RoadPreview {
  segmentId: string;
  hasData: boolean;
  score?: number;
  band?: QualityBand;
  surface?: SurfaceType;
  passes?: number;
  /** Per-sub-segment mini graph rendered in the preview card. */
  microStrip?: QualityBand[];
  /** Street-level (Mapillary) image; absent until a key is wired. */
  imageUrl?: string;
  /** ISO month the street-level image was captured, e.g. "2024-09". */
  imageCapturedAt?: string;
  /** Raw OSM surface tag shown as unverified fallback, e.g. "asphalt". */
  osmSurfaceTag?: string;
}

export type PlannerPoiType =
  | "fuel"
  | "restaurant"
  | "cafe"
  | "viewpoint"
  | "stay";

export interface PlannerPoi {
  id: string;
  type: PlannerPoiType;
  name: string;
  lat: number;
  lng: number;
  distanceFromRouteKm?: number;
  kmAlongRoute?: number;
}

/** Planner trip split lifecycle (addendum): route is live, days are on demand. */
export type SplitState = "unsplit" | "split" | "stale";

export interface SplitOptions {
  dailyKmTarget: number;
  /** Explicit day-count override; null = auto (derived from dailyKmTarget). */
  forcedDays: number | null;
  /** Route-level ride time, distributed across days by distance share. */
  totalTimeMin?: number;
}

export interface DayPlan {
  dayNumber: number;
  /** Quality segments whose midpoint falls inside this day. */
  segmentIds: string[];
  distanceKm: number;
  timeMin: number;
  quality: RouteQualitySummary;
  startTown: string;
  endTown: string;
  /** True when no overnight town was near the target break distance. */
  noTownNearby?: boolean;
  suggestedStays: PlannerPoi[];
  /** Manual break override at this day's end — survives re-splits. */
  breakPinned?: boolean;
  /** Along-route km where this day ends; the last day ends at totalKm. */
  endKm: number;
}

export interface GeoResult {
  name: string;
  lat: number;
  lng: number;
}

export interface GeneratedPlannerRoute {
  /** The untouched backend routing response (geometry, stats). */
  raw: RouteResponse;
  segments: RouteSegment[];
  summary: RouteQualitySummary;
}

export interface PlannerApi {
  /**
   * Routes through the waypoints via the backend Valhalla proxy (REAL), then
   * joins per-segment quality from the quality source (MOCK for now,
   * deterministic on geometry so re-renders and reroutes are stable).
   */
  generateRoute(
    waypoints: ReadonlyArray<{ lat: number; lng: number }>,
    options: RouteRequestBody["options"],
    init?: { signal?: AbortSignal; dayNumber?: number },
  ): Promise<GeneratedPlannerRoute>;

  /** Road Preview Card payload for a clicked segment (MOCK). */
  getRoadPreview(segment: RouteSegment): Promise<RoadPreview>;

  /**
   * POIs for the STOPS tab pin layer + suggestion lists. Delegates to the
   * real `/poi/*` endpoints where they cover the type ("stay" → `/poi/accommodations`,
   * the rest → `/poi/along-route`).
   */
  getPois(
    route: ReadonlyArray<{ lat: number; lng: number }>,
    types: PlannerPoiType[],
    init?: { signal?: AbortSignal },
  ): Promise<PlannerPoi[]>;
}
