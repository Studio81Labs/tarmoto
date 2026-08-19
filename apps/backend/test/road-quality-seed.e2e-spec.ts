import { DataSource } from 'typeorm';
import { AppDataSource } from '../src/data-source.js';

// Manual pre-release gate (real PostgreSQL). Run: pnpm --filter @tarmoto/backend test:e2e -- road-quality-seed
describe('road-quality seed blend (real PG)', () => {
  let ds: DataSource;
  let segmentIds: string[] = [];
  beforeAll(async () => {
    ds = await AppDataSource.initialize();
  });
  afterAll(async () => {
    await ds.destroy();
  });
  // Delete the rows each test inserted so a re-run against the shared test DB
  // never accumulates scored segments at (0,0) that could skew later spatial /
  // clustering reads (mirrors road-quality-outlier-filter.e2e-spec).
  afterEach(async () => {
    if (segmentIds.length > 0) {
      await ds.query(
        `DELETE FROM surface_readings WHERE road_segment_id = ANY($1::uuid[])`,
        [segmentIds],
      );
      await ds.query(`DELETE FROM road_segments WHERE id = ANY($1::uuid[])`, [
        segmentIds,
      ]);
      segmentIds = [];
    }
  });

  async function makeSegment(seed: number | null): Promise<string> {
    const rows: { id: string }[] = await ds.query(
      `INSERT INTO road_segments (geom, length_m, osm_quality_seed, quality_source, quality_score)
       VALUES (ST_SetSRID(ST_MakeLine(ST_MakePoint(0,0), ST_MakePoint(0.01,0)),4326), 100, $1, 'osm_highway', $1)
       RETURNING id`,
      [seed],
    );
    segmentIds.push(rows[0]!.id);
    return rows[0]!.id;
  }
  async function addReading(
    segId: string,
    classification: string,
  ): Promise<void> {
    // iri_value is NOT NULL but unused by the trigger; any numeric
    // placeholder is fine for blend behaviour. user_id is nullable and has
    // an FK to users — NULL (anonymous reading) avoids seeding a fake user
    // row just to satisfy it, matching the outlier-filter e2e spec's
    // convention.
    await ds.query(
      `INSERT INTO surface_readings (road_segment_id, user_id, iri_value, classification, recorded_at)
       VALUES ($1, NULL, 1.0, $2, NOW())`,
      [segId, classification],
    );
  }

  it('n=0 → quality_score equals the seed', async () => {
    const id = await makeSegment(4);
    await ds.query(`SELECT update_road_quality_for_segment($1)`, [id]);
    const rows: { quality_score: number | string | null }[] = await ds.query(
      `SELECT quality_score FROM road_segments WHERE id=$1`,
      [id],
    );
    expect(Number(rows[0]!.quality_score)).toBeCloseTo(4, 5);
  });

  it('blends toward the rider mean by count (seed=4, k=4, one poor reading → 3.6)', async () => {
    const id = await makeSegment(4);
    await addReading(id, 'poor'); // 2.0
    await ds.query(`SELECT update_road_quality_for_segment($1)`, [id]);
    const rows: {
      quality_score: number | string | null;
      reading_count: number | string;
    }[] = await ds.query(
      `SELECT quality_score, reading_count FROM road_segments WHERE id=$1`,
      [id],
    );
    expect(Number(rows[0]!.reading_count)).toBe(1);
    expect(Number(rows[0]!.quality_score)).toBeCloseTo((2 * 1 + 4 * 4) / 5, 4); // 3.6
  });

  it('null seed → pure rider mean', async () => {
    const id = await makeSegment(null);
    await addReading(id, 'good'); // 4.0
    await ds.query(`SELECT update_road_quality_for_segment($1)`, [id]);
    const rows: { quality_score: number | string | null }[] = await ds.query(
      `SELECT quality_score FROM road_segments WHERE id=$1`,
      [id],
    );
    expect(Number(rows[0]!.quality_score)).toBeCloseTo(4, 4);
  });
});
