import type { SurfaceType } from '@tarmoto/shared';

/**
 * OSM tag → `road_segments` field mapping for the importer (#781). Pure, so
 * it's unit-testable without a PBF parser. The PBF/streaming layer is a
 * separate slice; this just decides "is this way a drivable road?" and
 * derives the OSM-seeded columns.
 */

export type OsmTags = Record<string, string | undefined>;

/**
 * `highway=*` values we import as drivable roads. Excludes footways, cycleways,
 * paths, etc. `track` is included (forest/agri roads riders use) but can be
 * dropped by the caller via a surface/quality filter later.
 */
const DRIVABLE_HIGHWAYS = new Set([
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'track',
]);

/**
 * OSM access keys for a motorcycle, **most-specific → least-specific**.
 * Effective access is resolved from the most-specific key that's present, so a
 * specific allow overrides a broad restriction (e.g. `access=no` +
 * `motorcycle=yes` → drivable).
 */
const ACCESS_KEYS_SPECIFIC_FIRST = [
  'motorcycle',
  'motor_vehicle',
  'vehicle',
  'access',
];

/**
 * Access values that grant an ordinary rider passage. An **allowlist** (not a
 * denylist of `no`/`private`) so restricted values like `agricultural`,
 * `forestry`, `delivery`, `customers`, `permit`, `military` are excluded too.
 * `destination` is included intentionally — those roads are reachable for
 * trips that end on them. An untagged way is open by default (most roads).
 */
const OPEN_ACCESS = new Set([
  'yes',
  'permissive',
  'designated',
  'public',
  'destination',
]);

/** Whether a way should be imported as a road segment. */
export function isDrivableHighway(tags: OsmTags): boolean {
  const hw = tags.highway;
  if (!hw || !DRIVABLE_HIGHWAYS.has(hw)) return false;
  // Resolve effective access from the most-specific key present (OSM
  // precedence), so `motorcycle=yes` re-opens a way broadly tagged `access=no`.
  for (const key of ACCESS_KEYS_SPECIFIC_FIRST) {
    const value = tags[key];
    if (value !== undefined) return OPEN_ACCESS.has(value);
  }
  return true; // no access tags → open
}

/**
 * Map the OSM `surface` tag to our coarse `SurfaceType` SEED. Overwritten
 * later by sensor-derived quality (§2) — never the other way round. Unknown /
 * untagged → `unknown`; generic `unpaved` → `gravel` (the canonical
 * not-asphalt bucket so the avoid-unpaved filter still distinguishes it).
 */
export function surfaceSeedFromTag(surface: string | undefined): SurfaceType {
  if (!surface) return 'unknown';
  switch (surface) {
    case 'asphalt':
    case 'paved':
    case 'chipseal':
    case 'tarmac':
    case 'bitumen':
      return 'asphalt';
    case 'concrete':
    case 'concrete:plates':
    case 'concrete:lanes':
      return 'concrete';
    case 'cobblestone':
    case 'sett':
    case 'paving_stones':
    case 'unhewn_cobblestone':
      return 'cobblestone';
    case 'gravel':
    case 'fine_gravel':
    case 'compacted':
    case 'pebblestone':
    case 'unpaved':
      return 'gravel';
    case 'dirt':
    case 'ground':
    case 'earth':
    case 'mud':
    case 'sand':
    case 'grass':
      return 'dirt';
    default:
      return 'unknown';
  }
}

export interface RoadSeedFields {
  road_name: string | null;
  road_number: string | null;
  surface_type: SurfaceType;
}

/** Derive the OSM-seeded `road_segments` columns from a way's tags. */
export function roadFieldsFromTags(tags: OsmTags): RoadSeedFields {
  return {
    road_name: tags.name ?? tags['name:en'] ?? null,
    road_number: tags.ref ?? null,
    surface_type: surfaceSeedFromTag(tags.surface),
  };
}
