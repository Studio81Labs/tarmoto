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
 * Decision-support fields captured from OSM tags and stored on every `pois`
 * row (#848). Kept as a distinct shape so both the POI and accommodation
 * import paths carry the same columns without widening the live read DTOs
 * (`PoiDto` / `AccommodationDto`), which only surface these from Phase 1 on.
 * Everything is nullable — OSM coverage of these tags is uneven.
 */
export interface StoredPoiFields {
  /** Raw OSM `opening_hours` expression, e.g. `Mo-Su 09:00-18:00`. */
  opening_hours: string | null;
  /** Street line: `addr:street` (+ `addr:housenumber` when present). */
  address_street: string | null;
  /** `addr:city`, falling back to `addr:town` / `addr:village` (rural POIs). */
  address_city: string | null;
  address_postcode: string | null;
  /** Upper-case ISO 3166-1 alpha-2 country, or null if not a 2-letter code. */
  address_country: string | null;
  /** Normalized cuisine (restaurants / cafés), e.g. `italian`. */
  cuisine: string | null;
  /** Brand, falling back to operator (fuel chains, franchises). */
  brand: string | null;
  /** Bounded raw OSM tag bag for future enrichment; null when empty. */
  tags: Record<string, string> | null;
}

/**
 * A POI fetched by the offline import (#745). Distinct from
 * `PointOfInterest` because the storage tag set (§7) is a **superset** of
 * the live `PoiKind` enum — it also covers `fast_food`, `rest_area`, and
 * `ice_cream`, which aren't live `/poi` categories. `kind` is therefore a
 * free-form string written straight to `pois.kind`, decoupled from the
 * live API so widening the store never changes the read enum. Carries the
 * `StoredPoiFields` decision-support columns (#848).
 */
export interface ImportedPoi extends StoredPoiFields {
  external_id: string;
  name: string | null;
  kind: string;
  lat: number;
  lng: number;
  website: string | null;
  phone: string | null;
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

  /**
   * Find POIs within `radiusKm` of any of the supplied sample points —
   * used by the route-aware lookup so a long day can be queried in one
   * provider call rather than one-per-vertex. Implementations should
   * union the circles (e.g. Overpass QL's multi-centre `around:`) so
   * the service layer still pays one upstream round-trip.
   *
   * Short-circuits to `[]` on an empty `points` or `kinds` array. The
   * service layer is responsible for downselecting samples to stay
   * under any upstream query-size limits.
   */
  findPointsOfInterestAroundPoints(
    points: readonly { lat: number; lng: number }[],
    radiusKm: number,
    kinds: PoiKind[],
  ): Promise<PointOfInterest[]>;

  /**
   * Fetch every POI in the §7 storage tag set within a bounding box — used
   * by the offline import (#745) to mirror a region into the `pois` table,
   * rather than the point/route-relative lookups above. Covers the full
   * documented set (food incl. `fast_food`, fuel, viewpoints, rest areas,
   * ice cream), a superset of the live `PoiKind` enum. A provider failure
   * throws so the caller can skip the upsert (leaving existing rows intact)
   * instead of wiping the area.
   */
  findImportPoisInBbox(bbox: {
    minLng: number;
    minLat: number;
    maxLng: number;
    maxLat: number;
  }): Promise<ImportedPoi[]>;

  /**
   * Accommodation equivalent of `findPointsOfInterestInBbox` — fetches
   * hotels / campsites etc. within a bounding box for the offline import
   * (#745), so the stored POI set stays aligned with `/accommodations`.
   * Same contract: short-circuits on empty `kinds`, throws on a provider
   * failure so the caller can skip the upsert (leaving existing rows).
   */
  findAccommodationsInBbox(
    bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number },
    kinds: AccommodationKind[],
  ): Promise<(AccommodationPoi & StoredPoiFields)[]>;
}

/**
 * Injection token for the POI provider.
 * Use this in module configuration to swap implementations.
 */
export const POI_PROVIDER = 'POI_PROVIDER';
