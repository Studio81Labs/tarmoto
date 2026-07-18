import type { PoiImportRegion } from "../poi/regions.js";
import {
  TILE_EXTRACT_PAD_DEG,
  TILE_MAX_SPAN_DEG_DEFAULT,
  paddedTileBbox,
  resolveTileSpanDeg,
  roadTileFileName,
  subdivideRegion,
  type RoadTile,
} from "./road-tiles.js";

const CZ: PoiImportRegion = {
  code: "CZ",
  bbox: { minLng: 12.09, minLat: 48.55, maxLng: 18.86, maxLat: 51.06 },
};

describe("subdivideRegion", () => {
  it("yields a single 1×1 tile equal to the region bbox when it already fits the span", () => {
    const tiles = subdivideRegion(CZ, 10);
    expect(tiles).toEqual([{ code: "CZ", row: 0, col: 0, bbox: CZ.bbox }]);
  });

  it("splits a region wider than tall into cols == ceil(width/span), rows == 1", () => {
    const wide: PoiImportRegion = {
      code: "XX",
      bbox: { minLng: 0, minLat: 0, maxLng: 10, maxLat: 1 },
    };
    const tiles = subdivideRegion(wide, 3);

    expect(tiles).toHaveLength(4); // cols == ceil(10/3) == 4
    expect(tiles.every((t) => t.row === 0)).toBe(true); // rows == 1
    expect(new Set(tiles.map((t) => t.col))).toEqual(new Set([0, 1, 2, 3]));

    // Contiguous + non-overlapping, in row-major order: each cell's maxLng
    // is exactly the next cell's minLng (no gap, no overlap).
    for (let i = 0; i < tiles.length - 1; i++) {
      expect(tiles[i]!.bbox.maxLng).toBe(tiles[i + 1]!.bbox.minLng);
    }
    expect(tiles[0]!.bbox.minLng).toBe(0);
    // Last col pinned to the exact region edge (no float-drift gap).
    expect(tiles.at(-1)!.bbox.maxLng).toBe(10);
    // A single row spans the full (and only) lat band, pinned both ends.
    expect(tiles.every((t) => t.bbox.minLat === 0 && t.bbox.maxLat === 1)).toBe(
      true,
    );
  });

  it("yields exactly N cols/rows for a region exactly N×span wide/tall (ceil boundary, no off-by-one)", () => {
    const exact: PoiImportRegion = {
      code: "XX",
      bbox: { minLng: 0, minLat: 0, maxLng: 10, maxLat: 5 },
    };
    const tiles = subdivideRegion(exact, 5); // 10/5=2 cols exactly, 5/5=1 row exactly

    const cols = Math.max(...tiles.map((t) => t.col)) + 1;
    const rows = Math.max(...tiles.map((t) => t.row)) + 1;
    expect(cols).toBe(2); // NOT 3 — Math.ceil(10/5) must not float-drift above 2
    expect(rows).toBe(1);
    expect(tiles).toHaveLength(cols * rows);

    // Union of every cell still equals the region bbox exactly.
    expect(Math.min(...tiles.map((t) => t.bbox.minLng))).toBe(
      exact.bbox.minLng,
    );
    expect(Math.min(...tiles.map((t) => t.bbox.minLat))).toBe(
      exact.bbox.minLat,
    );
    expect(Math.max(...tiles.map((t) => t.bbox.maxLng))).toBe(
      exact.bbox.maxLng,
    );
    expect(Math.max(...tiles.map((t) => t.bbox.maxLat))).toBe(
      exact.bbox.maxLat,
    );
  });

  it("produces a deterministic, non-overlapping grid exactly covering the region bbox (CZ @ 2.5°)", () => {
    const spanDeg = 2.5;
    const tiles = subdivideRegion(CZ, spanDeg);

    // width 6.77 / 2.5 -> cols=3; height 2.51 / 2.5 -> rows=2.
    const cols = 3;
    const rows = 2;
    expect(tiles).toHaveLength(cols * rows);

    // Exactly the expected (row, col) set, each cell ≤ spanDeg on both axes.
    const seen = new Set(tiles.map((t) => `${t.row}:${t.col}`));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        expect(seen.has(`${r}:${c}`)).toBe(true);
        const tile = tiles.find((t) => t.row === r && t.col === c)!;
        expect(tile.bbox.maxLng - tile.bbox.minLng).toBeLessThanOrEqual(
          spanDeg,
        );
        expect(tile.bbox.maxLat - tile.bbox.minLat).toBeLessThanOrEqual(
          spanDeg,
        );
      }
    }

    // Contiguous + non-overlapping along each row (shared edge, no gap).
    for (let r = 0; r < rows; r++) {
      const rowTiles = tiles
        .filter((t) => t.row === r)
        .sort((a, b) => a.col - b.col);
      for (let i = 0; i < rowTiles.length - 1; i++) {
        expect(rowTiles[i]!.bbox.maxLng).toBe(rowTiles[i + 1]!.bbox.minLng);
      }
    }
    // Contiguous + non-overlapping along each column.
    for (let c = 0; c < cols; c++) {
      const colTiles = tiles
        .filter((t) => t.col === c)
        .sort((a, b) => a.row - b.row);
      for (let i = 0; i < colTiles.length - 1; i++) {
        expect(colTiles[i]!.bbox.maxLat).toBe(colTiles[i + 1]!.bbox.minLat);
      }
    }

    // The union of every cell exactly equals the region bbox.
    expect(Math.min(...tiles.map((t) => t.bbox.minLng))).toBe(CZ.bbox.minLng);
    expect(Math.min(...tiles.map((t) => t.bbox.minLat))).toBe(CZ.bbox.minLat);
    expect(Math.max(...tiles.map((t) => t.bbox.maxLng))).toBe(CZ.bbox.maxLng);
    expect(Math.max(...tiles.map((t) => t.bbox.maxLat))).toBe(CZ.bbox.maxLat);

    // Last col/row pinned to the exact region edge (no float-drift gap).
    for (const tile of tiles.filter((t) => t.col === cols - 1)) {
      expect(tile.bbox.maxLng).toBe(CZ.bbox.maxLng);
    }
    for (const tile of tiles.filter((t) => t.row === rows - 1)) {
      expect(tile.bbox.maxLat).toBe(CZ.bbox.maxLat);
    }
  });

  it("is deterministic — the same input yields an identical grid", () => {
    expect(subdivideRegion(CZ, 2.5)).toEqual(subdivideRegion(CZ, 2.5));
  });

  it("carries the region code onto every tile", () => {
    const tiles = subdivideRegion(CZ, 2.5);
    expect(tiles.every((t) => t.code === "CZ")).toBe(true);
  });
});

