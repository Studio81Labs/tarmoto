/**
 * Normalized geocoding result returned by any provider. Providers map
 * their upstream payload to this shape so the service/controller layers
 * stay unaware of the source.
 */
export interface GeocodeResult {
  label: string;
  lat: number;
  lng: number;
  importance: number;
}

/**
 * Abstract geocoder interface. Implement this to add a new source
 * (e.g. a self-hosted Nominatim, Mapbox, Pelias).
 */
export interface GeocodeProvider {
  /**
   * Resolve a place name to up to `limit` matches. Implementations
   * should fail fast on network or upstream errors and leave graceful
   * fallback (empty list) to the service layer.
   */
  search(q: string, limit: number): Promise<GeocodeResult[]>;
}

/** DI token for the geocode provider. */
export const GEOCODE_PROVIDER = 'GEOCODE_PROVIDER';
