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

/** Whether a way should be imported as a road segment. */
export function isDrivableHighway(tags: OsmTags): boolean {
  const hw = tags.highway;
  if (!hw || !DRIVABLE_HIGHWAYS.has(hw)) return false;
  // Explicitly closed to motor vehicles → not a routable road for us.
  if (tags.motor_vehicle === 'no' || tags.access === 'no') return false;
  return true;
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
