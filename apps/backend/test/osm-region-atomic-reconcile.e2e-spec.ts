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
import { regionPolygon } from '../src/modules/roads/osm-import/region-polygons.js';
import { RoadSegment } from '../src/entities/road-segment.entity.js';

/**
 * Per-region import ATOMICITY (Codex P1) — a region's tiles reconcile as ONE
 * transaction, so a mid-region tile failure rolls back the earlier tiles rather
 * than leaving a half-new / half-old snapshot that corrupts identity + history for
 * a way crossing a tile seam. Before the fix each `importTile` → `reconcile` opened
 * and COMMITTED its own transaction, so an earlier tile's writes survived a later
 * tile's failure; `importRegion` now wraps the whole tile loop in a single
 * transaction.
 *
 * The proof, against real Postgres/PostGIS through the public `importRegion`:
 * seed a road in the region's FIRST tile (committed by a standalone `importTile`),
 * then drive `importRegion` over a two-tile region whose SECOND tile is a
 * present-but-malformed extract (its parse throws mid-region) and whose first tile
 * is now present-but-EMPTY (authoritative → would tombstone the seeded road). The
 * region must reject AND leave the seeded road EXACTLY as seeded — same id, same
 * geometry, still live (`deactivated_at` null). That last assertion is RED before
 * the fix (the first tile committed its own tombstone transaction before the second
 * tile threw) and GREEN with the per-region transaction (the second tile's throw
 * rolls the first tile's staged tombstone back).
 *
 * Isolation (mirrors the sibling reconcile e2e specs — non-destructive):
 * `importRegion` drives the SAME production reconcile, scoped to RO's real country
 * polygon ∩ this spec's tiles' bboxes — so if the DB already holds live OSM road
 * rows there (RO is a configured import region), this test's synthetic extract
 * would make them look "removed". Rather than clearing that scope (a hard DELETE
 * risks real rows + their FK history), `beforeEach` COUNTs the live OSM rows
 * already in the seed tile's polygon ∩ bbox and THROWS if non-empty, refusing to
 * run rather than mutating a populated DB; `afterEach` deletes only this spec's own
 * tracked synthetic way id, never a scope-wide sweep. This spec's RO_SUB scope
 * (central RO around 25°E/45.5°N) is a disjoint two-tile sub-grid — separate from
 * the other reconcile e2e specs' scopes (CZ ∪ SK / Timișoara r0c0 / Bucharest r0c2
 * / Cluj r1c1 / the Alps split-merge patch) — so it's safe under Jest's file-level
 * parallelism. Only this spec calls `importRegion`, and it writes an extract for
 * ONLY its two tiles, so every other RO tile is absent (skipped, no DB touch).
 *
 * Prerequisites: `pnpm db:up && pnpm db:migrate` before `pnpm --filter
 * @tarmoto/backend test:e2e`.
 */
