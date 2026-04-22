import type { AccommodationKind } from './dto/accommodation.dto.js';
import type { PoiKind } from './dto/point-of-interest.dto.js';

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
 * Normalized along-route POI (restaurant / viewpoint / café). Shared
 * across all providers so the service layer can rank and cap results
 * without knowing about the upstream source.
 */
export interface PointOfInterest {
  external_id: string;
  name: string | null;
  kind: PoiKind;
  lat: number;
  lng: number;
  website: string | null;
  phone: string | null;
  hint: string | null;
}

/**
 * Abstract POI provider interface for overnight-stay and along-route POI
 * lookups. Implement this to add a new source (Overpass, Booking.com,
 * Mapbox, etc.).
 */
export interface PoiProvider {
  /**
   * Find accommodations within `radiusKm` of a point. `kinds` selects
   * which subset of the tourism tag to fetch; implementations
   * short-circuit to `[]` on an empty array, but the service layer
   * normally substitutes the default so callers don't have to.
   * Implementations should fail fast and leave further filtering /
   * sorting (star rating, distance) to the service layer so different
   * providers stay interchangeable.
   */
  findAccommodations(
    lat: number,
    lng: number,
    radiusKm: number,
    kinds: AccommodationKind[],
  ): Promise<AccommodationPoi[]>;

  /**
   * Find along-route POIs (restaurants, viewpoints, cafés) within
   * `radiusKm` of a point. `kinds` selects which subset to fetch;
   * implementations short-circuit to `[]` on an empty array, but the
   * service layer normally substitutes the default so callers don't
   * have to.
   */
  findPointsOfInterest(
    lat: number,
    lng: number,
    radiusKm: number,
    kinds: PoiKind[],
  ): Promise<PointOfInterest[]>;
}

/**
 * Injection token for the POI provider.
 * Use this in module configuration to swap implementations.
 */
export const POI_PROVIDER = 'POI_PROVIDER';
