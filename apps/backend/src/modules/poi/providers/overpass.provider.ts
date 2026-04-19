import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  PoiProvider,
  AccommodationPoi,
  PointOfInterest,
} from '../poi-provider.interface.js';
import {
  ACCOMMODATION_KINDS,
  type AccommodationKind,
} from '../dto/accommodation.dto.js';
import { type PoiKind } from '../dto/point-of-interest.dto.js';

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

const KIND_SET = new Set<string>(ACCOMMODATION_KINDS);
const OVERPASS_FETCH_TIMEOUT_MS = 10_000;

/**
 * Map our `PoiKind` to the OSM tag key + regex of allowed values that
 * identifies it. Restaurants and cafés are `amenity=*`; viewpoints are
 * `tourism=viewpoint`. We keep the mapping here (rather than in the DTO)
 * so the Overpass-specific detail doesn't leak out of the provider.
 */
const POI_KIND_TAGS: Record<
  PoiKind,
  { key: 'amenity' | 'tourism'; value: string }
> = {
  restaurant: { key: 'amenity', value: 'restaurant' },
  cafe: { key: 'amenity', value: 'cafe' },
  viewpoint: { key: 'tourism', value: 'viewpoint' },
};

/**
 * Overpass API implementation of PoiProvider.
 *
 * Queries the public Overpass endpoint for `tourism=*` POIs that match our
 * accommodation kind list. The endpoint is free but rate-limited; the
 * mirror is configurable via `TARMOTO_OVERPASS_URL` for deployments that
 * need a private instance.
 */
@Injectable()
export class OverpassPoiProvider implements PoiProvider {
  private readonly logger = new Logger(OverpassPoiProvider.name);
  private readonly endpoint: string;

  constructor(config: ConfigService) {
    this.endpoint = config.get<string>(
      'TARMOTO_OVERPASS_URL',
      'https://overpass-api.de/api/interpreter',
    );
  }

  async findAccommodations(
    lat: number,
    lng: number,
    radiusKm: number,
  ): Promise<AccommodationPoi[]> {
    const radiusM = Math.round(radiusKm * 1000);
    const tourismFilter = ACCOMMODATION_KINDS.join('|');
    // Overpass QL: search nodes + ways + relations so we pick up both
    // single-point POIs (common for camp sites) and building-shaped hotels.
    const query =
      `[out:json][timeout:25];` +
      `(` +
      `  node["tourism"~"^(${tourismFilter})$"](around:${radiusM},${lat},${lng});` +
      `  way["tourism"~"^(${tourismFilter})$"](around:${radiusM},${lat},${lng});` +
      `  relation["tourism"~"^(${tourismFilter})$"](around:${radiusM},${lat},${lng});` +
      `);` +
      `out center tags 60;`;

    const data = await this.runQuery(query);
    const pois: AccommodationPoi[] = [];
    for (const element of data.elements ?? []) {
      const poi = this.normalizeAccommodation(element);
      if (poi) pois.push(poi);
    }
    return pois;
  }

  async findPointsOfInterest(
    lat: number,
    lng: number,
    radiusKm: number,
    kinds: PoiKind[],
  ): Promise<PointOfInterest[]> {
    if (kinds.length === 0) return [];
    const radiusM = Math.round(radiusKm * 1000);
    // Group by OSM tag key so we emit one regex per key — mixing
    // `amenity` and `tourism` into a single filter would require an OR
    // over two keys, which Overpass QL doesn't express concisely.
    const byKey = new Map<'amenity' | 'tourism', string[]>();
    for (const kind of kinds) {
      const { key, value } = POI_KIND_TAGS[kind];
      const values = byKey.get(key) ?? [];
      values.push(value);
      byKey.set(key, values);
    }

    const clauses: string[] = [];
    for (const [key, values] of byKey.entries()) {
      const filter = values.join('|');
      // Nodes + ways: restaurants and viewpoints show up both as single
      // points (most common) and as building polygons. Relations are rare
      // for these kinds, so we skip them to keep the response fast.
      clauses.push(
        `  node["${key}"~"^(${filter})$"](around:${radiusM},${lat},${lng});`,
      );
      clauses.push(
        `  way["${key}"~"^(${filter})$"](around:${radiusM},${lat},${lng});`,
      );
    }

    const query =
      `[out:json][timeout:25];` +
      `(` +
      clauses.join('') +
      `);` +
      `out center tags 80;`;

    const data = await this.runQuery(query);
    const pois: PointOfInterest[] = [];
    for (const element of data.elements ?? []) {
      const poi = this.normalizePoi(element);
      if (poi && kinds.includes(poi.kind)) pois.push(poi);
    }
    return pois;
  }

