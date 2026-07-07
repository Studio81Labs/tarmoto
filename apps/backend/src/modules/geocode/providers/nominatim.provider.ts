import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  GeocodeProvider,
  GeocodeResult,
  ReverseGeocodeResult,
} from '../geocode-provider.interface.js';

interface NominatimRow {
  display_name?: string;
  lat?: string;
  lon?: string;
  importance?: number | string;
}

interface NominatimReverseRow {
  // Present (with HTTP 200) when Nominatim can't name the point, e.g. open
  // sea — treated as "unnamed", not an error.
  error?: string;
  name?: string;
  display_name?: string;
  address?: Record<string, string | undefined>;
}

const NOMINATIM_FETCH_TIMEOUT_MS = 8_000;

// Reverse-geocode granularity: bias the matched feature toward locality
// level (town / village / suburb) rather than a single building, so a
// dropped pin names its area. `addressdetails` still returns the whole
// hierarchy, so city / county / state remain available as fallbacks.
const NOMINATIM_REVERSE_ZOOM = 14;

// Address components to name a point by, most to least specific. The first
// present one wins — a settlement is the useful answer to "what place is
// this pin in", with administrative areas as the remote-area fallback.
const REVERSE_ADDRESS_KEYS = [
  'city',
  'town',
  'village',
  'municipality',
  'hamlet',
  'suburb',
  'city_district',
  'county',
  'state',
  'country',
] as const;

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
    // Free-form `q` search resolves street addresses, towns, and landmarks
    // alike — the planner's waypoint search relies on address-level matches,
    // so we deliberately set no feature-type filter. `accept-language` keeps
    // labels stable (English) for a predictable dropdown.
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

  async reverse(
    lat: number,
    lng: number,
  ): Promise<ReverseGeocodeResult | null> {
    const url = new URL('reverse', this.endpoint);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lng));
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('zoom', String(NOMINATIM_REVERSE_ZOOM));
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

    const row = (await response.json()) as NominatimReverseRow;
    return this.normalizeReverse(row);
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

  private normalizeReverse(
    row: NominatimReverseRow,
  ): ReverseGeocodeResult | null {
    // Nominatim answers an un-nameable point with `{ error }` and HTTP 200.
    if (!row || row.error) return null;
    const label = this.pickPlaceName(row);
    return label ? { label } : null;
  }

  private pickPlaceName(row: NominatimReverseRow): string | null {
    const address = row.address ?? {};
    for (const key of REVERSE_ADDRESS_KEYS) {
      const value = address[key]?.trim();
      if (value) return value;
    }
    // No settlement in the address (remote area): fall back to the matched
    // feature's own name, then the first segment of the full display name.
    const name = row.name?.trim();
    if (name) return name;
    const first = row.display_name?.split(',')[0]?.trim();
    return first ? first : null;
  }
}
