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
 * Normalized reverse-geocoding result: a concise name for a coordinate,
 * naming the enclosing place (town/city/region) so a dropped map pin reads
 * as its area rather than raw numbers.
 */
export interface ReverseGeocodeResult {
  label: string;
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

  /**
   * Name a coordinate: resolve `(lat, lng)` to its enclosing place.
   * Returns `null` when the provider can't name the point (e.g. open
   * sea). Implementations fail fast on network/upstream errors and leave
   * graceful fallback to the service layer.
   */
  reverse(lat: number, lng: number): Promise<ReverseGeocodeResult | null>;
}

/** DI token for the geocode provider. */
export const GEOCODE_PROVIDER = 'GEOCODE_PROVIDER';
