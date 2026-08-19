import { DataSource } from 'typeorm';
import { AppDataSource } from '../src/data-source.js';

/**
 * Issue #495 — server-side road-quality aggregation must drop
 * readings whose `quality_score` deviates more than 2 standard
 * deviations from the segment mean before applying recency
 * weighting and confidence scoring.
 *
 * The filter lives in PL/pgSQL inside the `update_road_quality`
 * trigger (and its helper `update_road_quality_for_segment`), so
 * the only meaningful test is one that drives the actual trigger
 * by inserting `surface_readings` rows against a real Postgres.
 * Mocking TypeORM repositories would not exercise the SQL.
 *
 * Prerequisites: `pnpm db:up && pnpm db:migrate` before running
 * `pnpm --filter @tarmoto/backend test:e2e`.
 */

const QUALITY_TO_CLASSIFICATION: Record<number, string> = {
  5: 'excellent',
  4: 'good',
  3: 'fair',
  2: 'poor',
  1: 'very_poor',
};

interface SegmentRow {
  quality_score: number | null;
  reading_count: number;
  confidence: number;
  last_filtered_count: number;
}

describe('road-quality aggregation — outlier filtering (#495)', () => {
  let dataSource: DataSource;
  let segmentIds: string[] = [];

  // Use a deterministic geometry that's far from any real-world
  // segment so the test rows can't collide with seeded data.
  // ST_GeomFromText needs a literal — segment 1 sits at lng=0,
  // lat=0 across a 1m-ish span which is fine for SRID 4326 even
  // if it's not geodetically meaningful.
  const TEST_GEOM = `ST_GeomFromText('LINESTRING(0 0, 0.0001 0.0001)', 4326)`;

  async function createSegment(): Promise<string> {
    const rows: { id: string }[] = await dataSource.query(
      `INSERT INTO road_segments (geom, length_m, road_name)
       VALUES (${TEST_GEOM}, 100, 'outlier-test-segment')
       RETURNING id`,
    );
    segmentIds.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function insertReading(
    segmentId: string,
    quality: 1 | 2 | 3 | 4 | 5,
    opts: { userId?: string | null; surfaceType?: string | null } = {},
  ): Promise<void> {
    const classification = QUALITY_TO_CLASSIFICATION[quality];
    await dataSource.query(
      `INSERT INTO surface_readings
         (road_segment_id, user_id, iri_value, classification, surface_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        segmentId,
        opts.userId ?? null,
        // iri_value is required but unused by the trigger, any
        // numeric placeholder is fine for trigger behaviour.
        1.0,
        classification,
        opts.surfaceType ?? null,
      ],
    );
  }

  async function readSegment(segmentId: string): Promise<SegmentRow> {
    const rows: SegmentRow[] = await dataSource.query(
      `SELECT quality_score, reading_count, confidence, last_filtered_count
         FROM road_segments WHERE id = $1`,
      [segmentId],
    );
    return rows[0]!;
  }

  beforeAll(async () => {
    dataSource = new DataSource(AppDataSource.options);
    await dataSource.initialize();
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  afterEach(async () => {
    if (segmentIds.length > 0) {
      await dataSource.query(
        `DELETE FROM surface_readings WHERE road_segment_id = ANY($1::uuid[])`,
        [segmentIds],
      );
      await dataSource.query(
        `DELETE FROM road_segments WHERE id = ANY($1::uuid[])`,
        [segmentIds],
      );
      segmentIds = [];
    }
  });

  it('filters a single 1.0 outlier among five 5.0 readings', async () => {
    // The canonical "noisy map" case from the issue: a smooth road
    // (five excellent readings) gets one bad reading from a phone
    // slipping in the mount. After filtering the segment should
    // read as ~5.0 with confidence based on the post-filter count
    // (5 readings → 70).
    const segmentId = await createSegment();

    for (let i = 0; i < 5; i++) {
      await insertReading(segmentId, 5);
    }
    await insertReading(segmentId, 1);

    const row = await readSegment(segmentId);
    expect(row.last_filtered_count).toBe(1);
    expect(row.reading_count).toBe(5);
    // Post-filter: five 5.0 readings, all in the 30-day window so
    // recency weights are uniform → weighted mean = 5.0.
    expect(row.quality_score).toBeCloseTo(5.0, 5);
    // Confidence per spec §8.3 step 3: 5+ readings → 70.
    expect(row.confidence).toBe(70);
  }, 30_000);

  it('skips filtering when fewer than 3 readings exist', async () => {
    // 2 readings: stddev is degenerate, so the issue's contract
    // is to keep both readings. The very_poor reading must
    // remain in the average.
    const segmentId = await createSegment();

    await insertReading(segmentId, 5);
    await insertReading(segmentId, 1);

    const row = await readSegment(segmentId);
    expect(row.last_filtered_count).toBe(0);
    expect(row.reading_count).toBe(2);
    expect(row.quality_score).toBeCloseTo(3.0, 5);
    // 2 readings → confidence 20.
    expect(row.confidence).toBe(20);
  }, 30_000);

  it('skips filtering when exactly 3 readings agree (zero spread)', async () => {
    // 3 identical readings: stddev = 0, so the "no spread" branch
    // keeps all three regardless of the threshold rule.
    const segmentId = await createSegment();

    await insertReading(segmentId, 5);
    await insertReading(segmentId, 5);
    await insertReading(segmentId, 5);

    const row = await readSegment(segmentId);
    expect(row.last_filtered_count).toBe(0);
    expect(row.reading_count).toBe(3);
    expect(row.quality_score).toBeCloseTo(5.0, 5);
    // 3 readings → confidence 50.
    expect(row.confidence).toBe(50);
  }, 30_000);

  it('keeps readings within 2σ of the mean', async () => {
    // Bimodal but in-spec: 4×5.0 + 4×4.0. mean = 4.5,
    // stddev_samp = sqrt(8·0.5²/7) ≈ 0.535, 2σ ≈ 1.07. Max
    // deviation is 0.5 from the mean, well under 2σ — no
    // reading should be dropped, and the quality score must
    // settle on the genuine 4.5 average rather than a
    // mode-collapsed 5.0 or 4.0.
    const segmentId = await createSegment();

    for (let i = 0; i < 4; i++) {
      await insertReading(segmentId, 5);
    }
    for (let i = 0; i < 4; i++) {
      await insertReading(segmentId, 4);
    }

    const row = await readSegment(segmentId);
    expect(row.last_filtered_count).toBe(0);
    expect(row.reading_count).toBe(8);
    expect(row.quality_score).toBeCloseTo(4.5, 5);
  }, 30_000);

  it('confidence scoring uses the post-filter reading count', async () => {
    // Threshold-crossing case: 9×5.0 + 1×1.0. Pre-filter count =
    // 10 → confidence 90, post-filter count = 9 → confidence 70.
    // Picking these specific cardinalities is what makes the
    // assertion meaningful: a regression that scored confidence
    // on the raw count would award 90 here and fail this test.
    //
    // mean = (9·5+1)/10 = 4.6; stddev_samp = sqrt(((9·0.16) +
    // 12.96)/9) ≈ 1.265; 2σ ≈ 2.53; |1−4.6| = 3.6 → drop.
    const segmentId = await createSegment();

    for (let i = 0; i < 9; i++) {
      await insertReading(segmentId, 5);
    }
    await insertReading(segmentId, 1);

    const row = await readSegment(segmentId);
    expect(row.last_filtered_count).toBe(1);
    expect(row.reading_count).toBe(9);
    expect(row.quality_score).toBeCloseTo(5.0, 5);
    expect(row.confidence).toBe(70);
  }, 30_000);

  it('persists last_filtered_count = 0 when no outliers are present', async () => {
    // 5 identical readings → no outliers, audit column must
    // explicitly be 0 (not stale from a previous aggregation).
    const segmentId = await createSegment();

    for (let i = 0; i < 5; i++) {
      await insertReading(segmentId, 5);
    }

    const row = await readSegment(segmentId);
    expect(row.last_filtered_count).toBe(0);
    expect(row.reading_count).toBe(5);
    expect(row.quality_score).toBeCloseTo(5.0, 5);
  }, 30_000);

  it('keeps surface_type aggregation working alongside filtering', async () => {
    // Outlier filtering operates on quality_score only; surface
    // mode aggregation is independent and must not be affected
    // by filtering decisions. Mixed surface types should resolve
    // to the mode whether or not any quality outliers are dropped.
    const segmentId = await createSegment();

    for (let i = 0; i < 5; i++) {
      await insertReading(segmentId, 5, { surfaceType: 'asphalt' });
    }
    await insertReading(segmentId, 1, { surfaceType: 'gravel' });

    const rows: { surface_type: string; last_filtered_count: number }[] =
      await dataSource.query(
        `SELECT surface_type, last_filtered_count
           FROM road_segments WHERE id = $1`,
        [segmentId],
      );
    expect(rows[0]!.last_filtered_count).toBe(1);
    // Mode of 5×asphalt + 1×gravel = asphalt. The outlier 1.0
    // reading was tagged gravel, but since surface mode counts
    // raw readings (not quality-filtered ones), the asphalt
    // majority still wins by count regardless.
    expect(rows[0]!.surface_type).toBe('asphalt');
  }, 30_000);
});