describe("roadTileFileName", () => {
  it("formats <code>-r<row>c<col>-s<span>.osm, lowercasing the code", () => {
    const tile: RoadTile = { code: "CZ", row: 1, col: 2, bbox: CZ.bbox };
    expect(roadTileFileName(tile, 2.5)).toBe("cz-r1c2-s2_5.osm");
  });

  it("leaves an integer span untouched — no decimal point to replace", () => {
    const tile: RoadTile = { code: "CZ", row: 0, col: 0, bbox: CZ.bbox };
    expect(roadTileFileName(tile, 2)).toBe("cz-r0c0-s2.osm");
  });

  it("encodes the span as a grid-identity discriminator — a different span yields a different name for the SAME tile", () => {
    const tile: RoadTile = { code: "CZ", row: 0, col: 0, bbox: CZ.bbox };
    const nameAtDefaultSpan = roadTileFileName(tile, TILE_MAX_SPAN_DEG_DEFAULT);
    const nameAtRetunedSpan = roadTileFileName(tile, 1.5);
    expect(nameAtDefaultSpan).not.toBe(nameAtRetunedSpan);
    expect(nameAtDefaultSpan).toBe("cz-r0c0-s2_5.osm");
    expect(nameAtRetunedSpan).toBe("cz-r0c0-s1_5.osm");
  });
});

describe("paddedTileBbox", () => {
  it("grows every side of the bbox by padDeg", () => {
    const bbox: RoadTile["bbox"] = {
      minLng: 12.09,
      minLat: 48.55,
      maxLng: 18.86,
      maxLat: 51.06,
    };
    expect(paddedTileBbox(bbox, 0.05)).toEqual({
      minLng: 12.04,
      minLat: 48.5,
      maxLng: 18.91,
      maxLat: 51.11,
    });
  });

  it("grows outward (min shrinks, max grows) rather than shifting the box", () => {
    const bbox: RoadTile["bbox"] = {
      minLng: 0,
      minLat: 0,
      maxLng: 1,
      maxLat: 1,
    };
    const padded = paddedTileBbox(bbox, TILE_EXTRACT_PAD_DEG);
    expect(padded.minLng).toBeLessThan(bbox.minLng);
    expect(padded.minLat).toBeLessThan(bbox.minLat);
    expect(padded.maxLng).toBeGreaterThan(bbox.maxLng);
    expect(padded.maxLat).toBeGreaterThan(bbox.maxLat);
    // Symmetric growth — the padded box is centered on the same point.
    expect(padded.maxLng - padded.minLng).toBeCloseTo(
      bbox.maxLng - bbox.minLng + 2 * TILE_EXTRACT_PAD_DEG,
    );
    expect(padded.maxLat - padded.minLat).toBeCloseTo(
      bbox.maxLat - bbox.minLat + 2 * TILE_EXTRACT_PAD_DEG,
    );
  });

  it("a zero pad is a no-op", () => {
    const bbox: RoadTile["bbox"] = {
      minLng: 12.09,
      minLat: 48.55,
      maxLng: 18.86,
      maxLat: 51.06,
    };
    expect(paddedTileBbox(bbox, 0)).toEqual(bbox);
  });
});

describe("resolveTileSpanDeg", () => {
  it("defaults to TILE_MAX_SPAN_DEG_DEFAULT when unset", () => {
    expect(resolveTileSpanDeg({} as NodeJS.ProcessEnv)).toBe(
      TILE_MAX_SPAN_DEG_DEFAULT,
    );
  });

  it("defaults when blank", () => {
    expect(
      resolveTileSpanDeg({
        TARMOTO_OSM_ROAD_TILE_SPAN_DEG: "   ",
      } as NodeJS.ProcessEnv),
    ).toBe(TILE_MAX_SPAN_DEG_DEFAULT);
  });

  it("parses a positive override", () => {
    expect(
      resolveTileSpanDeg({
        TARMOTO_OSM_ROAD_TILE_SPAN_DEG: "1.5",
      } as NodeJS.ProcessEnv),
    ).toBe(1.5);
  });

  it("throws on a non-numeric value", () => {
    expect(() =>
      resolveTileSpanDeg({
        TARMOTO_OSM_ROAD_TILE_SPAN_DEG: "abc",
      } as NodeJS.ProcessEnv),
    ).toThrow(/positive number/);
  });

  it("throws on zero or negative", () => {
    expect(() =>
      resolveTileSpanDeg({
        TARMOTO_OSM_ROAD_TILE_SPAN_DEG: "0",
      } as NodeJS.ProcessEnv),
    ).toThrow(/positive number/);
    expect(() =>
      resolveTileSpanDeg({
        TARMOTO_OSM_ROAD_TILE_SPAN_DEG: "-1",
      } as NodeJS.ProcessEnv),
    ).toThrow(/positive number/);
  });
});
