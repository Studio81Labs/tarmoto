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
 * is the coverage list. Each region's authoritative scope is its **country
 * polygon** (the bundled `import-region-boundaries.geojson`), which bounds
 * **stale-by-absence** tombstoning for that region (a re-import may tombstone rows
 * inside the region's polygon that are absent from its extract, never rows
 * outside). The bbox on each region is used only by the producer's clip step;
 * import scoping is polygon-based, because adjacent countries' bboxes overlap and
 * a bbox scope would let a region tombstone a neighbour's roads (#1033). Shared
 * with the producer's region env so refresh + import target the same set; an
 * unknown code fails fast rather than being silently dropped.
 *
 * Extract contract: each `<code>.osm` is an `osmium extract -b` output using the
 * default `complete_ways` strategy — boundary-crossing ways are emitted COMPLETE
 * (extending beyond the bbox). `importRegion` filters incoming rows to the region
 * POLYGON (`filterToRegion`, a PostGIS `ST_Intersects`) and reconcile tombstones
 * only within that same polygon, so a way straddling two adjacent regions is
 * scoped to whichever country actually contains each part and its shared segment
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
