import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  PoiProvider,
  AccommodationPoi,
} from '../poi-provider.interface.js';
import {
  ACCOMMODATION_KINDS,
  type AccommodationKind,
} from '../dto/accommodation.dto.js';

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

    const data = (await response.json()) as OverpassResponse;
    const pois: AccommodationPoi[] = [];
    for (const element of data.elements ?? []) {
      const poi = this.normalize(element);
      if (poi) pois.push(poi);
    }
    return pois;
  }

  private normalize(element: OverpassElement): AccommodationPoi | null {
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

  private parseStars(raw: string | undefined): number | null {
    return parseStarsTag(raw);
  }
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
