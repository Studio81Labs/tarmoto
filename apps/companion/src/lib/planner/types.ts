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
  /**
   * Leg this segment belongs to when the day was routed per leg
   * (revision 3 §C) — associates map segments with their leg control.
   */
  legId?: string;
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

/**
 * Did the rider opt into day-planning? A route is a complete product on
 * its own (revision 2 §A) — 'multiday' is entered only via the explicit
 * "Plan as multi-day trip" section, never implied.
 */
export type PlanningMode = "single" | "multiday";

/**
 * Day-split lifecycle — only meaningful while planningMode is 'multiday'.
 * 'none' = never split (no day concept anywhere); 'split' = dayPlans
 * current; 'stale' = route/prefs changed since the last split.
 */
export type SplitStatus = "none" | "split" | "stale";

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

  /** Typed waypoint search in the panel (MOCK — corridor-city fixtures). */
  geocode(query: string): Promise<GeoResult[]>;

  /** Name a map-placed pin from its coordinate (MOCK — nearest fixture). */
  reverseGeocode(lat: number, lng: number): Promise<string>;

  /**
   * Start+finish drafting (revision 2 §E cases 2/3): measures the direct
   * route (REAL routing), then either inflates a short hop toward the
   * daily-km sizing target by threading Fun-Zone vias, or leaves a
   * full-day route natural with at most light corridor flavor. Produces
   * geometry only — never days. The start-only roundtrip (case 1) is NOT
   * served here: it goes through the REAL backend trip generator
   * (`POST /trips/:id/generate`), which sizes the loop from the same
   * daily-km value.
   */
  draftRoute(
    start: { lat: number; lng: number },
    finish: { lat: number; lng: number },
    opts: DraftOptions,
    init?: { signal?: AbortSignal },
  ): Promise<DraftRouteResult>;

  /**
   * Start-only drafting (revision 3 §E): proposes a loop returning to
   * the start, sized by `distanceKm` (SOFT target, independent of the
   * multi-day daily-km field) in the chosen compass direction. REAL
   * routing measures the loop; Fun Zones in the directional lobe are
   * threaded when available; never padded with dull detours.
   */
  draftRoundtrip(
    start: { lat: number; lng: number },
    opts: RoundtripOptions,
    init?: { signal?: AbortSignal },
  ): Promise<DraftRoundtripResult>;

  /**
   * The rider's saved planner defaults (revision 3 §F) — REAL, stored in
   * the `users.preferences` JSONB via GET/PATCH /users/me. Null until
   * the rider has ever saved prefs.
   */
  getUserRoutePrefs(init?: {
    signal?: AbortSignal;
  }): Promise<import("./prefs").UserRoutePrefs | null>;
  saveUserRoutePrefs(prefs: import("./prefs").UserRoutePrefs): Promise<void>;
}

/** Options confirmed in the roundtrip dialog (revision 3 §E). */
export interface RoundtripOptions {
  /** Soft target loop length in km (~50–1500; default 250). */
  distanceKm: number;
  direction: "N" | "E" | "S" | "W" | "NE" | "NW" | "SE" | "SW" | "random";
  preference: import("./prefs").RoadPreference;
  /** Drawn map region — wins over `direction` for Fun-Zone search. */
  region?: [number, number, number, number] | null;
}

export interface DraftRoundtripResult {
  segments: RouteSegment[];
  summary: RouteQualitySummary;
  reachedTargetKm: boolean;
  /**
   * The loop's shape as waypoints (turnaround + Fun-Zone vias, travel
   * order) — apply to the trip so live routing redraws the same loop.
   */
  vias: Array<{ lat: number; lng: number; name: string }>;
}

/** Inputs for {@link PlannerApi.draftRoute} (revision 2 §F). */
export interface DraftOptions {
  /** Drawn map region ([west, south, east, north]) to pull Fun Zones from;
   * null/omitted = search a corridor-sized bbox around the endpoints. */
  region?: [number, number, number, number] | null;
  prefs: RouteRequestBody["options"];
  /** Soft target for roundtrip/inflation sizing only — never creates days. */
  dailyKmForSizing: number;
}

export interface DraftRouteResult {
  segments: RouteSegment[];
  summary: RouteQualitySummary;
  /** True when the draft stretched a short hop toward the sizing target. */
  inflated: boolean;
  /** False = genuinely good roads ran out short of the soft target —
   * surface the honest "limited fun roads nearby" note. */
  reachedTargetKm: boolean;
  /** Fun-Zone vias the draft threaded, in travel order — apply these to
   * the trip so live routing redraws the same line. */
  vias: Array<{ lat: number; lng: number; name: string }>;
}
