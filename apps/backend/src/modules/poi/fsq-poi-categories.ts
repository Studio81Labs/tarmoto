import type { StorableImportRow } from './poi-import-source.js';

/**
 * Foursquare OS Places → our store `kind` (#869). Keyed on category **labels**
 * (the offline recipe emits `fsq_category_labels` joined) rather than the opaque
 * category IDs: the leaf labels we match on are readable and stable, keeping
 * this map reviewable. It produces the SAME `kind` vocabulary as the OSM
 * importer (`osm-poi-tags.ts`) — the store POI kinds plus the accommodation
 * kinds — so both sources land identical `pois.kind` values.
 *
 * Rule order = specificity (specific food beats the generic restaurant; lodging
 * kinds are distinct). A place's categories are checked in **FSQ order** (its
 * primary category first), so the primary categorisation decides — a restaurant
 * inside a hotel, listed with primary "Restaurant", classifies as `restaurant`;
 * a venue whose primary is "Hotel" classifies as `hotel`.
 */
/**
 * A label rule: match `alternation` as a whole word, with Unicode-aware
 * boundaries (`\p{L}` lookarounds, not JS's ASCII `\b`) so accented leaves like
 * "Café" match while short keywords like "inn" don't fire inside "Dinner".
 */
function labelRule(
  alternation: string,
  kind: string,
): { readonly match: RegExp; readonly kind: string } {
  return {
    match: new RegExp(`(?<!\\p{L})(?:${alternation})(?!\\p{L})`, 'iu'),
    kind,
  };
}

const FSQ_KIND_RULES: readonly {
  readonly match: RegExp;
  readonly kind: string;
}[] = [
  labelRule('motel', 'motel'),
  labelRule('hostel', 'hostel'),
  labelRule('bed and breakfast|b&b|guest\\s?house|inn', 'guest_house'),
  labelRule(
    'vacation rental|holiday (?:home|rental)|cottage|chalet|cabin',
    'chalet',
  ),
  labelRule('(?:serviced )?apartment', 'apartment'),
  labelRule('campground|camp\\s?site|rv park|caravan', 'camp_site'),
  labelRule('hotel|resort', 'hotel'),
  labelRule(
    'gas station|petrol station|fuel station|ev charging|charging station',
    'fuel_station',
  ),
  labelRule('rest area', 'rest_area'),
  labelRule('fast food', 'fast_food'),
  labelRule('ice cream', 'ice_cream'),
  labelRule('caf[eé]|coffee shop|coffee house|tea (?:room|house)', 'cafe'),
  labelRule('scenic lookout|scenic viewpoint|viewpoint|overlook', 'viewpoint'),
  labelRule('restaurant', 'restaurant'),
];

/**
 * Classify a place's FSQ category labels (in FSQ order) to a store `kind`, or
 * null when none map to a category we serve. Returns the kind of the first
 * (highest-priority) category that matches any rule.
 */
export function classifyFsqKind(
  categoryLabels: readonly string[],
): string | null {
  for (const label of categoryLabels) {
    for (const rule of FSQ_KIND_RULES) {
      if (rule.match.test(label)) return rule.kind;
    }
  }
  return null;
}

/**
 * One normalized FSQ OS Places row as the offline DuckDB recipe emits it: the
 * FSQ arrays (`fsq_category_ids` / `fsq_category_labels`) are joined to
 * comma-delimited strings so the backend Parquet reader stays scalar-only.
 */
export interface FsqPlaceRow {
  fsq_place_id: string;
  name: string | null;
  latitude: number;
  longitude: number;
  /** Comma-joined `fsq_category_ids` — stable provenance, kept in `tags`. */
  category_ids: string | null;
  /** Comma-joined `fsq_category_labels` — the classification input. */
  category_labels: string | null;
  tel: string | null;
  website: string | null;
  address: string | null;
  locality: string | null;
  postcode: string | null;
  /** ISO 3166-1 alpha-2 (FSQ already emits this). */
  country: string | null;
}

function splitList(value: string | null): string[] {
  return value
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

function nonEmpty(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Upper-case ISO 3166-1 alpha-2, or null if not a 2-letter code. */
function normalizeCountry(value: string | null): string | null {
  const trimmed = value?.trim().toUpperCase();
  return trimmed && /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}

/**
 * Map an FSQ OS Places row to the importer's normalized row, or null when it is
 * not a category we serve or lacks a valid id / coordinate. OS Places carries
 * no opening hours, cuisine, brand, or ratings — those stay null (ratings are
 * the on-demand commercial API, #851). The stable `fsq_category_ids` are kept
 * in `tags` for provenance + future reclassification.
 */
export function fsqRowToImportRow(row: FsqPlaceRow): StorableImportRow | null {
  if (!row.fsq_place_id) return null;
  if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) {
    return null;
  }
  const kind = classifyFsqKind(splitList(row.category_labels));
  if (kind === null) return null;
  const categoryIds = nonEmpty(row.category_ids);
  return {
    external_id: `fsq:${row.fsq_place_id}`,
    kind,
    name: nonEmpty(row.name),
    website: nonEmpty(row.website),
    phone: nonEmpty(row.tel),
    lat: row.latitude,
    lng: row.longitude,
    opening_hours: null,
    address_street: nonEmpty(row.address),
    address_city: nonEmpty(row.locality),
    address_postcode: nonEmpty(row.postcode),
    address_country: normalizeCountry(row.country),
    cuisine: null,
    brand: null,
    stars: null,
    tags: categoryIds ? { fsq_category_ids: categoryIds } : null,
  };
}
