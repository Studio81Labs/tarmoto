import { DataSource } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { AppDataSource } from '../src/data-source.js';
import { RoadsService } from '../src/modules/roads/roads.service.js';
import { FunZoneClusteringService } from '../src/modules/roads/fun-zone-clustering.service.js';
import { FeatureResolver } from '../src/modules/features/feature-resolver.service.js';
import { RoadSegment } from '../src/entities/road-segment.entity.js';
import { FunZone } from '../src/entities/fun-zone.entity.js';
import { FunZoneRoad } from '../src/entities/fun-zone-road.entity.js';

/**
 * Issue #794 — OSM-imported ~100 m segments must reach best-roads and fun-zones
 * despite the 500 m length filters, WITHOUT a lone 100 m stub surfacing as a
 * "best road". The consumers aggregate sub-segments into their parent OSM way
 * (COALESCE(osm_way_id, id)) and apply the length filter to the aggregate; a
 * crowd-sourced row (null osm_way_id) is a group of one, so its behaviour is
 * unchanged. The aggregation is PostGIS SQL, so the only meaningful test drives
 * the real queries against Postgres.
 *
 * Prerequisites: `pnpm db:up && pnpm db:migrate` before running
 * `pnpm --filter @tarmoto/backend test:e2e`.
 */
