import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  STREET_IMAGERY_PROVIDER,
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

const NO_IMAGERY: SegmentImageryDto = {
  imageUrl: null,
  capturedAt: null,
  attribution: null,
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

  constructor(
    @Inject(STREET_IMAGERY_PROVIDER)
    private readonly provider: StreetImageryProvider,
  ) {}

  async segmentImagery(
    lat: number,
    lng: number,
    bearing?: number,
  ): Promise<SegmentImageryDto> {
    // Round to ~11 m so near-identical hover points share an entry. Bearing is
    // only a minor refinement for confirmation-only imagery, so it's left out
    // of the key — the first image found for the location is reused.
    const cacheKey = `${lat.toFixed(4)}:${lng.toFixed(4)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    let dto: SegmentImageryDto;
    try {
      const image = await this.provider.nearestImage(lat, lng, bearing);
      dto = image
        ? {
            imageUrl: image.imageUrl,
            capturedAt: image.capturedAt || null,
            attribution: image.attribution,
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
}
