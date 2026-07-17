import type { PoiImportRegion } from "../poi/regions.js";

/** Max tile span (degrees) — bounds one tile's road count to fit the import
 *  worker heap. A region wider/taller than this is split into a grid of cells
 *  each ≤ this span. Tunable at enablement per country density. */
export const TILE_MAX_SPAN_DEG_DEFAULT = 2.5;

/** Resolve the tile span from `TARMOTO_OSM_ROAD_TILE_SPAN_DEG` (shared by the
 *  producer + importer so both derive the identical grid). Invalid/≤0 → throw
 *  (a silent wrong span would desync the two sides). Unset → the default. */
export function resolveTileSpanDeg(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.TARMOTO_OSM_ROAD_TILE_SPAN_DEG?.trim();
  if (!raw) return TILE_MAX_SPAN_DEG_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `TARMOTO_OSM_ROAD_TILE_SPAN_DEG must be a positive number, got "${raw}"`,
    );
  }
  return n;
}

export interface RoadTile {
  code: string; // region ISO-2
  row: number; // 0-based
  col: number; // 0-based
  bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number };
}

/**
 * Split a region's bbox into a deterministic, NON-OVERLAPPING grid of cells,
 * each with span ≤ `spanDeg`, exactly covering the region bbox. A region that
 * already fits `spanDeg` in both axes yields a single 1×1 tile (== the region
 * bbox). Adjacent cells share an edge (a segment exactly on the seam intersects
 * both cells → imported by both idempotently, like a country border). Producer
 * and importer both call this, so their tile sets are identical.
 */
export function subdivideRegion(
  region: PoiImportRegion,
  spanDeg: number,
): RoadTile[] {
  const { minLng, minLat, maxLng, maxLat } = region.bbox;
  const cols = Math.max(1, Math.ceil((maxLng - minLng) / spanDeg));
  const rows = Math.max(1, Math.ceil((maxLat - minLat) / spanDeg));
  const cellW = (maxLng - minLng) / cols;
  const cellH = (maxLat - minLat) / rows;
  const tiles: RoadTile[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({
        code: region.code,
        row: r,
        col: c,
        bbox: {
          minLng: minLng + c * cellW,
          minLat: minLat + r * cellH,
          // Pin the last row/col to the exact region edge (no float drift gap).
          maxLng: c === cols - 1 ? maxLng : minLng + (c + 1) * cellW,
          maxLat: r === rows - 1 ? maxLat : minLat + (r + 1) * cellH,
        },
      });
    }
  }
  return tiles;
}

/** Per-tile extract filename: `<code>-r<row>c<col>.osm` (lowercase code). */
export function roadTileFileName(tile: RoadTile): string {
  return `${tile.code.toLowerCase()}-r${tile.row}c${tile.col}.osm`;
}
