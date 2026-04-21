import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  GeocodeProvider,
  GeocodeResult,
} from '../geocode-provider.interface.js';

interface NominatimRow {
  display_name?: string;
  lat?: string;
  lon?: string;
  importance?: number | string;
}

const NOMINATIM_FETCH_TIMEOUT_MS = 8_000;

/**
 * Nominatim (OpenStreetMap) geocoder. Chosen in ADR-0002.
 *
 * Calls the public `nominatim.openstreetmap.org` instance by default.
 * Self-hosted deployments override the endpoint via `TARMOTO_NOMINATIM_URL`.
 *
 * Nominatim's usage policy requires a descriptive `User-Agent` — we set
 * one here. Don't lift the identifier into an env var: a missing header
 * silently fails only at scale, and a stable identifier makes abuse
 * complaints routable back to us.
 */
@Injectable()
export class NominatimProvider implements GeocodeProvider {
  private readonly endpoint: string;
  private readonly userAgent: string;

  constructor(config: ConfigService) {
    const raw = config.get<string>(
      'TARMOTO_NOMINATIM_URL',
      'https://nominatim.openstreetmap.org',
    );
    // Normalize to a trailing slash so self-hosted deployments with a
    // path prefix (e.g. `https://example.com/nominatim/`) resolve to
    // `<prefix>/search` instead of the host root — `new URL('/search',
    // base)` treats the leading slash as absolute and drops the prefix.
    this.endpoint = raw.endsWith('/') ? raw : `${raw}/`;
    this.userAgent = config.get<string>(
      'TARMOTO_NOMINATIM_UA',
      'Tarmoto/1.0 (https://tarmoto.app)',
    );
  }

  async search(q: string, limit: number): Promise<GeocodeResult[]> {
    const url = new URL('search', this.endpoint);
    url.searchParams.set('q', q);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', String(limit));
    // Coarse place-type bias — we want regions, towns, landmarks, not
    // individual addresses or POIs. Keeping this list short is better
    // than extending it: Nominatim's default ranking is strong once the
    // addressdetails category filter is out of the way.
    url.searchParams.set('accept-language', 'en');

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      NOMINATIM_FETCH_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(
        `Nominatim API error: ${response.status} ${response.statusText}`,
      );
    }

    const rows = (await response.json()) as NominatimRow[];
    const results: GeocodeResult[] = [];
    for (const row of rows) {
      const normalized = this.normalize(row);
      if (normalized) results.push(normalized);
    }
    return results;
  }

  private normalize(row: NominatimRow): GeocodeResult | null {
    const label = row.display_name?.trim();
    if (!label) return null;
    const lat = Number(row.lat);
    const lng = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const importanceRaw =
      typeof row.importance === 'string'
        ? Number(row.importance)
        : row.importance;
    const importance =
      typeof importanceRaw === 'number' && Number.isFinite(importanceRaw)
        ? Math.min(1, Math.max(0, importanceRaw))
        : 0;
    return { label, lat, lng, importance };
  }
}
