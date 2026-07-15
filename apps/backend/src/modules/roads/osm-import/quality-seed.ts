import type { QualitySource } from '@tarmoto/shared';
import type { OsmTags } from './osm-tags.js';

/**
 * Prior weight `k` for the OSM-seed ↔ rider-data confidence blend
 * (design 2026-07-15): `effective = (rider_mean·n + seed·k)/(n+k)`. ~4 rider
 * reports reach a 50/50 blend. SOURCE OF TRUTH is the SQL literal in
 * `update_road_quality_for_segment` (migration 1811000000000); this mirror
 * exists for the TS blend reference + tests and MUST stay in sync with it.
 */
export const QUALITY_SEED_PRIOR_WEIGHT = 4;

export interface QualitySeed {
  /** Seeded quality in [1,5], or null when no OSM signal matched. */
  score: number | null;
  /** Which OSM signal produced `score`, or null. */
  source: QualitySource | null;
}

/** OSM `smoothness` → [1,5] (inverse of ADR-0005; worse tiers clamp to 1). */
const SMOOTHNESS_SEED: Readonly<Record<string, number>> = {
  excellent: 5,
  good: 4,
  intermediate: 3,
  bad: 2,
  very_bad: 1,
  horrible: 1,
  very_horrible: 1,
  impassable: 1,
};

/** OSM `surface` → [1,5] (material as a quality proxy). */
const SURFACE_SEED: Readonly<Record<string, number>> = {
  asphalt: 4,
  concrete: 4,
  'concrete:plates': 4,
  paving_stones: 4,
  chipseal: 4,
  sett: 3,
  cobblestone: 3,
  compacted: 3,
  fine_gravel: 3,
  metal: 3,
  wood: 3,
  gravel: 2,
  pebblestone: 2,
  ground: 2,
  dirt: 2,
  earth: 2,
  unpaved: 2,
  sand: 1,
  mud: 1,
  grass: 1,
  clay: 1,
};

/** Own-property lookup — OSM tag values are untrusted, so a key that matches an
 *  Object.prototype member (constructor, __proto__, toString, …) must miss, not
 *  return the inherited member. */
function ownSeed(
  table: Readonly<Record<string, number>>,
  key: string | undefined,
): number | undefined {
  return key !== undefined && Object.hasOwn(table, key)
    ? table[key]
    : undefined;
}

/** OSM `highway` class → [1,5] (weak proxy; `_link` normalised to its base). */
function highwaySeed(highway: string | undefined): number | null {
  if (!highway) return null;
  const base = highway.replace(/_link$/, '');
  switch (base) {
    case 'motorway':
    case 'trunk':
    case 'primary':
    case 'secondary':
      return 4;
    case 'tertiary':
    case 'unclassified':
    case 'residential':
    case 'living_street':
    case 'service':
    case 'road':
      return 3;
    case 'track':
      return 2;
    default:
      return null;
  }
}

/**
 * Derive a road segment's OSM quality seed from a way's tags. Precedence:
 * `smoothness` → `surface` → `highway`, first hit wins; `{null,null}` when none
 * match. Pure; the DB blend + the importer decide how the seed coexists with
 * rider data (design 2026-07-15).
 */
export function qualitySeedFromTags(tags: OsmTags): QualitySeed {
  const sm = ownSeed(SMOOTHNESS_SEED, tags.smoothness);
  if (sm !== undefined) return { score: sm, source: 'osm_smoothness' };

  const su = ownSeed(SURFACE_SEED, tags.surface);
  if (su !== undefined) return { score: su, source: 'osm_surface' };

  const hw = highwaySeed(tags.highway);
  if (hw !== null) return { score: hw, source: 'osm_highway' };

  return { score: null, source: null };
}
