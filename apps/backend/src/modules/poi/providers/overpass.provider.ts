import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  PoiProvider,
  AccommodationPoi,
  ImportedPoi,
  PointOfInterest,
  StoredPoiFields,
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
 * The offline import (#745) is a full-area, uncapped query (`[timeout:180]`
 * server-side), so it needs a far longer client abort than the
 * request-time lookups — otherwise a legitimately slow regional import is
 * cancelled after 10 s and the weekly job never completes. Slightly above
 * the server timeout so the server's own limit is the one that fires.
 */
const OVERPASS_IMPORT_TIMEOUT_MS = 190_000;

/**
 * The §7 storage tag set for the offline import (#745) — a **superset** of
 * the live `POI_KIND_TAGS` that also covers `fast_food`, rest areas, and
 * ice cream. Decoupled from `PoiKind` on purpose: these `kind` strings are
 * written straight to `pois.kind` and must not change the live `/poi`
 * enum. Order matters — the first matching entry wins in
 * `normalizeImportedPoi`, so a dual-tagged element gets a stable category.
 * `highway=rest_area` and `highway=services` both map to `rest_area`.
 */
const IMPORT_POI_TAGS: ReadonlyArray<{
  key: string;
  value: string;
  kind: string;
}> = [
  { key: 'amenity', value: 'restaurant', kind: 'restaurant' },
  { key: 'amenity', value: 'cafe', kind: 'cafe' },
  { key: 'amenity', value: 'fast_food', kind: 'fast_food' },
  { key: 'amenity', value: 'fuel', kind: 'fuel_station' },
  { key: 'amenity', value: 'ice_cream', kind: 'ice_cream' },
  { key: 'shop', value: 'ice_cream', kind: 'ice_cream' },
  { key: 'tourism', value: 'viewpoint', kind: 'viewpoint' },
  { key: 'highway', value: 'rest_area', kind: 'rest_area' },
  { key: 'highway', value: 'services', kind: 'rest_area' },
];

/**
 * Map our `PoiKind` to the OSM tag key + regex of allowed values that
 * identifies it. Restaurants, cafés, and fuel stations are `amenity=*`;
 * viewpoints are `tourism=viewpoint`. We keep the mapping here (rather
 * than in the DTO) so the Overpass-specific detail doesn't leak out of
 * the provider.
 */
const POI_KIND_TAGS: Record<
  PoiKind,
  { key: 'amenity' | 'tourism'; value: string }
> = {
  restaurant: { key: 'amenity', value: 'restaurant' },
  cafe: { key: 'amenity', value: 'cafe' },
  viewpoint: { key: 'tourism', value: 'viewpoint' },
  fuel_station: { key: 'amenity', value: 'fuel' },
};

/**
 * Overpass API implementation of PoiProvider.
 *
 * Queries the public Overpass endpoint for `tourism=*` POIs that match our
 * accommodation kind list. The endpoint is free but rate-limited; the
 * mirror is configurable via `TARMOTO_OVERPASS_URL` for deployments that
 * need a private instance.
 *
 * Overpass's usage policy mirrors Nominatim's: requests must carry a
 * descriptive `User-Agent`, and some mirrors reject calls without an
 * explicit `Accept` header with HTTP 406 Not Acceptable. Both headers
 * are set on every request — see `TARMOTO_OVERPASS_UA` to override the
 * identifier for forks or alternate deployments.
 */
@Injectable()
export class OverpassPoiProvider implements PoiProvider {
  private readonly logger = new Logger(OverpassPoiProvider.name);
  private readonly endpoint: string;
  private readonly userAgent: string;

  constructor(config: ConfigService) {
    this.endpoint = config.get<string>(
      'TARMOTO_OVERPASS_URL',
      'https://overpass-api.de/api/interpreter',
    );
    this.userAgent = config.get<string>(
      'TARMOTO_OVERPASS_UA',
      'Tarmoto/1.0 (https://tarmoto.app)',
    );
  }

