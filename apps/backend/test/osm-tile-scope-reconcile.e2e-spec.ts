import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  roadTileFileName,
  subdivideRegion,
  type PoiImportRegion,
  type RoadTile,
} from '@tarmoto/ingest';
import { AppDataSource } from '../src/data-source.js';
import { OsmImportService } from '../src/modules/roads/osm-import/osm-import.service.js';
import { osmRoadImportConfig } from '../src/modules/roads/osm-import/osm-import.config.js';
import { RoadSegment } from '../src/entities/road-segment.entity.js';

/**
 * Sub-region tiling correctness — the NEW no-cross-**tile**-wipe guarantee (the
 * intra-country analogue of the #1033 no-cross-**region**-wipe).
 *
 * The importer subdivides each region into a deterministic grid and imports
 * tile-by-tile, each tile's stale-by-absence tombstoning scoped to the country
 * POLYGON ∩ that tile's bbox. If a tile's import scoped tombstoning to the country
 * polygon ALONE (the pre-tiling scope), importing one tile would tombstone the
 * region's roads that live in OTHER tiles — every road not in the tile currently
 * being imported would look "absent" and be wiped, destroying its id + crowd
 * history. The `∩ tile bbox` half of the scope is what prevents that.
 *
 * Romania at a 2.5° tile span subdivides into 8 tiles. A road at Bucharest
 * (26.10, 44.43) lands in tile r0c2; a road at Cluj (23.60, 46.77) lands in the
 * disjoint tile r1c1 — each is inside the RO polygon but OUTSIDE the other tile's
 * bbox. Seeding Bucharest, then importing ONLY the Cluj tile, must leave the
 * Bucharest road live with its original id. RO is used (not CZ/SK) so this test
 * never contends with the region-overlap e2e for the same country's rows.
 *
 * Real Postgres/PostGIS, driven through the public `importTile` so the whole path
 * — tile scope → extract parse → combined polygon∩bbox filter → reconcile — runs.
 * Prerequisites: `pnpm db:up && pnpm db:migrate` before `pnpm --filter
 * @tarmoto/backend test:e2e`.
 */
