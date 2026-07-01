import { registerAs } from '@nestjs/config';

/**
 * Config for the scheduled OSM → `road_segments` import (#781).
 *
 * `enabled` defaults to **false** so the weekly job is dormant until a
 * deployment opts in — running a full-region import in dev / CI is undesirable,
 * and (until #809 lands) imported ways would surface in best-roads / fun-zone
 * detail via a representative id.
 *
 * `filePath` points at an `.osm` XML extract the operator has prepared from a
 * Geofabrik `.osm.pbf` (`osmium cat region.osm.pbf -o region.osm`). The extract
 * itself bounds the region — there is no bbox here. Required when enabled; the
 * import throws a clear error rather than silently importing nothing.
 */
export interface OsmImportConfig {
  enabled: boolean;
  filePath: string | null;
}

export const osmImportConfig = registerAs('osmImport', (): OsmImportConfig => {
  const filePath = process.env.TARMOTO_OSM_IMPORT_FILE?.trim();
  return {
    enabled:
      (process.env.TARMOTO_OSM_IMPORT_ENABLED ?? 'false')
        .trim()
        .toLowerCase() === 'true',
    filePath: filePath ? filePath : null,
  };
});