  async findAccommodations(
    lat: number,
    lng: number,
    radiusKm: number,
    kinds: AccommodationKind[],
  ): Promise<AccommodationPoi[]> {
    if (kinds.length === 0) return [];
    const radiusM = Math.round(radiusKm * 1000);
    // Dedup defensively — the service layer already does it, but the
    // Overpass regex rejects duplicate alternatives, so a caller that
    // short-circuits the service would otherwise fail the upstream query.
    const tourismFilter = Array.from(new Set(kinds)).join('|');
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
    const requested = new Set<AccommodationKind>(kinds);
    for (const element of data.elements ?? []) {
      const poi = this.normalizeAccommodation(element);
      if (poi && requested.has(poi.kind)) pois.push(poi);
    }
    return pois;
  }

  async findPointsOfInterest(
    lat: number,
    lng: number,
    radiusKm: number,
    kinds: PoiKind[],
  ): Promise<PointOfInterest[]> {
    return this.runPoiQuery([{ lat, lng }], radiusKm, kinds, 80);
  }

  async findPointsOfInterestAroundPoints(
    points: readonly { lat: number; lng: number }[],
    radiusKm: number,
    kinds: PoiKind[],
  ): Promise<PointOfInterest[]> {
    if (points.length === 0) return [];
    // Wider cap for the along-route case: one ride day can easily hit
    // dozens of fuel stations and restaurants. The service layer still
    // ranks and caps per-kind, so we just need the upstream response to
    // be large enough to rank from.
    return this.runPoiQuery(points, radiusKm, kinds, 200);
  }

  private async runPoiQuery(
    points: readonly { lat: number; lng: number }[],
    radiusKm: number,
    kinds: PoiKind[],
    limit: number,
  ): Promise<PointOfInterest[]> {
    if (kinds.length === 0 || points.length === 0) return [];
    const radiusM = Math.round(radiusKm * 1000);
    // Overpass QL's `around:` accepts a radius followed by any number of
    // lat/lon pairs, which unions the circles into a single filter — so
    // querying N sample points along a route costs one upstream round
    // trip rather than N.
    const aroundPairs = points.map((p) => `${p.lat},${p.lng}`).join(',');
    const around = `around:${radiusM},${aroundPairs}`;
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
      clauses.push(`  node["${key}"~"^(${filter})$"](${around});`);
      clauses.push(`  way["${key}"~"^(${filter})$"](${around});`);
    }

    const query =
      `[out:json][timeout:25];` +
      `(` +
      clauses.join('') +
      `);` +
      `out center tags ${limit};`;

