import { ACCOMMODATION_KINDS, type AccommodationKind } from "@tarmoto/shared";

/**
 * The pure, DB-free OSM-tag → `pois` row mapping (#850). Factored out of
 * `overpass.provider.ts` so both import sources — the live Overpass fetch and
 * the streaming `.osm` extract (`poi-extract-source.ts`) — share one classifier
 * and produce byte-for-byte identical rows. No NestJS, no I/O; every function
 * takes a plain tag map or a normalized element and returns a row shape.
 *
 * A "normalized element" is the source-agnostic input both paths reduce to: an
 * OSM type + id, a single representative point (Overpass `out center` for
 * ways/relations; a computed centroid for extract ways), and the raw tag bag.
 */
export interface OsmPoiElement {
  osmType: "node" | "way" | "relation";
  osmId: number | string;
  lat: number;
  lng: number;
  tags: Record<string, string>;
}

/**
 * Normalized accommodation POI returned by any provider.
 * All providers must map their external response to this shape. Carries the
 * shared `StoredPoiFields` decision-support columns (#849) so the live
 * `/accommodations` response can surface opening hours + address, not just
 * name / distance.
 *
 * Lives here (rather than the backend's `poi-provider.interface.ts`) because
 * this is where it — and `ImportedPoi` / `StoredPoiFields` below — are
 * actually constructed (`toAccommodationPoi` et al.); the backend re-exports
 * them from `@tarmoto/ingest` so its existing consumers are unaffected.
 */
export interface AccommodationPoi extends StoredPoiFields {
  external_id: string;
  name: string | null;
  kind: AccommodationKind;
  lat: number;
  lng: number;
  website: string | null;
  phone: string | null;
  stars: number | null;
}

/**
 * Decision-support fields captured from OSM tags and stored on every `pois`
 * row (#848). Kept as a distinct shape so both the POI and accommodation
 * import paths carry the same columns without widening the live read DTOs
 * (`PoiDto` / `AccommodationDto`), which only surface these from Phase 1 on.
 * Everything is nullable — OSM coverage of these tags is uneven.
 */
export interface StoredPoiFields {
  /** Raw OSM `opening_hours` expression, e.g. `Mo-Su 09:00-18:00`. */
  opening_hours: string | null;
  /** Street line: `addr:street` (+ `addr:housenumber` when present). */
  address_street: string | null;
  /** `addr:city`, falling back to `addr:town` / `addr:village` (rural POIs). */
  address_city: string | null;
  address_postcode: string | null;
  /** Upper-case ISO 3166-1 alpha-2 country, or null if not a 2-letter code. */
  address_country: string | null;
  /** Normalized cuisine (restaurants / cafés), e.g. `italian`. */
  cuisine: string | null;
  /** Brand, falling back to operator (fuel chains, franchises). */
  brand: string | null;
  /** Bounded raw OSM tag bag for future enrichment; null when empty. */
  tags: Record<string, string> | null;
}

/**
 * A POI fetched by the offline import (#745). Distinct from the backend's
 * live-query `PointOfInterest` because the storage tag set (§7) is a
 * **superset** of the live `PoiKind` enum — it also covers `fast_food`,
 * `rest_area`, and `ice_cream`, which aren't live `/poi` categories. `kind` is
 * therefore a free-form string written straight to `pois.kind`, decoupled from
 * the live API so widening the store never changes the read enum. Carries the
 * `StoredPoiFields` decision-support columns (#848).
 */
export interface ImportedPoi extends StoredPoiFields {
  external_id: string;
  name: string | null;
  kind: string;
  lat: number;
  lng: number;
  website: string | null;
  phone: string | null;
}

/**
 * The §7 storage tag set for the offline import (#745) — a **superset** of
 * the live `POI_KIND_TAGS` that also covers `fast_food`, rest areas, and
 * ice cream. Decoupled from `PoiKind` on purpose: these `kind` strings are
 * written straight to `pois.kind` and must not change the live `/poi`
 * enum. Order matters — the first matching entry wins in
 * {@link classifyImportPoiKind}, so a dual-tagged element gets a stable
 * category. `highway=rest_area` and `highway=services` both map to `rest_area`.
 */
export const IMPORT_POI_TAGS: ReadonlyArray<{
  key: string;
  value: string;
  kind: string;
}> = [
  { key: "amenity", value: "restaurant", kind: "restaurant" },
  { key: "amenity", value: "cafe", kind: "cafe" },
  { key: "amenity", value: "fast_food", kind: "fast_food" },
  { key: "amenity", value: "fuel", kind: "fuel_station" },
  { key: "amenity", value: "ice_cream", kind: "ice_cream" },
  { key: "shop", value: "ice_cream", kind: "ice_cream" },
  { key: "tourism", value: "viewpoint", kind: "viewpoint" },
  { key: "highway", value: "rest_area", kind: "rest_area" },
  { key: "highway", value: "services", kind: "rest_area" },
];

/** The accommodation `tourism=*` values we store — sourced from the live
 * `ACCOMMODATION_KINDS` contract so offline hotels/campsites can't diverge
 * from `/accommodations`. */
const ACCOMMODATION_KIND_SET = new Set<string>(ACCOMMODATION_KINDS);

/**
 * Which of the §7 import kinds an element carries, or null. The first matching
 * {@link IMPORT_POI_TAGS} entry wins, so a dual-tagged element (e.g.
 * `amenity=fuel` + `highway=services`) gets the earlier, higher-priority
 * category deterministically.
 */