describe('OSM per-region import atomicity — region rolls back on a mid-region tile failure', () => {
  let module: TestingModule;
  let service: OsmImportService;
  let dataSource: DataSource;
  let dir: string;
  let tileA: RoadTile; // the FIRST tile (imported first) — holds the seed road
  let tileB: RoadTile; // the LAST tile — its malformed extract fails the region

  const TILE_SPAN_DEG = 2.5;
  // A small central-RO sub-region (NOT the full RO bbox) that subdivides into
  // exactly TWO tiles at this span: width 3.5° → ceil(3.5/2.5)=2 cols, height 1.0°
  // → 1 row. `regionPolygon('RO')` still scopes to RO's real country polygon; the
  // custom bbox only picks the tile grid, kept disjoint from the sibling specs.
  const RO_SUB: PoiImportRegion = {
    code: 'RO',
    bbox: { minLng: 24.5, minLat: 45.0, maxLng: 28.0, maxLat: 46.0 },
  };
  // The seed road — interior central RO (near Râmnicu Vâlcea), inside tileA's bbox
  // and inside the RO polygon (the seed's upserted===1 confirms both at runtime).
  const ROAD_A = { wayId: 885001, lng: 25.0, lat: 45.5 };
  const trackedWayIds = [String(ROAD_A.wayId)];

  /** One drivable way with a single ~100 m N–S segment at `(lat,lng)`. Latitude is
   *  offset by ~0.0009° (≈100 m); a longitude offset would shrink with cos(lat) and
   *  segment into several rows. */
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

  async function segmentsForWay(osmWayId: string): Promise<
    Array<{
      id: string;
      deactivated_at: Date | null;
      geom: unknown;
    }>
  > {
    return dataSource.query(
      `SELECT id, deactivated_at, ST_AsGeoJSON(geom)::json AS geom
       FROM road_segments WHERE osm_way_id = $1`,
      [osmWayId],
    );
  }

  /** DELETE this spec's own tracked synthetic way id — never a scope-wide sweep.
   *  Run after every test (so the next `assertCleanScope` sees an empty scope) and
   *  once as a crash-recovery pre-clean in `beforeAll`. */
  async function deleteFixtureRows(): Promise<void> {
    await dataSource.query(
      `DELETE FROM road_segments WHERE osm_way_id = ANY($1::bigint[])`,
      [trackedWayIds],
    );
  }

  /** Non-destructive precondition guard (mirrors the sibling specs): COUNT the
   *  live, OSM-owned `road_segments` rows already inside the seed tile's country
   *  polygon ∩ bbox — the EXACT scope `importRegion` reconciles there — and THROW
   *  if any exist. Scoped to `osm_way_id IS NOT NULL AND deactivated_at IS NULL`
   *  (reconcile's own candidate set), so it never false-positives on crowd/seed
   *  data; refusing to run protects genuine collateral instead of tombstoning it. */
  async function assertCleanScope(tile: RoadTile): Promise<void> {
    const { minLng, minLat, maxLng, maxLat } = tile.bbox;
    const rows: Array<{ count: number }> = await dataSource.query(
      `SELECT COUNT(*)::int AS count
       FROM road_segments
       WHERE osm_way_id IS NOT NULL
         AND deactivated_at IS NULL
         AND ST_Intersects(geom, ST_GeomFromGeoJSON($1))
         AND ST_Intersects(geom, ST_MakeEnvelope($2, $3, $4, $5, 4326))`,
      [regionPolygon(RO_SUB.code), minLng, minLat, maxLng, maxLat],
    );
    const count = rows[0]!.count;
    if (count > 0) {
      throw new Error(
        `osm-region-atomic-reconcile e2e requires a clean scope — found ` +
          `${count} pre-existing OSM road_segments in RO tile ` +
          `r${tile.row}c${tile.col}'s polygon ∩ bbox; run against a disposable ` +
          `DB with no imported OSM roads in this area.`,
      );
    }
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
    dir = await mkdtemp(join(tmpdir(), 'road-region-atomic-e2e-'));

    // The region must subdivide into exactly two tiles, imported first-then-last
    // (row-major), so importRegion processes the seed tile (tileA) BEFORE the
    // failing tile (tileB) — the pre-fix behavior this test catches only manifests
    // when tileA has already committed by the time tileB throws.
    const tiles = subdivideRegion(RO_SUB, TILE_SPAN_DEG);
    if (tiles.length !== 2) {
      throw new Error(
        `expected RO_SUB to subdivide into 2 tiles, got ${tiles.length}`,
      );
    }
    tileA = tiles[0]!;
    tileB = tiles[tiles.length - 1]!;

    // Crash-recovery: a prior run that died mid-test could leave this spec's own
    // tracked fixture live; clear it (never collateral) before the first guard.
    await deleteFixtureRows();
  });

  beforeEach(async () => {
    await assertCleanScope(tileA);
  });

  afterEach(async () => {
    await deleteFixtureRows();
  });

  afterAll(async () => {
    await deleteFixtureRows();
    await rm(dir, { recursive: true, force: true });
    await module?.close();
  });

  it('rolls back the WHOLE region when a later tile is malformed — an earlier tile’s road survives unchanged', async () => {
    // Premise: the two tiles are distinct, the seed road is inside tileA and
    // OUTSIDE tileB (so tileA is genuinely the earlier, committed-then-rolled-back
    // tile and tileB is the disjoint failing one).
    expect(tileA.row === tileB.row && tileA.col === tileB.col).toBe(false);
    expect(pointInBbox(ROAD_A, tileA.bbox)).toBe(true);
    expect(pointInBbox(ROAD_A, tileB.bbox)).toBe(false);

    // 1) Seed road A in tileA, COMMITTED by a standalone importTile (its own tx).
    //    upserted === 1 proves the road is inside RO polygon ∩ tileA.
    await writeFile(
      join(dir, roadTileFileName(tileA, TILE_SPAN_DEG)),
      osmDoc(wayXml(ROAD_A.wayId, ROAD_A.lat, ROAD_A.lng)),
    );
    const seed = await service.importTile(RO_SUB, tileA, dir);
    expect(seed.upserted).toBe(1);
    const seeded = await segmentsForWay(String(ROAD_A.wayId));
    expect(seeded).toHaveLength(1);
    expect(seeded[0]!.deactivated_at).toBeNull();
    const roadAId = seeded[0]!.id;
    const roadAGeom = seeded[0]!.geom;

    // 2) Failing region import over RO_SUB (tileA processed first, then tileB):
    //    - tileA's extract is now PRESENT-BUT-EMPTY → authoritative, so reconcile
    //      would tombstone road A (a single sub-floor row → propagates freely);
    //    - tileB's extract is PRESENT-BUT-MALFORMED (mismatched close tag → sax
    //      rejects) → its parse throws mid-region, NOT an absent-file skip.
    //    importRegion must reject.
    await writeFile(
      join(dir, roadTileFileName(tileA, TILE_SPAN_DEG)),
      '<osm version="0.6"></osm>',
    );
    await writeFile(
      join(dir, roadTileFileName(tileB, TILE_SPAN_DEG)),
      '<osm version="0.6"><node id="1" lat="45" lon="26"></nope></osm>',
    );
    await expect(service.importRegion(RO_SUB, dir)).rejects.toThrow();

    // 3) The region rolled back as a UNIT: road A is EXACTLY as seeded — same id,
    //    same geometry, and STILL LIVE. `deactivated_at` is the RED→GREEN
    //    discriminator: RED before the fix (tileA committed its own tombstone
    //    transaction before tileB threw), GREEN with the per-region transaction
    //    (tileB's throw rolls tileA's staged tombstone back). id + geometry are
    //    unchanged by a tombstone, so they hold either way — asserted as the
    //    identity invariant a genuine per-tile commit-then-fail must never touch.
    const after = await segmentsForWay(String(ROAD_A.wayId));
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(roadAId);
    expect(after[0]!.deactivated_at).toBeNull();
    expect(after[0]!.geom).toEqual(roadAGeom);
  }, 30_000);
});
