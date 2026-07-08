import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  GEOCODE_PROVIDER,
  type GeocodeProvider,
  type GeocodeResult,
} from './geocode-provider.interface.js';
import {
  GeocodeListDto,
  GeocodeResultDto,
  MAX_GEOCODE_RESULTS,
  ReverseGeocodeResultDto,
} from './dto/geocode.dto.js';
import { TtlCache } from './ttl-cache.js';

// Place data is static minute-to-minute, so a generous TTL keeps the hit rate
// high while the entry bound caps memory. Collapses repeated typeahead prefixes
// and common places so public Nominatim isn't re-queried for the same input
// (#909 — the OSMF policy caps the whole app at ~1 req/s).
const GEOCODE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const GEOCODE_CACHE_MAX_ENTRIES = 1000;

@Injectable()
export class GeocodeService {
  private readonly logger = new Logger(GeocodeService.name);

  // Only SUCCESSFUL provider responses are cached — a transient provider
  // failure must not pin an empty/null result for the whole TTL.
  private readonly searchCache = new TtlCache<GeocodeListDto>(
    GEOCODE_CACHE_MAX_ENTRIES,
    GEOCODE_CACHE_TTL_MS,
  );
  private readonly reverseCache = new TtlCache<ReverseGeocodeResultDto>(
    GEOCODE_CACHE_MAX_ENTRIES,
    GEOCODE_CACHE_TTL_MS,
  );

  constructor(
    @Inject(GEOCODE_PROVIDER)
    private readonly provider: GeocodeProvider,
  ) {}

  async search(q: string, limit?: number): Promise<GeocodeListDto> {
    const normalizedQ = q.trim();
    const normalizedLimit = this.clampLimit(limit);
    if (normalizedQ.length === 0) {
      return { results: [] };
    }

    // Case-insensitive key (Nominatim search ignores case); `limit` is part of
    // the key because it changes how many matches come back.
    const cacheKey = `${normalizedLimit}:${normalizedQ.toLowerCase()}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached) return cached;

    let raw: GeocodeResult[];
    try {
      raw = await this.provider.search(normalizedQ, normalizedLimit);
    } catch (err) {
      // Ride search must stay usable when geocoding is flaky. The
      // companion falls back to the dropdown showing "no matches" and
      // existing filters keep working. Log only the error class — we
      // intentionally keep both the query and any provider-supplied
      // message (which can embed the query in a request-URL echo) out
      // of this warn path, since place names can reveal rider intent.
      const errName = err instanceof Error ? err.name : 'unknown';
      this.logger.warn(`Geocoder failed (${errName})`);
      return { results: [] };
    }

    // Sort by importance desc, then by label for deterministic ties.
    const sorted = [...raw].sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance;
      return a.label.localeCompare(b.label);
    });

    const results: GeocodeResultDto[] = sorted
      .slice(0, normalizedLimit)
      .map((r) => ({
        label: r.label,
        lat: r.lat,
        lng: r.lng,
        importance: Math.round(r.importance * 1000) / 1000,
      }));

    const dto: GeocodeListDto = { results };
    this.searchCache.set(cacheKey, dto);
    return dto;
  }

  async reverse(lat: number, lng: number): Promise<ReverseGeocodeResultDto> {
    // Round to ~11 m so near-identical pins share an entry — matches the
    // locality granularity the reverse lookup resolves to.
    const cacheKey = `${lat.toFixed(4)}:${lng.toFixed(4)}`;
    const cached = this.reverseCache.get(cacheKey);
    if (cached) return cached;

    let result: Awaited<ReturnType<GeocodeProvider['reverse']>>;
    try {
      result = await this.provider.reverse(lat, lng);
    } catch (err) {
      // Pin naming must degrade gracefully: the companion falls back to
      // showing the coordinates. Log only the error class — a coordinate
      // can reveal rider intent, so keep it out of the log line.
      const errName = err instanceof Error ? err.name : 'unknown';
      this.logger.warn(`Reverse geocoder failed (${errName})`);
      return { label: null };
    }

    // A genuine "unnamed" point (provider returned null, e.g. open sea) is a
    // stable fact worth caching; only the thrown-error path above stays
    // uncached so a transient failure isn't pinned for the TTL.
    const dto: ReverseGeocodeResultDto = { label: result?.label ?? null };
    this.reverseCache.set(cacheKey, dto);
    return dto;
  }

  private clampLimit(input: number | undefined): number {
    if (input === undefined || !Number.isFinite(input) || input <= 0) {
      return MAX_GEOCODE_RESULTS;
    }
    return Math.min(Math.floor(input), MAX_GEOCODE_RESULTS);
  }
}
