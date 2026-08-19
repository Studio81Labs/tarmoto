import type * as GeoJSON from "geojson";
import type {
  Formatters,
  PlannerPoiCategory,
  SurfaceType,
} from "@tarmoto/shared";
import type { RouteRequestBody, RouteResponse } from "@/lib/api";

/**
 * Plan & inspect planner contracts.
 *
 * The planner UI is built against these types and talks to data exclusively
 * through {@link PlannerApi}. Routing geometry/time/surface-mix, per-segment
 * surface quality (backend Valhalla proxy + `POST /roads/route-quality`), and
 * geocoding (`/api/v1/geocode` + `/geocode/reverse`) are REAL; street-level
 * previews are still MOCKED in `./mocks/`. Swapping mock → real is a change to
 * `./api.ts` only.
 */

export type QualityBand = "good" | "fair" | "rough" | "no_data";

/** One road-segment's contribution to a run's quality strip: its 0–5 score and
 * its length, so the strip can render bars proportional to distance. */
export interface QualitySpan {
  score: number;
  lengthKm: number;
}

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
  /**
   * road_segments UUID of the matched span, when this is a real routed-quality
   * segment. Lets a click open the same `/roads/{id}` detail drawer (reviews +
   * history) as the road explorer. Absent for geometry-only fallback segments
   * and coalesced runs (which span multiple road segments).
   */
  roadSegmentId?: string | null;
  /**
   * Per-constituent quality spans (score + length) when this is a coalesced run
   * (set by `findRunSegment`) — feeds the Road Preview "quality across section"
   * strip. Absent for a single fine segment (nothing to vary).
   */
  microStrip?: QualitySpan[];
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
  /** Present for rough runs; UI combines this semantic value with locale copy. */
  surface?: SurfaceType;
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
  /**
   * Per-road-segment quality across a coalesced run — the real "quality across
   * section" strip. Each entry carries its `score` (0–5, sub-band variation,
   * since a run is one band) AND its `lengthKm`, so the strip renders bars
   * proportional to distance along the 0→run-length axis. Absent for a
   * single-segment run.
   */
  microStrip?: QualitySpan[];
  /** Street-level (Mapillary) image; absent until a key is wired. */
  imageUrl?: string;
  /** ISO date the street-level image was captured, e.g. "2024-09-15". */
  imageCapturedAt?: string;
  /** Required credit line for the imagery (Mapillary is CC-BY-SA). */
  imageAttribution?: string;
  /** Public image page the credit links back to (attribution requirement). */
  imageLink?: string;
  /** Raw OSM surface tag shown as unverified fallback, e.g. "asphalt". */
  osmSurfaceTag?: string;
}

export type PlannerPoiType =
  "fuel" | "restaurant" | "cafe" | "viewpoint" | "stay";

export interface PlannerPoi {
  id: string;
  type: PlannerPoiType;
  name: string;
  /** Semantic category retained when the accommodation source has no name. */
  poiCategory?: PlannerPoiCategory;
  lat: number;
  lng: number;
  distanceFromRouteKm?: number;
  kmAlongRoute?: number;
}

/**
 * A category POI qualified against the current route line (revision 5
 * §C): the corridor query computes the shortest distance to the route
 * and where along the route the nearest point sits.
 */
export interface RouteStop extends Poi {
  /** Shortest distance from the POI to the route line, in km. */
  distanceFromRouteKm: number;
  /** Along-route position (km from the start) of the nearest point. */
  kmAlongRoute: number;
}

/**
 * Curated POI vocabulary for the map-top toolbar + STOPS filters
 * (revision 4 §A). Deliberately a closed set — no generic POI browser.
 */
export type PoiCategory = PlannerPoiCategory;

/** Provenance of a category POI. `osm` + `fsq` are the two bulk venue sources
 * (#869); `passes`/`tarmoto` are Tarmoto-derived categories. */
export type PoiSource = "osm" | "fsq" | "passes" | "tarmoto";

/**
 * Mixed-source POI behind the single `getPoisByCategories` resolver
 * (revision 4 §B): fuel/food/cafe/viewpoint/campground/biker_hotel come
 * from OSM, mountain_pass from the seasonal-pass source, and
 * twisty_highlight from Tarmoto's own curviness + quality layer.
 */
export interface Poi {
  id: string;
  category: PoiCategory;
  source: PoiSource;
  name: string;
  lat: number;
  lng: number;
  distanceFromRouteKm?: number;
  kmAlongRoute?: number;
  /** Source-specific extras, e.g. pass status or twisty score. */
  meta?: Record<string, unknown>;
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
  /** True only when the matching town label came from the POI source. */
  startNameIsSource?: boolean;
  endNameIsSource?: boolean;
  /** Semantic fallback for an unnamed overnight boundary. */
  startPoiCategory?: PoiCategory;
  endPoiCategory?: PoiCategory;
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
   * Routes through the waypoints via the backend Valhalla proxy (REAL). The
   * returned segments are the geometry-only `no_data` baseline (deterministic
   * on geometry, so re-renders and reroutes are stable); real per-segment
   * quality is fetched separately via {@link PlannerApi.getRouteQuality} once
   * the day is committed.
   */
  generateRoute(
    waypoints: ReadonlyArray<{ lat: number; lng: number }>,
    options: RouteRequestBody["options"],
    init?: { signal?: AbortSignal; dayNumber?: number },
  ): Promise<GeneratedPlannerRoute>;

