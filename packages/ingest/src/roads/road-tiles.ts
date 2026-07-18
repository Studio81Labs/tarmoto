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

/** Degrees the producer grows each tile's `osmium extract -b` bbox beyond the
 *  exact tile, so a way crossing the tile whose nodes sit just outside is still
 *  captured (complete_ways selects by nodes-in-bbox). The backend reconciles to
 *  the EXACT tile bbox, so this overhang is filtered out — it only prevents
 *  node-less-crossing holes. 0.05° ≈ 5 km comfortably exceeds any real road's
 *  inter-node gap. (A way with a single un-noded edge longer than the pad would
 *  still slip through, but that's a >5 km straight road with no intermediate
 *  node, which does not occur — documented, not further guarded.) */
export const TILE_EXTRACT_PAD_DEG = 0.05;

/** The tile bbox grown by `padDeg` on every side (for the producer's extract
 *  clip only — the backend's reconcile scope + the tile filename stay the
 *  EXACT tile bbox, so the padded overhang is dropped by its `polygon ∩
 *  tile_bbox` filter and never double-counted). */
export function paddedTileBbox(
  bbox: RoadTile["bbox"],
  padDeg: number,
): RoadTile["bbox"] {
  return {
    minLng: bbox.minLng - padDeg,
    minLat: bbox.minLat - padDeg,
    maxLng: bbox.maxLng + padDeg,
    maxLat: bbox.maxLat + padDeg,
  };
}

/** Per-tile extract filename: `<code>-r<row>c<col>-s<span>.osm` (lowercase
 *  code, `spanDeg` with `.` replaced by `_`, e.g. `cz-r0c0-s2_5.osm`). The span
 *  is a grid-identity DISCRIMINATOR only — the importer derives the real span
 *  from its own config, never from the filename — so a retuned
 *  `TARMOTO_OSM_ROAD_TILE_SPAN_DEG` yields different names instead of a
 *  same-named file now meaning a DIFFERENT bbox: a stale-grid file is then
 *  simply "absent" to the current importer (skipped), never mis-reconciled
 *  against the wrong scope. Both the producer and the backend importer must
 *  call this with their config's span, so they derive identical names when
 *  the spans agree. */
export function roadTileFileName(tile: RoadTile, spanDeg: number): string {
  const span = String(spanDeg).replace(".", "_");
  return `${tile.code.toLowerCase()}-r${tile.row}c${tile.col}-s${span}.osm`;
}
