import { registerAs } from '@nestjs/config';
import {
  parseRegions,
  resolveTileSpanDeg,
  type PoiImportRegion,
} from '@tarmoto/ingest';

/**
 * Config for the scheduled OSM → `road_segments` import (#781, folder model in
 * Sub-project B).
 *
 * `enabled` defaults to **false** so the weekly job is dormant until a
 * deployment opts in.
 *
 * `extractDir` (`TARMOTO_OSM_ROAD_IMPORT_DIR`) is the folder of per-tile
 * `<code>-r<row>c<col>.osm` extracts the ingest producer (`refresh-road-extracts`)
 * writes — the SAME shared volume, read here. `null` when unset; the importer
 * skips (nothing to read). The importer subdivides each region into the same tile
 * grid and reads `<extractDir>/<code>-r<row>c<col>.osm` per tile.
 *
 * `regions` (`TARMOTO_OSM_ROAD_IMPORT_REGIONS`, default all `DEFAULT_REGIONS`)
 * is the coverage list. Each region's authoritative scope is its **country
 * polygon** (the bundled `import-region-boundaries.geojson`) intersected with the
 * **tile bbox** currently being imported, which bounds **stale-by-absence**
 * tombstoning to that tile's cell of that region (a re-import may tombstone rows
 * inside the polygon ∩ tile bbox that are absent from that tile's extract, never
 * rows outside). The region bbox drives the producer's clip + the tile grid;
 * import scoping is polygon-∩-bbox, because adjacent countries' bboxes overlap and
 * a bare-bbox scope would let a region tombstone a neighbour's roads (#1033).
 * Shared with the producer's region env so refresh + import target the same set;
 * an unknown code fails fast rather than being silently dropped.
 *
 * Extract contract: each region's coverage is produced as a grid of per-tile
 * `<code>-r<row>c<col>.osm` files (`subdivideRegion`, shared with the producer),
 * each an `osmium extract -b` output using the default `complete_ways` strategy —
 * boundary-crossing ways are emitted COMPLETE (extending beyond the tile bbox).
 * `importRegion` subdivides the region into the SAME tiles and, per tile, filters
 * incoming rows to the country POLYGON ∩ the tile bbox (`filterToRegion`, a PostGIS
 * `ST_Intersects` pair) and reconcile tombstones only within that same
 * polygon-∩-bbox scope, so a way straddling two adjacent regions (or tiles) is
 * scoped to whichever country/tile actually contains each part and its shared
 * segment upserts idempotently. (This replaces the old single-file "clip to
 * exactly this rectangle" contract.)
 *
 * `tileSpanDeg` (`TARMOTO_OSM_ROAD_TILE_SPAN_DEG`, default 2.5) is the max tile
 * span the importer subdivides each region by. It MUST match the producer's value
 * (both call `subdivideRegion` with it), or the importer would look for tile files
 * the producer never wrote.
 */
export interface RoadImportConfig {
  enabled: boolean;
  extractDir: string | null;
  regions: PoiImportRegion[];
  tileSpanDeg: number;
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
      tileSpanDeg: resolveTileSpanDeg(process.env),
    };
  },
);
