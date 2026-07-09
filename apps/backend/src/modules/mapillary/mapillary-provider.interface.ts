/**
 * Normalized street-level image metadata for a coordinate. Providers map their
 * upstream payload to this shape so the service/controller stay unaware of the
 * source (Mapillary today; swappable per ADR-0009).
 *
 * Deliberately NOT a direct CDN url: the rider's browser must never contact the
 * imagery provider (that would leak their IP + the section they're viewing), so
 * we expose the `imageId` and stream the thumbnail through our own proxy.
 */
export interface StreetImage {
  /** Provider image id — the backend proxies its thumbnail by this id. */
  imageId: string;
  /** ISO date the image was captured, e.g. "2024-09-15". */
  capturedAt: string;
  /** Required credit line (creator + source + licence). */
  attribution: string;
  /** Public image page the credit links back to (attribution requirement). */
  link: string;
}

/** Raw thumbnail bytes streamed back to the browser through our proxy. */
export interface StreetImageBytes {
  contentType: string;
  body: Buffer;
}

/**
 * Abstract street-level imagery provider. Implement to add a source (e.g.
 * Mapillary, KartaView). Implementations fail fast on network/upstream errors
 * and return null when there is nothing to serve; the service layer owns
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

  /**
   * Fetch a thumbnail's bytes for `imageId` (server-side, so the browser loads
   * it from our proxy, not the provider CDN). Returns null when the image has
   * no thumbnail.
   */
  thumbnail(imageId: string): Promise<StreetImageBytes | null>;
}

/** DI token for the street imagery provider. */
export const STREET_IMAGERY_PROVIDER = 'STREET_IMAGERY_PROVIDER';
