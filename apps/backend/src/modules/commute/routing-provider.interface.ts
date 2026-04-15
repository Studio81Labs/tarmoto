/**
 * A single route alternative from a routing engine.
 */
export interface RouteAlternative {
  distance_km: number;
  duration_min: number;
  geometry: Array<{ lat: number; lng: number }>;
}

/**
 * Abstract routing provider interface.
 * Implement this to add a new routing engine (OSRM, GraphHopper, Mapbox, etc.)
 */
export interface RoutingProvider {
  /**
   * Get alternative routes between two points.
   * Returns up to `maxAlternatives` routes sorted by duration.
   */
  getAlternatives(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number,
    maxAlternatives: number,
  ): Promise<RouteAlternative[]>;
}

/**
 * Injection token for the routing provider.
 * Use this in module configuration to swap implementations.
 */
export const ROUTING_PROVIDER = 'ROUTING_PROVIDER';
