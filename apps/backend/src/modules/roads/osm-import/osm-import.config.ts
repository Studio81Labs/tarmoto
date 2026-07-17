import { registerAs } from '@nestjs/config';
import { parseRegions, type PoiImportRegion } from '@tarmoto/ingest';

/**
 * Config for the scheduled OSM → `road_segments` import (#781, folder model in
 * Sub-project B).
 *
 * `enabled` defaults to **false** so the weekly job is dormant until a
 * deployment opts in.
 *
 * `extractDir` (`TARMOTO_OSM_ROAD_IMPORT_DIR`) is the folder of per-region
 * `<code>.osm` extracts the ingest producer (`refresh-road-extracts`) writes — the
 * SAME shared volume, read here. `null` when unset; the importer skips (nothing
 * to read). The importer reads `<extractDir>/<code>.osm` for each region.
 *
 * `regions` (`TARMOTO_OSM_ROAD_IMPORT_REGIONS`, default all `DEFAULT_REGIONS`)
 * is the coverage list. Each region carries its authoritative bbox, which bounds
 * **stale-by-absence** tombstoning for that region (a re-import may tombstone rows
 * inside the region's bbox that are absent from its extract, never rows outside).
 * Shared with the producer's region env so refresh + import target the same set;
 * an unknown code fails fast rather than being silently dropped.
 *
 * Extract contract: each `<code>.osm` is an `osmium extract -b` output using the
 * default `complete_ways` strategy — boundary-crossing ways are emitted COMPLETE
 * (extending beyond the bbox). The importer's `reconcile()` filters incoming rows
 * to the region bbox (`intersectsRegion`) and tombstones only within it, so a way
 * straddling two adjacent regions is scoped correctly and its shared segment
 * upserts idempotently. (This replaces the old single-file "clip to exactly this
 * rectangle" contract.)
 */
export interface RoadImportConfig {
  enabled: boolean;
  extractDir: string | null;
  regions: PoiImportRegion[];
}

export const osmRoadImportConfig = registerAs(
  'osmRoadImport',
  (): RoadImportConfig => {
    const extractDir = process.env.TARMOTO_OSM_ROAD_IMPORT_DIR?.trim();
    return {
      enabled:
        (process.env.TARMOTO_OSM_ROAD_IMPORT_ENABLED ?? 'false')
          .trim()
          .toLowerCase() === 'true',
      extractDir: extractDir ? extractDir : null,
      regions: parseRegions(
        process.env.TARMOTO_OSM_ROAD_IMPORT_REGIONS,
        'TARMOTO_OSM_ROAD_IMPORT_REGIONS',
      ),
    };
  },
);
