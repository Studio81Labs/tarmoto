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
} from './dto/geocode.dto.js';

@Injectable()
export class GeocodeService {
  private readonly logger = new Logger(GeocodeService.name);

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

    return { results };
  }

  private clampLimit(input: number | undefined): number {
    if (input === undefined || !Number.isFinite(input) || input <= 0) {
      return MAX_GEOCODE_RESULTS;
    }
    return Math.min(Math.floor(input), MAX_GEOCODE_RESULTS);
  }
}