export function classifyImportPoiKind(
  tags: Record<string, string>,
): string | null {
  const match = IMPORT_POI_TAGS.find((t) => tags[t.key] === t.value);
  return match ? match.kind : null;
}

/** The accommodation kind an element's `tourism` tag maps to, or null when it
 *  is absent / not one of `ACCOMMODATION_KINDS`. */
export function matchAccommodationKind(
  tags: Record<string, string>,
): AccommodationKind | null {
  const tourism = tags.tourism;
  if (!tourism || !ACCOMMODATION_KIND_SET.has(tourism)) return null;
  return tourism as AccommodationKind;
}

/**
 * Build an {@link ImportedPoi} from a normalized element, or null when its
 * tags don't match the §7 storage set. The point is trusted (the caller
 * resolves it), so this only decides the kind and assembles the row.
 */
export function toImportedPoi(el: OsmPoiElement): ImportedPoi | null {
  const kind = classifyImportPoiKind(el.tags);
  if (kind === null) return null;
  const tags = el.tags;
  return {
    external_id: `osm:${el.osmType}:${el.osmId}`,
    name: tags.name ?? tags["name:en"] ?? null,
    kind,
    lat: el.lat,
    lng: el.lng,
    website: tags.website ?? tags["contact:website"] ?? null,
    phone: tags.phone ?? tags["contact:phone"] ?? null,
    ...extractStoredPoiFields(tags),
  };
}

/**
 * Build an {@link AccommodationPoi} from a normalized element, or null when its
 * `tourism` tag isn't one of `ACCOMMODATION_KINDS`. Carries `stars` and the
 * shared `StoredPoiFields`, so the offline store keeps the same columns for
 * hotels as for POIs (#848).
 */
export function toAccommodationPoi(el: OsmPoiElement): AccommodationPoi | null {
  const kind = matchAccommodationKind(el.tags);
  if (kind === null) return null;
  const tags = el.tags;
  return {
    external_id: `osm:${el.osmType}:${el.osmId}`,
    name: tags.name ?? tags["name:en"] ?? null,
    kind,
    lat: el.lat,
    lng: el.lng,
    website: tags.website ?? tags["contact:website"] ?? null,
    phone: tags.phone ?? tags["contact:phone"] ?? null,
    stars: parseStarsTag(tags.stars),
    ...extractStoredPoiFields(tags),
  };
}

/**
 * Classify one normalized OSM element into the row the offline import stores:
 * an accommodation, a POI, or null (no match).
 *
 * **Accommodation wins over a co-tagged POI.** The Overpass import path fetches
 * POIs (`findImportPoisInBbox`) and accommodations (`findAccommodationsInBbox`)
 * in two separate queries, then `PoiImportService` dedupes them by
 * `external_id` in a Map with the accommodations added **last** — so an element
 * tagged both (e.g. a hotel with a restaurant) lands in `pois` as the hotel
 * row. The single-pass extract sees that element once, so this reproduces the
 * same precedence to keep the stored row byte-for-byte identical.
 */
export function mapOsmElementToPoi(
  el: OsmPoiElement,
): { poi: ImportedPoi } | { accommodation: AccommodationPoi } | null {
  const accommodation = toAccommodationPoi(el);
  if (accommodation) return { accommodation };
  const poi = toImportedPoi(el);
  if (poi) return { poi };
  return null;
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
 * The OSM tag keys the classifier keys off (`amenity` / `tourism`), derived from
 * {@link IMPORT_POI_TAGS} so it stays in sync. These MUST survive the tag-bag
 * cap: the store read's secondary-kind match (#926) tests `tags @> {key:value}`,
 * and `tourism` in particular sorts late alphabetically, so on a heavily-tagged
 * element (many `addr:*`/`contact:*`/`name:*` keys) it would otherwise be
 * truncated — dropping a dual-tagged element from a secondary-kind request.
 */
const CLASSIFIER_TAG_KEYS: readonly string[] = Array.from(
  new Set(IMPORT_POI_TAGS.map((t) => t.key)),
);

/**
 * Collapse `_`/`;` separators and runs of whitespace; null when empty.
 * Mirrors the `extractPoiHint` normalization so the stored `cuisine`/`brand`
 * columns match what the mobile card renders.
 */
function normalizeTagText(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[_;]/g, " ").replace(/\s+/g, " ").trim();
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
  // Put the classifier keys first so the cap can never drop them, then fill the
  // remaining budget with the sorted rest (#926 review).
  const ordered = [
    ...CLASSIFIER_TAG_KEYS.filter((key) => Object.hasOwn(tags, key)),
    ...keys.filter((key) => !CLASSIFIER_TAG_KEYS.includes(key)),
  ];
  const out: Record<string, string> = {};
  for (const key of ordered.slice(0, MAX_TAG_BAG_KEYS)) {
    const value = tags[key];
    if (typeof value !== "string") continue;
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
  const street = tags["addr:street"]?.trim() || null;
  const housenumber = tags["addr:housenumber"]?.trim() || null;
  // A bare house number with no street is useless on a card, so only build
  // the line when a street is present; append the number when we have both.
  const address_street = street
    ? housenumber
      ? `${street} ${housenumber}`
      : street
    : null;
  const country = tags["addr:country"]?.trim();
  return {
    opening_hours: tags.opening_hours?.trim() || null,
    address_street,
    address_city:
      tags["addr:city"]?.trim() ||
      tags["addr:town"]?.trim() ||
      tags["addr:village"]?.trim() ||
      null,
    address_postcode: tags["addr:postcode"]?.trim() || null,
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