  private async runQuery(query: string): Promise<OverpassResponse> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      OVERPASS_FETCH_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(
        `Overpass API error: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as OverpassResponse;
  }

  private normalizeAccommodation(
    element: OverpassElement,
  ): AccommodationPoi | null {
    const tags = element.tags ?? {};
    const tourism = tags.tourism;
    if (!tourism || !KIND_SET.has(tourism)) return null;

    const lat = element.lat ?? element.center?.lat;
    const lng = element.lon ?? element.center?.lon;
    if (lat === undefined || lng === undefined) return null;

    return {
      external_id: `osm:${element.type}:${element.id}`,
      name: tags.name ?? tags['name:en'] ?? null,
      kind: tourism as AccommodationKind,
      lat,
      lng,
      website: tags.website ?? tags['contact:website'] ?? null,
      phone: tags.phone ?? tags['contact:phone'] ?? null,
      stars: this.parseStars(tags.stars),
    };
  }

  private normalizePoi(element: OverpassElement): PointOfInterest | null {
    const tags = element.tags ?? {};
    const kind = classifyPoiTags(tags);
    if (!kind) return null;

    const lat = element.lat ?? element.center?.lat;
    const lng = element.lon ?? element.center?.lon;
    if (lat === undefined || lng === undefined) return null;

    return {
      external_id: `osm:${element.type}:${element.id}`,
      name: tags.name ?? tags['name:en'] ?? null,
      kind,
      lat,
      lng,
      website: tags.website ?? tags['contact:website'] ?? null,
      phone: tags.phone ?? tags['contact:phone'] ?? null,
      hint: extractPoiHint(kind, tags),
    };
  }

  private parseStars(raw: string | undefined): number | null {
    return parseStarsTag(raw);
  }
}

/**
 * Decide which of our POI kinds an Overpass element belongs to based on
 * its `amenity` / `tourism` tags. Returns `null` for anything that
 * doesn't match — guarding against amenity=bar / tourism=hotel etc. that
 * may show up in a bbox query even when we didn't ask for them.
 */
export function classifyPoiTags(tags: Record<string, string>): PoiKind | null {
  const amenity = tags.amenity;
  if (amenity === 'restaurant' || amenity === 'cafe') return amenity;
  if (tags.tourism === 'viewpoint') return 'viewpoint';
  return null;
}

/**
 * Extract a one-line descriptor to render under the POI name. For
 * restaurants and cafés the `cuisine` tag is the best signal ("italian",
 * "pizza"); for viewpoints we fall back to `description` then `view_type`
 * (typical OSM tags for scenic spots). Normalizes underscore-separated
 * values ("fine_dining" → "fine dining") so the mobile card doesn't have
 * to do it. Strictly null-safe — the card hides the row when `hint` is
 * null.
 */
export function extractPoiHint(
  kind: PoiKind,
  tags: Record<string, string>,
): string | null {
  const raw = (() => {
    if (kind === 'viewpoint') {
      return tags.description ?? tags.view_type ?? null;
    }
    return tags.cuisine ?? null;
  })();
  if (!raw) return null;
  const cleaned = raw.replace(/[_;]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

/**
 * Parse an OSM `stars` tag into a whole-star count in 1..5.
 *
 * The tag can carry trailing "S" (superior), fractional values
 * (e.g. "4.5"), or a range (e.g. "4-5"). We capture decimal tokens and
 * range endpoints explicitly — a naive `\d+` split would shatter "4.5"
 * into 4 and 5 and overstate the advertised rating. Pick the highest
 * endpoint, floor it to a whole star, and reject anything outside 1..5
 * so the UI never renders six stars for a "6S" tag.
 */
export function parseStarsTag(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const tokens = raw.match(/\d+(?:\.\d+)?/g);
  if (!tokens) return null;
  let max = -Infinity;
  for (const t of tokens) {
    const n = Number(t);
    if (Number.isFinite(n) && n > max) max = n;
  }
  if (!Number.isFinite(max)) return null;
  const floored = Math.floor(max);
  if (floored < 1 || floored > 5) return null;
  return floored;
}