describe('OSM intra-country tile-scope reconciliation — polygon ∩ tile bbox', () => {
  let module: TestingModule;
  let service: OsmImportService;
  let dataSource: DataSource;
  let dir: string;

  const TILE_SPAN_DEG = 2.5;
  // RO bbox 9.45° × 4.65° → ceil(9.45/2.5)=4 cols × ceil(4.65/2.5)=2 rows = 8
  // tiles at this span (see DEFAULT_REGIONS).
  const RO: PoiImportRegion = {
    code: 'RO',
    bbox: { minLng: 20.26, minLat: 43.62, maxLng: 29.71, maxLat: 48.27 },
  };
  // Two interior RO cities that fall in different, non-overlapping tiles.
  const BUCHAREST = { lng: 26.1, lat: 44.43 }; // tile r0c2
  const CLUJ = { lng: 23.6, lat: 46.77 }; // tile r1c1

  // Way ids this test owns — deleted before and after so a crashed prior run
  // (which could leave a tombstoned same-key row and break the fresh insert)
  // can't make this flake.
  const trackedWayIds = ['883001', '883002'];

  /** One drivable way with a single ~100 m N–S segment at `(lat,lng)`. Latitude
   *  is offset by ~0.0009° (≈100 m); a longitude offset would shrink with
   *  cos(lat) and segment into several rows. */
  function wayXml(id: number, lat: number, lng: number): string {
    return (
      `<node id="${id}0" lat="${lat}" lon="${lng}"/>` +
      `<node id="${id}1" lat="${lat + 0.0009}" lon="${lng}"/>` +
      `<way id="${id}"><nd ref="${id}0"/><nd ref="${id}1"/>` +
      `<tag k="highway" v="residential"/></way>`
    );
  }
  function osmDoc(...ways: string[]): string {
    return `<osm version="0.6">${ways.join('')}</osm>`;
  }

  /** The tile whose bbox contains `(lng,lat)` (interior points only — no seam
   *  ambiguity here). Throws if none, so a bad premise fails loudly. */
  function tileContaining(
    tiles: RoadTile[],
    lng: number,
    lat: number,
  ): RoadTile {
    const tile = tiles.find(
      (t) =>
        lng >= t.bbox.minLng &&
        lng <= t.bbox.maxLng &&
        lat >= t.bbox.minLat &&
        lat <= t.bbox.maxLat,
    );
    if (!tile) throw new Error(`no tile contains (${lng}, ${lat})`);
    return tile;
  }

  function pointInBbox(
    p: { lng: number; lat: number },
    bbox: RoadTile['bbox'],
  ): boolean {
    return (
      p.lng >= bbox.minLng &&
      p.lng <= bbox.maxLng &&
      p.lat >= bbox.minLat &&
      p.lat <= bbox.maxLat
    );
  }

  async function segmentsForWay(
    osmWayId: string,
  ): Promise<Array<{ id: string; deactivated_at: Date | null }>> {
    return dataSource.query(
      `SELECT id, deactivated_at FROM road_segments WHERE osm_way_id = $1`,
      [osmWayId],
    );
  }

  async function deleteTrackedWays(): Promise<void> {
    await dataSource.query(
      `DELETE FROM road_segments WHERE osm_way_id = ANY($1::bigint[])`,
      [trackedWayIds],
    );
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(AppDataSource.options),
        TypeOrmModule.forFeature([RoadSegment]),
      ],
      providers: [
        OsmImportService,
        {
          provide: osmRoadImportConfig.KEY,
          useValue: {
            enabled: true,
            extractDir: null,
            regions: [],
            tileSpanDeg: TILE_SPAN_DEG,
          },
        },
      ],
    }).compile();
    service = module.get(OsmImportService);
    dataSource = module.get(DataSource);
    dir = await mkdtemp(join(tmpdir(), 'road-tile-scope-e2e-'));
    await deleteTrackedWays();
  });

  afterAll(async () => {
    await deleteTrackedWays();
    await rm(dir, { recursive: true, force: true });
    await module?.close();
  });

  it('importing one tile does NOT tombstone another tile’s road in the same country', async () => {
    const tiles = subdivideRegion(RO, TILE_SPAN_DEG);
    const tileA = tileContaining(tiles, BUCHAREST.lng, BUCHAREST.lat);
    const tileB = tileContaining(tiles, CLUJ.lng, CLUJ.lat);

    // Guard the premise: the two roads must be in DIFFERENT tiles, and each must
    // be OUTSIDE the other tile's bbox — otherwise the ∩-tile-bbox scope wouldn't
    // be what's under test.
    expect(tileA.row === tileB.row && tileA.col === tileB.col).toBe(false);
    expect(pointInBbox(BUCHAREST, tileB.bbox)).toBe(false);
    expect(pointInBbox(CLUJ, tileA.bbox)).toBe(false);

    // 1) Seed road A inside tile A (inside the RO polygon); capture its id. That
    //    it imports at all confirms Bucharest is inside RO ∩ tileA.
    await writeFile(
      join(dir, roadTileFileName(tileA)),
      osmDoc(wayXml(883001, BUCHAREST.lat, BUCHAREST.lng)),
    );
    await service.importTile(RO, tileA, dir);
    const seeded = await segmentsForWay('883001');
    expect(seeded).toHaveLength(1);
    expect(seeded[0]!.deactivated_at).toBeNull();
    const roadAId = seeded[0]!.id;

    // 2) Import ONLY tile B, carrying its own disjoint road. Its stale-by-absence
    //    scope is RO polygon ∩ tileB bbox — which does not reach tile A's cell.
    await writeFile(
      join(dir, roadTileFileName(tileB)),
      osmDoc(wayXml(883002, CLUJ.lat, CLUJ.lng)),
    );
    const resB = await service.importTile(RO, tileB, dir);
    expect(resB.upserted).toBe(1); // tile B's own road imported (proves in-scope)
    expect(resB.deactivated).toBe(0); // and nothing tombstoned

    // 3) Tile A's road survives with its ORIGINAL id and still live. On a
    //    polygon-ONLY tombstone scope (no ∩ tile bbox), tile B's import loads
    //    road A (it's in the RO polygon), finds it unmatched, and tombstones it —
    //    so this assertion is RED without the tile-bbox half of the scope, GREEN
    //    with it.
    const after = await segmentsForWay('883001');
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(roadAId); // identity + history preserved
    expect(after[0]!.deactivated_at).toBeNull(); // still live
  }, 30_000);
});
