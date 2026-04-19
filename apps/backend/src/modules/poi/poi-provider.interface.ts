import type { AccommodationKind } from './dto/accommodation.dto.js';

/**
 * Normalized accommodation POI returned by any provider.
 * All providers must map their external response to this shape.
 */
export interface AccommodationPoi {
  external_id: string;
  name: string | null;
  kind: AccommodationKind;
  lat: number;
  lng: number;
  website: string | null;
  phone: string | null;
  stars: number | null;
}

/**
 * Abstract POI provider interface for accommodation lookups.
 * Implement this to add a new source (Overpass, Booking.com, Mapbox, etc.)
 */
export interface PoiProvider {
  /**
   * Find accommodations within `radiusKm` of a point.
   * Implementations should fail fast and leave filtering/sorting to the
   * service layer so different providers stay interchangeable.
   */
  findAccommodations(
    lat: number,
    lng: number,
    radiusKm: number,
  ): Promise<AccommodationPoi[]>;
}

/**
 * Injection token for the POI provider.
 * Use this in module configuration to swap implementations.
 */
export const POI_PROVIDER = 'POI_PROVIDER';