    const data = await this.runQuery(query);
    const pois: PointOfInterest[] = [];
    for (const element of data.elements ?? []) {
      const poi = this.normalizePoi(element, kinds);
      if (poi) pois.push(poi);
    }
    return pois;
  }

  async findImportPoisInBbox(bbox: {
    minLng: number;
    minLat: number;
    maxLng: number;
    maxLat: number;
  }): Promise<ImportedPoi[]> {
    // Overpass bbox filter is (south, west, north, east).
    const box = `${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng}`;
    // One regex per OSM tag key — Overpass QL can't OR across keys
    // concisely. The §7 storage set spans amenity / tourism / highway /
    // shop, so group the tag values by key.
    const byKey = new Map<string, string[]>();
    for (const { key, value } of IMPORT_POI_TAGS) {
      const values = byKey.get(key) ?? [];
      values.push(value);
      byKey.set(key, values);
    }
    const clauses: string[] = [];
    for (const [key, values] of byKey.entries()) {
      const filter = [...new Set(values)].join('|');
      // node + way + relation: some §7 POIs (multipolygon service/rest
      // areas, viewpoint sites) are modeled as relations. `out center`
      // gives them a representative point, same as the accommodation path.
      clauses.push(`  node["${key}"~"^(${filter})$"](${box});`);
      clauses.push(`  way["${key}"~"^(${filter})$"](${box});`);
      clauses.push(`  relation["${key}"~"^(${filter})$"](${box});`);
    }
    // No `out` limit: an import wants the full area, not a capped sample.
    const query =
      `[out:json][timeout:180];` +
      `(` +
      clauses.join('') +
      `);` +
      `out center tags;`;

    const data = await this.runQuery(query, OVERPASS_IMPORT_TIMEOUT_MS);
    const pois: ImportedPoi[] = [];
    for (const element of data.elements ?? []) {
      const poi = this.normalizeImportedPoi(element);
      if (poi) pois.push(poi);
    }
    return pois;
  }

  /** Map an OSM element to the first §7 import kind whose tag it carries. */
  private normalizeImportedPoi(element: OverpassElement): ImportedPoi | null {
    const tags = element.tags ?? {};
    const match = IMPORT_POI_TAGS.find((t) => tags[t.key] === t.value);
    if (!match) return null;
    const lat = element.lat ?? element.center?.lat;
    const lng = element.lon ?? element.center?.lon;
    if (lat === undefined || lng === undefined) return null;
    return {
      external_id: `osm:${element.type}:${element.id}`,
      name: tags.name ?? tags['name:en'] ?? null,
      kind: match.kind,
      lat,
      lng,
      website: tags.website ?? tags['contact:website'] ?? null,
      phone: tags.phone ?? tags['contact:phone'] ?? null,
      ...extractStoredPoiFields(tags),
    };
  }

  async findAccommodationsInBbox(
    bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number },
    kinds: AccommodationKind[],
  ): Promise<(AccommodationPoi & StoredPoiFields)[]> {
    if (kinds.length === 0) return [];
    // Overpass bbox filter is (south, west, north, east).
    const box = `${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng}`;
    const tourismFilter = Array.from(new Set(kinds)).join('|');
    // node + way + relation: camp sites are points, hotels are buildings.
    const query =
      `[out:json][timeout:180];` +
      `(` +
      `  node["tourism"~"^(${tourismFilter})$"](${box});` +
      `  way["tourism"~"^(${tourismFilter})$"](${box});` +
      `  relation["tourism"~"^(${tourismFilter})$"](${box});` +
      `);` +
      `out center tags;`;

    const data = await this.runQuery(query, OVERPASS_IMPORT_TIMEOUT_MS);
    const pois: (AccommodationPoi & StoredPoiFields)[] = [];
    const requested = new Set<AccommodationKind>(kinds);
    for (const element of data.elements ?? []) {
      const poi = this.normalizeAccommodation(element);
      if (poi && requested.has(poi.kind)) {
        // Attach the shared decision-support columns so the offline store
        // carries the same fields for hotels as for POIs (#848). The live
        // `/accommodations` response is unchanged — it maps `AccommodationDto`
        // explicitly and ignores these extra fields.
        pois.push({ ...poi, ...extractStoredPoiFields(element.tags ?? {}) });
      }
    }
    return pois;
  }

  private async runQuery(
    query: string,
    timeoutMs: number = OVERPASS_FETCH_TIMEOUT_MS,
  ): Promise<OverpassResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // `Accept` is required by some Overpass mirrors — without it
          // the server replies 406 Not Acceptable instead of falling
          // back to JSON. `User-Agent` follows the OSM ecosystem norm
          // so abuse complaints can be routed back to us.
          Accept: 'application/json',
          'User-Agent': this.userAgent,
        },
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

  private normalizePoi(
    element: OverpassElement,
    requestedKinds: readonly PoiKind[],
  ): PointOfInterest | null {
    const tags = element.tags ?? {};
    const kind = classifyPoiTags(tags, requestedKinds);
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
 * its `amenity` / `tourism` tags.
 *
 * Dual-tagged elements (e.g. a mountaintop restaurant that is also a
 * `tourism=viewpoint`) are ambiguous. Callers pass the kinds the user
 * asked for so we can pick whichever matching kind the Overpass query
 * actually fetched the element for — otherwise a viewpoint-only query
 * would silently drop it. When no context is given, or when none of
 * the element's kinds are in `requestedKinds`, we fall back to a
 * stable default: amenity first, then tourism.
 *
 * Returns `null` for anything that doesn't map to one of our kinds —
 * guarding against amenity=bar / tourism=hotel etc. that may still show
 * up in the response.
 */
export function classifyPoiTags(
  tags: Record<string, string>,
  requestedKinds?: readonly PoiKind[],
): PoiKind | null {
  const matches: PoiKind[] = [];
  const amenity = tags.amenity;
  if (amenity === 'restaurant' || amenity === 'cafe') matches.push(amenity);
  if (amenity === 'fuel') matches.push('fuel_station');
  if (tags.tourism === 'viewpoint') matches.push('viewpoint');
  if (matches.length === 0) return null;

  if (requestedKinds && requestedKinds.length > 0) {
    // Prefer a requested kind when one matches; if several do, stick
    // to the element's own priority (amenity first) so the choice is
    // deterministic for the dedup caller and stable across requests.
    const preferred = matches.find((k) => requestedKinds.includes(k));
    if (preferred) return preferred;
    return null;
  }

  return matches[0] ?? null;
}

/**
 * Extract a one-line descriptor to render under the POI name. For
 * restaurants and cafés the `cuisine` tag is the best signal ("italian",
 * "pizza"); for viewpoints we fall back to `description` then `view_type`
 * (typical OSM tags for scenic spots); for fuel stations we prefer
 * `brand` ("Shell", "OMV") and fall back to `operator` because that's
 * what a rider actually recognises on a fuel-station sign. Normalizes
 * underscore-separated values ("fine_dining" → "fine dining") so the
 * mobile card doesn't have to do it. Strictly null-safe — the card
 * hides the row when `hint` is null.
 */
export function extractPoiHint(
  kind: PoiKind,
  tags: Record<string, string>,
): string | null {
  const raw = (() => {
    if (kind === 'viewpoint') {
      return tags.description ?? tags.view_type ?? null;
    }
    if (kind === 'fuel_station') {
      return tags.brand ?? tags.operator ?? null;
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

/** Keys kept in the stored raw-tag bag, and the max length of any value —
 * a guard so a pathological element can't bloat the JSONB row. */
const MAX_TAG_BAG_KEYS = 60;
const MAX_TAG_VALUE_LEN = 512;

/**
 * Collapse `_`/`;` separators and runs of whitespace; null when empty.
 * Mirrors the `extractPoiHint` normalization so the stored `cuisine`/`brand`
 * columns match what the mobile card renders.
 */
function normalizeTagText(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[_;]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

/**
 * Copy an OSM tag map into a stored JSONB bag, bounded so a pathological
 * element can't bloat the row: keys are sorted (deterministic) and capped,
 * and any oversized value is truncated. Null when the element has no tags.
 */
function boundedTagBag(
  tags: Record<string, string>,
): Record<string, string> | null {
  const keys = Object.keys(tags).sort();
  if (keys.length === 0) return null;
  const out: Record<string, string> = {};
  for (const key of keys.slice(0, MAX_TAG_BAG_KEYS)) {
    const value = tags[key];
    if (typeof value !== 'string') continue;
    out[key] =
      value.length > MAX_TAG_VALUE_LEN
        ? value.slice(0, MAX_TAG_VALUE_LEN)
        : value;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Extract the decision-support columns (#848) from an OSM element's tags:
 * opening hours, a split address, cuisine/brand, and a bounded raw tag bag.
 * Pure and provider-agnostic so both the POI and accommodation import paths
 * store identical columns. Every field is null when its tag is absent.
 */
export function extractStoredPoiFields(
  tags: Record<string, string>,
): StoredPoiFields {
  const street = tags['addr:street']?.trim() || null;
  const housenumber = tags['addr:housenumber']?.trim() || null;
  // A bare house number with no street is useless on a card, so only build
  // the line when a street is present; append the number when we have both.
  const address_street = street
    ? housenumber
      ? `${street} ${housenumber}`
      : street
    : null;
  const country = tags['addr:country']?.trim();
  return {
    opening_hours: tags.opening_hours?.trim() || null,
    address_street,
    address_city:
      tags['addr:city']?.trim() ||
      tags['addr:town']?.trim() ||
      tags['addr:village']?.trim() ||
      null,
    address_postcode: tags['addr:postcode']?.trim() || null,
    // `addr:country` is usually an ISO 3166-1 alpha-2 code; store only a
    // clean 2-letter value (upper-cased) so the varchar(2) column never
    // holds a full country name.
    address_country:
      country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null,
    cuisine: normalizeTagText(tags.cuisine),
    brand: normalizeTagText(tags.brand ?? tags.operator),
    tags: boundedTagBag(tags),
  };
}