describe('segment-length aggregation for best-roads + fun-zones (#794)', () => {
  let module: TestingModule;
  let roads: RoadsService;
  let funZones: FunZoneClusteringService;
  let dataSource: DataSource;
  const segmentIds: string[] = [];

  // best-roads test rows live in the (unseeded) Dolomites region so findBest
  // returns only them. fun-zone rows live at the origin — outside every region
  // bbox — so runClustering(bbox) isolates them and they can't leak into the
  // findBest assertions.
  const DOLO_LNG = 11.6;
  const DOLO_LAT = 46.5;

  interface SegOpts {
    name: string;
    osmWayId?: string | null;
    segmentIndex?: number | null;
    lng: number;
    lat: number;
    lengthM: number;
    quality?: number | null;
    confidence?: number;
    curviness?: number;
  }

  async function insertSegment(o: SegOpts): Promise<string> {
    // A short distinct line; length_m (the column) drives the filters, not the
    // geometry's true length, so a small geom with an explicit length_m is fine.
    const geom = `ST_GeomFromText('LINESTRING(${o.lng} ${o.lat}, ${o.lng} ${o.lat + 0.001})', 4326)`;
    const rows: { id: string }[] = await dataSource.query(
      `INSERT INTO road_segments
         (geom, length_m, road_name, osm_way_id, segment_index,
          quality_score, confidence, curviness_score)
       VALUES (${geom}, $1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        o.lengthM,
        o.name,
        o.osmWayId ?? null,
        o.segmentIndex ?? null,
        o.quality === undefined ? 4.0 : o.quality,
        o.confidence ?? 60,
        o.curviness ?? 3.0,
      ],
    );
    segmentIds.push(rows[0]!.id);
    return rows[0]!.id;
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(AppDataSource.options),
        TypeOrmModule.forFeature([RoadSegment, FunZone, FunZoneRoad]),
      ],
      providers: [
        RoadsService,
        FunZoneClusteringService,
        // findById consults sys_poi_ratings to gate the review aggregate; the
        // #809 review assertions below assume it's on (the default), so a stub
        // returning true preserves the real review-embed behaviour.
        {
          provide: FeatureResolver,
          useValue: { isSystemSwitchEnabled: () => Promise.resolve(true) },
        },
      ],
    }).compile();

    roads = module.get(RoadsService);
    funZones = module.get(FunZoneClusteringService);
    dataSource = module.get(getDataSourceToken());
  }, 30_000);

  afterAll(async () => {
    if (segmentIds.length > 0) {
      // Drop any fun-zones this test's segments were clustered into first (FK),
      // then the segments.
      const zoneRows: { fun_zone_id: string }[] = await dataSource.query(
        `SELECT DISTINCT fun_zone_id FROM fun_zone_roads
           WHERE road_segment_id = ANY($1::uuid[])`,
        [segmentIds],
      );
      const zoneIds = zoneRows.map((r) => r.fun_zone_id);
      if (zoneIds.length > 0) {
        await dataSource.query(
          `DELETE FROM fun_zone_roads WHERE fun_zone_id = ANY($1::uuid[])`,
          [zoneIds],
        );
        await dataSource.query(
          `DELETE FROM fun_zones WHERE id = ANY($1::uuid[])`,
          [zoneIds],
        );
      }
      await dataSource.query(
        `DELETE FROM surface_readings WHERE road_segment_id = ANY($1::uuid[])`,
        [segmentIds],
      );
      await dataSource.query(
        `DELETE FROM road_reviews WHERE road_segment_id = ANY($1::uuid[])`,
        [segmentIds],
      );
      await dataSource.query(
        `DELETE FROM road_segments WHERE id = ANY($1::uuid[])`,
        [segmentIds],
      );
    }
    await module?.close();
  });

  it('best-roads: aggregates an imported way, keeps a crowd segment, drops a short way', async () => {
    // Crowd-sourced 600 m segment (null osm_way_id) — unchanged behaviour.
    await insertSegment({
      name: 'e2e794-crowd',
      lng: DOLO_LNG,
      lat: DOLO_LAT,
      lengthM: 600,
    });
    // Imported way of 5×120 m sub-segments = 600 m → one aggregated best road.
    for (let i = 0; i < 5; i++) {
      await insertSegment({
        name: 'e2e794-long-way',
        osmWayId: '794000001',
        segmentIndex: i,
        lng: DOLO_LNG + 0.002,
        lat: DOLO_LAT + 0.01 + i * 0.0012,
        lengthM: 120,
      });
    }
    // Imported way of 2×100 m = 200 m → below 500 m, must NOT appear.
    for (let i = 0; i < 2; i++) {
      await insertSegment({
        name: 'e2e794-short-way',
        osmWayId: '794000002',
        segmentIndex: i,
        lng: DOLO_LNG + 0.004,
        lat: DOLO_LAT + 0.02 + i * 0.001,
        lengthM: 100,
      });
    }
    // Imported way of 5×120 m where one sub-segment is barely confident
    // (confidence 1). The whole 600 m way must still appear: confidence is
    // applied to the length-weighted aggregate ((60·4+1)/5 ≈ 48), not per
    // sub-segment — a pre-aggregation filter would drop the piece and shrink the
    // road to 480 m (< 500 m) and disqualify it.
    for (let i = 0; i < 5; i++) {
      await insertSegment({
        name: 'e2e794-mixed-conf',
        osmWayId: '794000003',
        segmentIndex: i,
        lng: DOLO_LNG + 0.006,
        lat: DOLO_LAT + 0.03 + i * 0.0012,
        lengthM: 120,
        confidence: i === 4 ? 1 : 60,
      });
    }

    const result = await roads.findBest({ country: 'it', region: 'dolomites' });
    const byName = (name: string) =>
      result.roads.filter((r) => r.road_name === name);

    // The 5 sub-segments collapse into exactly one ~600 m best road.
    expect(byName('e2e794-long-way')).toHaveLength(1);
    expect(byName('e2e794-long-way')[0]!.length_m).toBeCloseTo(600, 5);
    // Crowd segment unchanged.
    expect(byName('e2e794-crowd')).toHaveLength(1);
    expect(byName('e2e794-crowd')[0]!.length_m).toBeCloseTo(600, 5);
    // The 200 m way is filtered out — no stub as a "best road".
    expect(byName('e2e794-short-way')).toHaveLength(0);
    // The mixed-confidence way survives on its weighted-average confidence.
    expect(byName('e2e794-mixed-conf')).toHaveLength(1);
    expect(byName('e2e794-mixed-conf')[0]!.length_m).toBeCloseTo(600, 5);
  }, 30_000);

  it('fun-zones: clusters three imported ways as three roads, not fifteen stubs', async () => {
    // Three imported ways within DBSCAN eps at the origin (outside any region
    // bbox). Way 0's lowest-index sub-segment is UNASSESSED (quality NULL) and
    // its indices 1..5 are assessed (5×120 = 600 m); ways 1 & 2 are 5×120 m all
    // assessed. Aggregation must present three cluster members, not fifteen stubs.
    let way0Segment0Id = '';
    for (let w = 0; w < 3; w++) {
      const count = w === 0 ? 6 : 5;
      for (let i = 0; i < count; i++) {
        const id = await insertSegment({
          name: `e2e794-fz-${w}`,
          osmWayId: `7940100${w}`,
          segmentIndex: i,
          lng: 0.0 + w * 0.01,
          lat: 0.0 + i * 0.0012,
          lengthM: 120,
          // Way 0, index 0 is unassessed — the stability + assessed-length cases.
          quality: w === 0 && i === 0 ? null : 4.0,
          confidence: 60,
          curviness: 3.0,
        });
        if (w === 0 && i === 0) way0Segment0Id = id;
      }
    }
    // Way 2 also has an assessed sub-segment far outside the clustering bbox (a
    // border-crossing way). Clustering never sees it, so the zone detail must not
    // pull it into way 2's aggregate — the length must stay the in-zone 600 m.
    await insertSegment({
      name: 'e2e794-fz-2',
      osmWayId: '79401002',
      segmentIndex: 5,
      lng: 0.02,
      lat: 0.5, // outside bbox [-0.1, 0.1] and the zone boundary
      lengthM: 120,
      quality: 4.0,
      confidence: 60,
      curviness: 3.0,
    });

    const result = await funZones.runClustering({
      bbox: [-0.1, -0.1, 0.1, 0.1],
    });

    expect(result.zones_written).toBe(1);
    // 3 aggregated ways, NOT 16 raw sub-segments.
    expect(result.members_written).toBe(3);

    const zoneRows: { fun_zone_id: string }[] = await dataSource.query(
      `SELECT DISTINCT fun_zone_id FROM fun_zone_roads
         WHERE road_segment_id = ANY($1::uuid[])`,
      [segmentIds],
    );
    expect(zoneRows).toHaveLength(1);

    // Stable member id: way 0's representative is its lowest-index sibling
    // (index 0) even though that one is unassessed — so the id (and the zone
    // UUID derived from it) doesn't churn when index 0 later gains a reading.
    const memberRows: { road_segment_id: string }[] = await dataSource.query(
      `SELECT road_segment_id FROM fun_zone_roads
         WHERE road_segment_id = ANY($1::uuid[])`,
      [segmentIds],
    );
    expect(memberRows.map((r) => r.road_segment_id)).toContain(way0Segment0Id);

    // findZoneById shows each aggregated way at its assessed 600 m — way 0
    // excludes its unassessed index-0 segment, and way 2 excludes its far
    // out-of-zone sibling — not a 120 m stub, 720 m, or 720 m border overrun.
    const detail = await roads.findZoneById(zoneRows[0]!.fun_zone_id);
    expect(detail.top_roads).toHaveLength(3);
    for (const road of detail.top_roads) {
      expect(road.length_m).toBeCloseTo(600, 5);
    }

    // A stale membership whose way has no in-zone assessed segments must be
    // omitted, not turn the endpoint into a 500 (empty aggregate → null geom).
    const staleId = await insertSegment({
      name: 'e2e794-stale',
      osmWayId: '79409999',
      segmentIndex: 0,
      lng: 0.0,
      lat: 0.05,
      lengthM: 120,
      quality: null, // way has zero quality-bearing segments
    });
    await dataSource.query(
      `INSERT INTO fun_zone_roads (fun_zone_id, road_segment_id, contribution_score)
       VALUES ($1, $2, 0.9)`,
      [zoneRows[0]!.fun_zone_id, staleId],
    );

    const detail2 = await roads.findZoneById(zoneRows[0]!.fun_zone_id);
    expect(detail2.top_roads).toHaveLength(3); // stale road dropped, no 500
    expect(detail2.top_roads.some((r) => r.road_name === 'e2e794-stale')).toBe(
      false,
    );
  }, 30_000);

  it('road detail: aggregates the way + its community data across sub-segments (#809)', async () => {
    // A 5×120 m imported way, contiguous (each sub-segment starts where the last
    // ended) so its merged geometry is one continuous line.
    const wayIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      wayIds.push(
        await insertSegment({
          name: 'e2e809-way',
          osmWayId: '809000001',
          segmentIndex: i,
          lng: DOLO_LNG + 0.05,
          lat: DOLO_LAT + 0.05 + i * 0.001, // 0.001 span → contiguous
          lengthM: 120,
        }),
      );
    }
    const crowdId = await insertSegment({
      name: 'e2e809-crowd',
      lng: DOLO_LNG + 0.07,
      lat: DOLO_LAT + 0.07,
      lengthM: 300,
    });

    // Surface readings on TWO different sub-segments (indices 2 and 4) — not the
    // requested index 0 — so the detail's community data must span the whole way.
    const users: { id: string }[] = await dataSource.query(
      `SELECT id FROM users LIMIT 1`,
    );
    const userId = users[0]?.id ?? null;
    for (const [segIdx, cls] of [
      [2, 'good'],
      [2, 'good'],
      [4, 'excellent'],
    ] as [number, string][]) {
      await dataSource.query(
        `INSERT INTO surface_readings
           (road_segment_id, user_id, iri_value, classification, recorded_at)
         VALUES ($1, $2, 2.0, $3, NOW())`,
        [wayIds[segIdx], userId, cls],
      );
    }

    // Reviews on TWO different sub-segments (indices 1 + 4) — not the requested
    // index 0 — so the detail's review stats must span the whole way (#809). Two
    // distinct users (unique per (user_id, road_segment_id)); fall back to one if
    // the seed has only a single user.
    const reviewUsers: { id: string }[] = await dataSource.query(
      `SELECT id FROM users LIMIT 2`,
    );
    const haveReviews = reviewUsers.length >= 1;
    if (haveReviews) {
      const u0 = reviewUsers[0]!.id;
      const u1 = reviewUsers[1]?.id ?? reviewUsers[0]!.id;
      await dataSource.query(
        `INSERT INTO road_reviews (road_segment_id, user_id, rating)
         VALUES ($1, $2, 5)`,
        [wayIds[1], u0],
      );
      await dataSource.query(
        `INSERT INTO road_reviews (road_segment_id, user_id, rating)
         VALUES ($1, $2, 3)`,
        [wayIds[4], u1],
      );
    }

    const detail = await roads.findById(wayIds[0]!);
    // Whole way, not the 120 m child.
    expect(detail.length_m).toBeCloseTo(600, 5);
    expect(detail.geometry.length).toBeGreaterThan(2);
    // Breakdown counts the readings on indices 2 + 4 (2 good, 1 excellent → 67/33).
    expect(detail.quality_breakdown.good).toBe(67);
    expect(detail.quality_breakdown.excellent).toBe(33);
    expect(detail.riders_per_month).toBeGreaterThanOrEqual(userId ? 1 : 0);
    // Reviews aggregate across the way: both indices 1 + 4 count, avg (5+3)/2.
    if (haveReviews && reviewUsers.length >= 2) {
      expect(detail.review_count).toBe(2);
      expect(detail.avg_review_rating).toBeCloseTo(4.0, 5);
      expect(detail.recent_reviews).toHaveLength(2);
    }

    // The DTO id echoes the REQUESTED sub-segment (index 3, not the index-0
    // representative), but reviews still aggregate to the whole way, so the panel
    // (which resolves the same way) matches; the road is aggregated to 600 m.
    const detailMid = await roads.findById(wayIds[3]!);
    expect(detailMid.id).toBe(wayIds[3]);
    expect(detailMid.length_m).toBeCloseTo(600, 5); // whole road
    expect(detailMid.segment_length_m).toBeCloseTo(120, 5); // just this sub-segment
    if (haveReviews && reviewUsers.length >= 2) {
      expect(detailMid.review_count).toBe(2); // same whole-way reviews
    }

    // A crowd-sourced segment (null osm_way_id) is a group of one — unchanged.
    const crowdDetail = await roads.findById(crowdId);
    expect(crowdDetail.length_m).toBeCloseTo(300, 5);
  }, 30_000);
});
