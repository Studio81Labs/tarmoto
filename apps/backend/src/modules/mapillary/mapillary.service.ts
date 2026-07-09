import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  STREET_IMAGERY_PROVIDER,
  type StreetImageBytes,
  type StreetImageryProvider,
} from './mapillary-provider.interface.js';
import { SegmentImageryDto } from './dto/segment-imagery.dto.js';
// Shared, dependency-free LRU+TTL cache (lives with the geocode proxy it was
// introduced for, #909). Imagery caching has the same shape.
import { TtlCache } from '../geocode/ttl-cache.js';

// Street imagery for a coordinate is static day-to-day (Mapillary coverage
// changes slowly), so a generous TTL keeps the hit rate high across repeated
// hovers while the entry bound caps memory.
const IMAGERY_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const IMAGERY_CACHE_MAX_ENTRIES = 2000;
// Thumbnails are large, so bound the byte cache far tighter than the metadata
// cache. Enough to keep a browsing session's recently-viewed thumbs warm.
const THUMB_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const THUMB_CACHE_MAX_ENTRIES = 256;

const NO_IMAGERY: SegmentImageryDto = {
  imageId: null,
  capturedAt: null,
  attribution: null,
  link: null,
};

@Injectable()
export class MapillaryService {
  private readonly logger = new Logger(MapillaryService.name);
  // Caches BOTH hits and "no coverage" — a missing image is a stable fact worth
  // caching; only the thrown-error path stays uncached so a transient upstream
  // failure isn't pinned for the whole TTL.
  private readonly cache = new TtlCache<SegmentImageryDto>(
    IMAGERY_CACHE_MAX_ENTRIES,
    IMAGERY_CACHE_TTL_MS,
  );
  private readonly thumbCache = new TtlCache<StreetImageBytes>(
    THUMB_CACHE_MAX_ENTRIES,
    THUMB_CACHE_TTL_MS,
  );

  constructor(
    @Inject(STREET_IMAGERY_PROVIDER)
    private readonly provider: StreetImageryProvider,
  ) {}

  async segmentImagery(
    lat: number,
    lng: number,
    bearing?: number,
  ): Promise<SegmentImageryDto> {
    // Round to ~11 m so near-identical hover points share an entry, and bucket
    // the bearing to 45° so an out-and-back / opposite carriageway at the same
    // midpoint (bearings ~180° apart) gets its own forward-facing image rather
    // than reusing the first direction's cached frame.
    const bearingBucket =
      bearing === undefined ? 'x' : Math.round(bearing / 45) % 8;
    const cacheKey = `${lat.toFixed(4)}:${lng.toFixed(4)}:${bearingBucket}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    let dto: SegmentImageryDto;
    try {
      const image = await this.provider.nearestImage(lat, lng, bearing);
      dto = image
        ? {
            imageId: image.imageId,
            capturedAt: image.capturedAt || null,
            attribution: image.attribution,
            link: image.link,
          }
        : NO_IMAGERY;
    } catch (err) {
      // The Road Preview must degrade gracefully — the card renders without a
      // thumbnail. Log only the error class; a coordinate can reveal rider
      // intent, so keep it out of the log line.
      const errName = err instanceof Error ? err.name : 'unknown';
      this.logger.warn(`Street imagery lookup failed (${errName})`);
      return NO_IMAGERY;
    }

    this.cache.set(cacheKey, dto);
    return dto;
  }

  /**
   * Proxy a thumbnail's bytes so the rider's browser loads it from us, not the
   * provider CDN (ADR-0009). Byte-cached; returns null on any error / missing
   * image so the endpoint can 404 without exposing upstream detail.
   */
  async thumbnail(imageId: string): Promise<StreetImageBytes | null> {
    const cached = this.thumbCache.get(imageId);
    if (cached) return cached;

    let bytes: StreetImageBytes | null;
    try {
      bytes = await this.provider.thumbnail(imageId);
    } catch (err) {
      const errName = err instanceof Error ? err.name : 'unknown';
      this.logger.warn(`Street imagery thumbnail failed (${errName})`);
      return null;
    }

    if (bytes) this.thumbCache.set(imageId, bytes);
    return bytes;
  }
}
