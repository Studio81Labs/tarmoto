/**
 * A single road-snapped route through an ordered list of waypoints.
 */
export interface RouteResult {
  distance_km: number;
  duration_min: number;
  geometry: Array<{ lat: number; lng: number }>;
}

/**
 * A single route alternative from a routing engine.
 */
export interface RouteAlternative {
  distance_km: number;
  duration_min: number;
  geometry: Array<{ lat: number; lng: number }>;
}

/**
 * Optional avoidance hints for `getAlternatives`. The trip generator
 * (US-7) plumbs `avoid_highways` / `avoid_tolls` from the request DTO
 * here. Implementations should map these to whatever exclusion the
 * upstream routing engine supports (OSRM passes `exclude=motorway`,
 * `exclude=toll` against the driving profile when the backend
 * exposes them) — when the upstream can't honour a flag, the
 * implementation should silently no-op rather than throw, since
 * partial honour is still strictly better than ignoring the flag.
 */
export interface RoutingOptions {
  avoidHighways?: boolean;
  avoidTolls?: boolean;
  /**
   * When true, the returned set includes the routing engine's primary
   * (lowest-duration) route at index 0 in addition to alternatives.
   * The trip generator sets this so every candidate is scored
   * equally — without it, OSRM's primary would be silently dropped
   * and any leg with only one route would fall through to a
   * synthetic 0 km stub. The commute module relies on the default
   * (false) because it persists its own primary and only wants
   * **other** routes to compare against.
   */
  includePrimary?: boolean;
  /**
   * Polygons the route must avoid — buffered geometry of active **full**
   * road closures in the route area (#744). Each entry is one polygon's
   * outer ring as `[lng, lat]` pairs, matching Valhalla's
   * `exclude_polygons` format. Engines that can't honour polygon
   * exclusions (OSRM) silently ignore this, per the no-op contract above.
   * Partial/advisory closures are NOT excluded here — they surface as
   * warnings via `ClosuresService.checkRoute()`.
   */
  excludePolygons?: Array<Array<[number, number]>>;
  /**
   * Prefer good-surface roads using Tarmoto's crowdsourced quality, mapped
   * onto GraphHopper's `smoothness` encoded value (ADR-0005, #779). Engines
   * that can't honour it (OSRM, Valhalla) silently ignore this, per the
   * no-op contract above; GraphHopper also no-ops it unless the `smoothness`
   * value has been provisioned (`TARMOTO_GRAPHHOPPER_QUALITY_ENABLED`).
   * Segments without crowdsourced data stay neutral — never penalised.
   */
  preferQuality?: boolean;
}

/**
 * Abstract routing provider interface.
 * Implement this to add a new routing engine (OSRM, GraphHopper, Mapbox, etc.)
 */
export interface RoutingProvider {
  /**
   * Stable identifier for the routing engine + algorithm version
   * persisted alongside cached results so callers can invalidate
   * stale geometry when the upstream engine changes (#361 — commute
   * primary-route polyline cache). Bump this whenever a swap changes
   * the road network, exclusion semantics, or the geometry shape
   * enough that previously-cached polylines should be re-resolved.
   * Implementations should keep the value short and opaque (e.g.
   * `osrm-v1`, `graphhopper-v2`) — callers compare by string equality.
   */
  readonly version: string;

  /**
   * Road-snapped route through `waypoints` in order. Returns `null` when the
   * engine cannot route (e.g. an isolated point). Reuses `RoutingOptions`.
   */
  route(
    waypoints: ReadonlyArray<{ lat: number; lng: number }>,
    options?: RoutingOptions,
  ): Promise<RouteResult | null>;

  /**
   * Get alternative routes between two points.
   * Returns up to `maxAlternatives` routes sorted by duration.
   *
   * `options` is forwarded by callers that need avoidance behaviour
   * (US-7 trip generator). Existing callers pass `undefined` and get
   * the unrestricted route.
   */
  getAlternatives(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number,
    maxAlternatives: number,
    options?: RoutingOptions,
  ): Promise<RouteAlternative[]>;
}

/**
 * Injection token for the routing provider.
 * Use this in module configuration to swap implementations.
 */
export const ROUTING_PROVIDER = 'ROUTING_PROVIDER';
