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
}

/**
 * Abstract routing provider interface.
 * Implement this to add a new routing engine (OSRM, GraphHopper, Mapbox, etc.)
 */
export interface RoutingProvider {
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
