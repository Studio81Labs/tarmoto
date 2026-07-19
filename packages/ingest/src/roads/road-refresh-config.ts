import { parseRegions, type PoiImportRegion } from "../poi/regions.js";
import { DRIVABLE_HIGHWAYS } from "./road-tags.js";
import { resolveTileSpanDeg } from "./road-tiles.js";

/**
 * `osmium tags-filter` expression for the road-extract producer — WAYS whose
 * `highway` is a drivable class (osmium ORs the comma-separated values within
 * one `key=v1,v2,…`). Built from {@link DRIVABLE_HIGHWAYS} so it stays a
 * superset of the importer's gate. `w/` = ways only.
 */
export const ROAD_TAGS_FILTER_EXPRESSIONS: readonly string[] = [
  `w/highway=${DRIVABLE_HIGHWAYS.join(",")}`,
];

function boolEnv(value: string | undefined): boolean {
  return (value ?? "false").trim().toLowerCase() === "true";
}

export interface RoadRefreshConfig {
  /** Gate — off unless `TARMOTO_OSM_ROAD_REFRESH_ENABLED=true`. */
  enabled: boolean;
  /**
   * Directory the fresh `<code>.osm` files are written to — the SAME
   * `TARMOTO_OSM_ROAD_IMPORT_DIR` the backend importer reads. `null` when unset
   * (the script fails fast: nowhere to write). MUST differ from the POI import
   * dir, or POI + road `<code>.osm` files would collide.
   */
  targetDir: string | null;
  /**
   * Directory the whole-network drivable `<code>.osm` **routing extract** is
   * written to (`TARMOTO_OSM_ROAD_ROUTING_DIR`) — the file GraphHopper imports
   * and the quality conflation tags (a single per-region `.osm`, NOT the tiled
   * `road-extracts`). Written from the SAME filtered PBF the tiles come from, so
   * it's drivable-sized and nearly free. `null` when unset → the routing extract
   * is skipped (tiles still produced). MUST differ from `targetDir` (the tiles)
   * and the POI dir.
   */
  routingDir: string | null;
  /**
   * Regions to refresh: `DEFAULT_REGIONS` narrowed by
   * `TARMOTO_OSM_ROAD_IMPORT_REGIONS` (default all). Shares the importer's region
   * env so refresh and import always target the same set; an unknown code fails
   * fast rather than being silently dropped.
   */
  regions: readonly PoiImportRegion[];
  /**
   * Max tile span in degrees, from `TARMOTO_OSM_ROAD_TILE_SPAN_DEG` (default
   * `TILE_MAX_SPAN_DEG_DEFAULT`). Shared with the importer so both sides derive
   * the identical `subdivideRegion` grid — the producer needs it to know how to
   * split each region into per-tile extracts.
   */
  tileSpanDeg: number;
}

/**
 * Resolve the road refresh config from the environment — standalone (no Nest
 * DI), so the refresh container needn't boot the app. Mirrors
 * `resolvePoiRefreshConfig` but for the road source's env (`TARMOTO_OSM_ROAD_*`).
 */
export function resolveRoadRefreshConfig(
  env: NodeJS.ProcessEnv = process.env,
): RoadRefreshConfig {
  const dir = env.TARMOTO_OSM_ROAD_IMPORT_DIR?.trim();
  const routing = env.TARMOTO_OSM_ROAD_ROUTING_DIR?.trim();
  return {
    enabled: boolEnv(env.TARMOTO_OSM_ROAD_REFRESH_ENABLED),
    targetDir: dir ? dir : null,
    routingDir: routing ? routing : null,
    regions: parseRegions(
      env.TARMOTO_OSM_ROAD_IMPORT_REGIONS,
      "TARMOTO_OSM_ROAD_IMPORT_REGIONS",
    ),
    tileSpanDeg: resolveTileSpanDeg(env),
  };
}
