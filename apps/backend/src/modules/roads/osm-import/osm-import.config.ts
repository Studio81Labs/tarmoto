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
 * Geofabrik `.osm.pbf` (`osmium cat region.osm.pbf -o region.osm`). Required when
 * enabled; the import throws a clear error rather than silently importing nothing.
 *
 * `bbox` is the extract's authoritative boundary `[minLng, minLat, maxLng, maxLat]`
 * (TARMOTO_OSM_ROAD_IMPORT_BBOX="minLng,minLat,maxLng,maxLat"). It gates
 * **stale-by-absence** tombstoning (#835): a data-derived bbox (the extent of the
 * incoming roads) would wrongly tombstone existing rows that fall in the rectangle
 * but outside the extract, and miss removed roads beyond the current roads'
 * extrema. When it is unset the importer does NOT tombstone rows just for being
 * absent from the snapshot — it can't tell "removed" from "outside this extract".
 * (A row whose exact `(osm_way_id, segment_index)` the snapshot reassigns to a
 * DIFFERENT road is still deactivated even without a region: that's definitive key
 * reuse, not a bbox heuristic.)
 *
 * IMPORTANT: the `.osm` extract MUST be **bbox-clipped to exactly this rectangle**
 * (`osmium extract -b minLng,minLat,maxLng,maxLat …`), so the extract's coverage
 * equals the region. A polygon (e.g. raw Geofabrik) extract whose shape is smaller
 * than the rectangle would leave neighbouring roads inside the bbox but absent
 * from the file, and stale detection would wrongly tombstone them. See the module
 * README.
 */
export interface RoadImportConfig {
  enabled: boolean;
  filePath: string | null;
  bbox: [number, number, number, number] | null;
}

function parseBbox(
  raw: string | undefined,
): [number, number, number, number] | null {
  if (!raw?.trim()) return null;
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(
      `TARMOTO_OSM_ROAD_IMPORT_BBOX must be "minLng,minLat,maxLng,maxLat", got "${raw}"`,
    );
  }
  const [minLng, minLat, maxLng, maxLat] = parts as [
    number,
    number,
    number,
    number,
  ];
  if (minLng > maxLng || minLat > maxLat) {
    throw new Error(
      `TARMOTO_OSM_ROAD_IMPORT_BBOX min must not exceed max, got "${raw}"`,
    );
  }
  return [minLng, minLat, maxLng, maxLat];
}

export const osmRoadImportConfig = registerAs(
  'osmRoadImport',
  (): RoadImportConfig => {
    const filePath = process.env.TARMOTO_OSM_ROAD_IMPORT_FILE?.trim();
    return {
      enabled:
        (process.env.TARMOTO_OSM_ROAD_IMPORT_ENABLED ?? 'false')
          .trim()
          .toLowerCase() === 'true',
      filePath: filePath ? filePath : null,
      bbox: parseBbox(process.env.TARMOTO_OSM_ROAD_IMPORT_BBOX),
    };
  },
);