  /**
   * REAL per-segment surface quality for a committed day's routed polyline
   * (#862): calls `POST /roads/route-quality` and maps the returned spans onto
   * the line. Called once per committed day — never in the draft sizing loops.
   * An empty response (route not covered) or a failure leaves the caller on
   * the geometry-only `no_data` baseline.
   */
  getRouteQuality(
    points: ReadonlyArray<{ lat: number; lng: number }>,
    dayNumber: number,
    init?: { signal?: AbortSignal },
  ): Promise<RouteSegment[]>;

  /**
   * Road Preview card quality payload for a clicked segment — built from the
   * segment's real overlay data (#862), so it resolves immediately. Street-level
   * imagery is fetched separately via {@link getSegmentImagery} so a slow
   * Mapillary lookup never blocks the actionable card (#863).
   */
  getRoadPreview(segment: RouteSegment): Promise<RoadPreview>;

  /**
   * Street-level imagery for a segment (Mapillary via the backend proxy, #863).
   * Best-effort — resolves to null on any error / no coverage. Merged into the
   * preview after the quality card has already rendered.
   */
  getSegmentImagery(
    segment: RouteSegment,
  ): Promise<Pick<
    RoadPreview,
    "imageUrl" | "imageCapturedAt" | "imageAttribution" | "imageLink"
  > | null>;

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

  /**
   * Mixed-source POIs for the map-top category bar (revision 4 §B) —
   * one resolver so callers don't care that fuel/food/… are OSM,
   * mountain_pass is the seasonal-pass source, and twisty_highlight is
   * Tarmoto's curviness layer. The OSM amenity categories read the `pois`
   * store via `/poi/in-bbox` (#857); mountain_pass comes from the passes
   * module and twisty_highlight from the Fun Zones layer (#865). `forMonth`
   * (1–12) sets the seasonal pass status so it matches the Conditions overlay;
   * omit for the current month (it only affects mountain_pass).
   */
  getPoisByCategories(
    bbox: [number, number, number, number],
    categories: PoiCategory[],
    forMonth?: number,
    init?: { signal?: AbortSignal },
  ): Promise<Poi[]>;

  /**
   * Route-corridor POI query for the STOPS tab (revision 5 §C): the
   * SAME category POIs as `getPoisByCategories`, but filtered by
   * proximity to the route line, each with distance-from-route and
   * km-along-route, sorted by km-along-route. The OSM categories query the
   * `pois` store's PostGIS corridor via `/poi/in-corridor` (#859);
   * mountain_pass via `passes/check-route`, twisty_highlight via the Fun Zones
   * corridor (#865). `minStayRating` applies only to accommodation categories
   * (biker_hotel / campground); `forMonth` (1–12) sets the seasonal pass status
   * (mountain_pass only), omit for the current month.
   */
  getRouteStops(
    routeGeometry: GeoJSON.LineString,
    categories: PoiCategory[],
    corridorKm: number,
    minStayRating?: number,
    forMonth?: number,
    init?: { signal?: AbortSignal },
  ): Promise<RouteStop[]>;

  /** Typed waypoint search in the panel (REAL — `GET /api/v1/geocode`). */
  geocode(query: string, init?: { signal?: AbortSignal }): Promise<GeoResult[]>;

  /**
   * Name a map-placed pin from its coordinate (REAL —
   * `GET /api/v1/geocode/reverse`); falls back to a coordinate label when the
   * point can't be named.
   */
  reverseGeocode(
    lat: number,
    lng: number,
    init?: {
      signal?: AbortSignal;
      format?: Pick<Formatters, "decimal">;
    },
  ): Promise<string>;

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
  /**
   * The sidebar route options (avoid flags etc.): the measuring routes
   * must honour the same constraints the live reroute will apply, or
   * the confirmed loop's sizing and vias come from roads the rider
   * disabled. `preference` above always wins over any preference here.
   */
  prefs?: RouteRequestBody["options"];
}

export interface DraftRoundtripResult {
  segments: RouteSegment[];
  summary: RouteQualitySummary;
  reachedTargetKm: boolean;
  /**
   * The loop's shape as waypoints (turnaround + Fun-Zone vias, travel
   * order) — apply to the trip so live routing redraws the same loop.
   */
  vias: Array<{ lat: number; lng: number; name?: string }>;
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
  vias: Array<{ lat: number; lng: number; name?: string }>;
}
