import { resolve } from "node:path";
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

/**
 * `highway=*` classes GraphHopper's (10.2) car parser routes but that we do NOT
 * import into `road_segments`: `road` — the "unknown classification" tag. It's
 * routable upstream (in `highwayValues` + `defaultSpeedMap`), so omitting it from
 * the GraphHopper input drops any corridor that relies on it; but it carries no
 * meaningful road class, so it's not a quality candidate for `road_segments`.
 */
const ROUTING_ONLY_HIGHWAYS: readonly string[] = ["road"];

/**
 * `osmium tags-filter` expressions for the ROUTING extract (the GraphHopper import
 * + conflation input) — every `highway=*` GraphHopper routes (the drivable set
 * PLUS {@link ROUTING_ONLY_HIGHWAYS}) AND `route=ferry` ways, which GraphHopper
 * routes over (a car/motorcycle route can legitimately need a vehicle ferry).
 * Deliberately a SUPERSET of {@link ROAD_TAGS_FILTER_EXPRESSIONS}: the road TILES
 * (→ `road_segments`) exclude ferries and `road` (no surface quality there), so
 * the routing extract uses its own filter rather than the tiles' one.
 */
export const ROUTING_TAGS_FILTER_EXPRESSIONS: readonly string[] = [
  `w/highway=${[...DRIVABLE_HIGHWAYS, ...ROUTING_ONLY_HIGHWAYS].join(",")}`,
  "w/route=ferry",
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
 * Fail fast if `TARMOTO_OSM_ROAD_ROUTING_DIR` (the whole-network routing extract's
 * `<code>.osm` dir) collides with either dir that ALSO writes `<code>.osm`: the
 * road TILE dir (`TARMOTO_OSM_ROAD_IMPORT_DIR`) or the OSM POI extract dir
 * (`TARMOTO_OSM_POI_IMPORT_DIR`). A shared dir lets one producer's `<code>.osm`
 * clobber the other's — e.g. a road refresh overwriting the POI `cz.osm`, then the
 * next POI import re-tombstoning against the wrong file.
 *
 * Called from BOTH refresh-config resolvers ({@link resolveRoadRefreshConfig} and
 * `resolvePoiRefreshConfig`) so the guard fires no matter which scheduled task
 * runs first: the road producer is not the only writer of `<code>.osm`, so a
 * road-side-only check would miss a POI refresh scheduled ahead of any road one.
 * Compares RESOLVED paths so a trailing slash / `.` / `..` spelling
 * (`/data/routing` vs `/data/routing/`) can't slip past.
 */
export function assertRoutingDirDistinct(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const routing = env.TARMOTO_OSM_ROAD_ROUTING_DIR?.trim();
  if (!routing) return;
  const routingResolved = resolve(routing);
  const clash = (
    [
      ["TARMOTO_OSM_ROAD_IMPORT_DIR", env.TARMOTO_OSM_ROAD_IMPORT_DIR?.trim()],
      ["TARMOTO_OSM_POI_IMPORT_DIR", env.TARMOTO_OSM_POI_IMPORT_DIR?.trim()],
    ] as const
  ).find(
    ([, value]) =>
      value !== undefined && value !== "" && resolve(value) === routingResolved,
  );
  if (clash) {
    throw new Error(
      `TARMOTO_OSM_ROAD_ROUTING_DIR (${routing}) must differ from ${clash[0]} ` +
        `— the routing extract writes <code>.osm and would collide with that directory.`,
    );
  }
}

/**
 * Resolve the road refresh config from the environment — standalone (no Nest
 * DI), so the refresh container needn't boot the app. Mirrors
 * `resolvePoiRefreshConfig` but for the road source's env (`TARMOTO_OSM_ROAD_*`).
 */
export function resolveRoadRefreshConfig(
  env: NodeJS.ProcessEnv = process.env,
): RoadRefreshConfig {
  assertRoutingDirDistinct(env);
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
