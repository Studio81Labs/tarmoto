/**
 * Normalized street-level image for a coordinate. Providers map their upstream
 * payload to this shape so the service/controller stay unaware of the source
 * (Mapillary today; swappable per ADR-0009).
 */
export interface StreetImage {
  /** Displayable image URL (a ~1024px thumbnail). */
  imageUrl: string;
  /** ISO date the image was captured, e.g. "2024-09-15". */
  capturedAt: string;
  /** Required credit line (creator + source + licence). */
  attribution: string;
}

/**
 * Abstract street-level imagery provider. Implement to add a source (e.g.
 * Mapillary, KartaView). Implementations fail fast on network/upstream errors
 * and return null when there is no nearby image; the service layer owns
 * graceful fallback + caching.
 */
export interface StreetImageryProvider {
  /**
   * Find the best street-level image near `(lat, lng)`. When `bearing` (deg,
   * 0 = N) is given, prefer an image facing roughly the same way — the travel
   * direction along the segment. Returns null when there is no coverage.
   */
  nearestImage(
    lat: number,
    lng: number,
    bearing?: number,
  ): Promise<StreetImage | null>;
}

/** DI token for the street imagery provider. */
export const STREET_IMAGERY_PROVIDER = 'STREET_IMAGERY_PROVIDER';
