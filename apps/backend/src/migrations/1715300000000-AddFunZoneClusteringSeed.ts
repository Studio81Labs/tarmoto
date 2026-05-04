import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-6 — fun-zone clustering seed.
 *
 * Two pieces:
 *   1. Install the deterministic clustering SQL as a stored function
 *      (`cluster_fun_zones`) so anyone can re-cluster from psql or via
 *      a backup-restore step without booting the Nest app. The Nest
 *      service in TypeScript still drives clustering for normal runs
 *      because it owns the scoring formula — this function writes the
 *      same shape but is intended for ops/manual recovery.
 *   2. Outside production, seed a small set of demo road segments in
 *      the curated regions and run one full clustering pass so a fresh
 *      dev or test DB has non-empty `fun_zones`. Production is skipped
 *      to avoid polluting real road data — production gets fun zones
 *      from the rider-driven clustering CLI.
 *
 * Idempotency: every demo insert checks for existing rows by a
 * `seed:` prefix on `road_name`, so re-running is a no-op. The
 * clustering pass uses deterministic UUIDs and is itself idempotent.
 */
export class AddFunZoneClusteringSeed1715300000000 implements MigrationInterface {
  name = 'AddFunZoneClusteringSeed1715300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Stored function: deterministic, idempotent clustering. ──
    // Mirrors the TypeScript scoring weights so an ad-hoc psql run
    // produces zones with a comparable shape. The TS service stays the
    // source of truth (uses the same uuid namespace and formula).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION cluster_fun_zones(
        p_min_curviness FLOAT DEFAULT 2.0,
        p_min_quality FLOAT DEFAULT 3.0,
        p_min_confidence INT DEFAULT 50,
        p_min_segment_length_m FLOAT DEFAULT 500,
        p_eps_degrees FLOAT DEFAULT 0.045,
        p_min_points INT DEFAULT 3,
        p_min_roads_per_zone INT DEFAULT 3,
        p_hull_buffer_m FLOAT DEFAULT 250
      ) RETURNS INT AS $$
      DECLARE
        v_namespace UUID := '47b1a8a9-8d67-4b28-9a1c-6cb72d6c4f01'::uuid;
        v_written INT := 0;
      BEGIN
        DROP TABLE IF EXISTS tmp_fz_clusters;
        CREATE TEMP TABLE tmp_fz_clusters AS
        WITH eligible AS (
          SELECT id, geom, curviness_score, quality_score, length_m,
                 elevation_min, elevation_max
          FROM road_segments
          WHERE curviness_score >= p_min_curviness
            AND quality_score IS NOT NULL
            AND quality_score >= p_min_quality
            AND confidence >= p_min_confidence
            AND length_m >= p_min_segment_length_m
        ),
        clustered AS (
          SELECT
            id, geom, curviness_score, quality_score, length_m,
            elevation_min, elevation_max,
            ST_ClusterDBSCAN(geom, eps := p_eps_degrees, minpoints := p_min_points)
              OVER (ORDER BY id) AS cluster_seed
          FROM eligible
        )
        SELECT
          uuid_generate_v5(
            v_namespace,
            array_to_string(array_agg(id::text ORDER BY id), ',')
          ) AS zone_id,
          array_agg(id ORDER BY id) AS member_ids,
          array_agg(curviness_score ORDER BY id) AS curviness_scores,
          array_agg(quality_score ORDER BY id) AS quality_scores,
          array_agg(length_m ORDER BY id) AS lengths_m,
          AVG(curviness_score) AS avg_curviness,
          AVG(quality_score) AS avg_quality,
          (SUM(CASE WHEN curviness_score >= 3.0 THEN length_m ELSE 0 END) / 1000.0)
            AS total_curve_km,
          COALESCE(MAX(elevation_max) - MIN(elevation_min), 0) AS elevation_range_m,
          COUNT(*) AS road_count,
          ST_ConvexHull(
            ST_Buffer(ST_Collect(geom)::geography, p_hull_buffer_m)::geometry
          ) AS boundary
        FROM clustered
        WHERE cluster_seed IS NOT NULL
        GROUP BY cluster_seed
        HAVING COUNT(*) >= p_min_roads_per_zone;

        -- Composite score (matches TS weights: 0.40/0.25/0.15/0.15/0.05).
        -- Scenic stays 0 until a real source is wired.
        WITH scored AS (
          SELECT
            zone_id,
            ROUND((
              (
                0.40 * LEAST(GREATEST(avg_curviness / 5.0, 0), 1)
                + 0.25 * LEAST(GREATEST((avg_quality - 1) / 4.0, 0), 1)
                + 0.15 * LEAST(GREATEST(elevation_range_m / 1500.0, 0), 1)
                + 0.15 * LEAST(GREATEST(road_count::float / 30.0, 0), 1)
              ) * 100.0
            )::numeric, 2)::float AS composite_score
          FROM tmp_fz_clusters
        ),
        seasoned AS (
          SELECT
            t.zone_id,
            CASE
              WHEN EXISTS (
                SELECT 1 FROM mountain_passes mp
                WHERE ST_Intersects(mp.location, t.boundary)
                  AND NOT (mp.typical_open_month = 1 AND mp.typical_close_month = 12)
              ) THEN 'summer'
              ELSE 'year_round'
            END AS best_season
          FROM tmp_fz_clusters t
        )
        INSERT INTO fun_zones
          (id, boundary, composite_score, road_count,
           total_curve_km, avg_quality, best_season, last_calculated)
        SELECT
          t.zone_id,
          t.boundary,
          s.composite_score,
          t.road_count::int,
          t.total_curve_km,
          ROUND(t.avg_quality::numeric, 2)::float,
          se.best_season,
          NOW()
        FROM tmp_fz_clusters t
        JOIN scored s ON s.zone_id = t.zone_id
        JOIN seasoned se ON se.zone_id = t.zone_id
        ON CONFLICT (id) DO UPDATE SET
          boundary = EXCLUDED.boundary,
          composite_score = EXCLUDED.composite_score,
          road_count = EXCLUDED.road_count,
          total_curve_km = EXCLUDED.total_curve_km,
          avg_quality = EXCLUDED.avg_quality,
          best_season = EXCLUDED.best_season,
          last_calculated = NOW();

        -- Replace member rows for the zones we just touched. Stale
        -- members from previous runs disappear via the CASCADE on
        -- fun_zone_id when the parent zone is deleted below.
        DELETE FROM fun_zone_roads
        WHERE fun_zone_id IN (SELECT zone_id FROM tmp_fz_clusters);

        INSERT INTO fun_zone_roads (fun_zone_id, road_segment_id, contribution_score)
        SELECT
          t.zone_id,
          m.member_id,
          ROUND(
            (
              LEAST(GREATEST(m.curviness / 5.0, 0), 1)
              * LEAST(GREATEST((COALESCE(m.quality, 1) - 1) / 4.0, 0), 1)
              * LEAST(GREATEST(m.length_m / 5000.0, 0), 1)
            )::numeric, 3)::float
        FROM tmp_fz_clusters t
        CROSS JOIN LATERAL ROWS FROM(
          UNNEST(t.member_ids),
          UNNEST(t.curviness_scores),
          UNNEST(t.quality_scores),
          UNNEST(t.lengths_m)
        ) AS m(member_id UUID, curviness FLOAT, quality FLOAT, length_m FLOAT);

        -- Prune zones that disappeared from the latest run so the
        -- table stays in sync with the input data.
        --
        -- Guard against a zero-candidate run: with tmp_fz_clusters
        -- empty, "id NOT IN (SELECT zone_id FROM tmp_fz_clusters)"
        -- evaluates to TRUE for every row and nukes the whole table.
        -- The TS service has the same guard in persistZones; the
        -- stored function (ops escape hatch) needs to mirror it so a
        -- bad parameter set can't cause silent data loss.
        IF EXISTS (SELECT 1 FROM tmp_fz_clusters) THEN
          DELETE FROM fun_zones
          WHERE id NOT IN (SELECT zone_id FROM tmp_fz_clusters);
        ELSE
          RAISE WARNING 'cluster_fun_zones produced 0 candidates; skipping prune to avoid wiping fun_zones';
        END IF;

        SELECT COUNT(*)::int INTO v_written FROM tmp_fz_clusters;
        DROP TABLE tmp_fz_clusters;
        RETURN v_written;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // ── 2. Demo seed for dev / test only. Default-safe: skip
    // unless the operator has explicitly declared a non-production
    // environment. A missing `TARMOTO_NODE_ENV` (common on a
    // production restore that only sets DB credentials) MUST NOT
    // be treated as "development" — that would let synthetic
    // road_segments + a recluster mutate real production data. Only
    // these explicit values turn the seed on. ──
    const SEED_ENVS = new Set(['development', 'test']);
    const env = process.env['TARMOTO_NODE_ENV'];
    if (!env || !SEED_ENVS.has(env)) {
      return;
    }

    // Insert a dozen synthetic curvy segments per region. Tagged with
    // `seed:` prefix on road_name so they're recognisable. Idempotent
    // because we only insert when no existing seed segments exist.
    const existing = (await queryRunner.query(
      `SELECT COUNT(*)::int AS count
       FROM road_segments
       WHERE road_name LIKE 'seed:%'`,
    )) as Array<{ count: number }>;

    if (existing[0].count > 0) {
      return;
    }

    // Each tuple is (lng, lat) center; we synthesise three short
    // overlapping curvy LineStrings around it so DBSCAN groups them
    // into a single zone. Quality/curviness/elevation set to values
    // that produce non-trivial composite scores after clustering.
    const seeds: Array<{
      region: string;
      lng: number;
      lat: number;
      curviness: number;
      quality: number;
      elevMin: number;
      elevMax: number;
    }> = [
      // Beskydy, CZ (forested ridges, ~1300m peak)
      {
        region: 'beskydy',
        lng: 18.43,
        lat: 49.55,
        curviness: 4.2,
        quality: 4.3,
        elevMin: 600,
        elevMax: 1300,
      },
      {
        region: 'beskydy',
        lng: 18.5,
        lat: 49.58,
        curviness: 3.8,
        quality: 4.1,
        elevMin: 600,
        elevMax: 1300,
      },
      // Jeseníky, CZ (open highland, ~1500m)
      {
        region: 'jeseniky',
        lng: 17.22,
        lat: 50.05,
        curviness: 3.9,
        quality: 4.0,
        elevMin: 700,
        elevMax: 1500,
      },
      // Šumava, CZ (long forest sweepers, lower elevation)
      {
        region: 'sumava',
        lng: 13.85,
        lat: 48.95,
        curviness: 3.5,
        quality: 4.2,
        elevMin: 700,
        elevMax: 1300,
      },
      // Tyrol, AT (high alpine)
      {
        region: 'tyrol',
        lng: 11.4,
        lat: 47.2,
        curviness: 4.6,
        quality: 4.5,
        elevMin: 800,
        elevMax: 2500,
      },
      {
        region: 'tyrol',
        lng: 11.1,
        lat: 46.91,
        curviness: 4.4,
        quality: 4.4,
        elevMin: 1000,
        elevMax: 2500,
      },
      // Dolomites, IT (jagged passes)
      {
        region: 'dolomites',
        lng: 11.81,
        lat: 46.49,
        curviness: 4.7,
        quality: 4.5,
        elevMin: 1200,
        elevMax: 2700,
      },
    ];

    for (const seed of seeds) {
      // Three overlapping segments per cluster centre so DBSCAN groups
      // them into a single zone (minpoints = 3). Offsets are roughly
      // 1.5km apart; well under the eps default of 0.045°.
      const offsets: Array<[number, number]> = [
        [0, 0],
        [0.012, 0.008],
        [-0.01, 0.014],
      ];
      for (const [dx, dy] of offsets) {
        const lng = seed.lng + dx;
        const lat = seed.lat + dy;
        const seg2Lng = lng + 0.008;
        const seg2Lat = lat + 0.005;
        const seg3Lng = lng + 0.015;
        const seg3Lat = lat - 0.002;
        await queryRunner.query(
          `INSERT INTO road_segments (
             id, geom, length_m, road_name, road_number,
             curviness_score, quality_score, surface_type,
             reading_count, confidence, elevation_min, elevation_max,
             elevation_profile, last_updated
           ) VALUES (
             uuid_generate_v4(),
             ST_GeomFromText(
               'LINESTRING(' ||
               $1 || ' ' || $2 || ',' ||
               $3 || ' ' || $4 || ',' ||
               $5 || ' ' || $6 || ')',
               4326
             ),
             $7, $8, NULL, $9, $10, 'asphalt', 12, 80, $11, $12,
             ARRAY[$11::float, ($11+$12)/2.0, $12::float], NOW()
           )`,
          [
            lng,
            lat,
            seg2Lng,
            seg2Lat,
            seg3Lng,
            seg3Lat,
            1800,
            `seed:${seed.region}`,
            seed.curviness,
            seed.quality,
            seed.elevMin,
            seed.elevMax,
          ],
        );
      }
    }

    // Run the freshly installed clustering function so the seed is
    // immediately reflected in `fun_zones`/`fun_zone_roads`.
    await queryRunner.query(`SELECT cluster_fun_zones()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop ONLY zones whose membership is entirely seed roads —
    // those are zones the seed run created and that have no real
    // (rider-driven) members. The predicate explicitly rejects NULL
    // `road_name` rows because `bool_and` IGNORES nulls — without
    // the `IS NOT NULL` guard, a mixed zone containing one seed
    // member plus one real member with a NULL road_name would
    // collapse to TRUE and get deleted by mistake. Mixed zones
    // (seed + real members) are preserved here; the next step strips
    // the seed memberships out of them so the real roads keep their
    // zone associations. In production no seed roads exist, so the
    // whole sequence is a no-op.
    await queryRunner.query(
      `DELETE FROM fun_zones WHERE id IN (
         SELECT fzr.fun_zone_id
         FROM fun_zone_roads fzr
         JOIN road_segments rs ON rs.id = fzr.road_segment_id
         GROUP BY fzr.fun_zone_id
         HAVING bool_and(rs.road_name IS NOT NULL AND rs.road_name LIKE 'seed:%')
       )`,
    );
    // For zones that survived above (i.e. had at least one real-road
    // member), drop just the seed-road memberships. This keeps the
    // mixed zones intact while freeing the FK on `road_segments` so
    // the seed-segment delete below can run.
    await queryRunner.query(
      `DELETE FROM fun_zone_roads WHERE road_segment_id IN
         (SELECT id FROM road_segments WHERE road_name LIKE 'seed:%')`,
    );
    await queryRunner.query(
      `DELETE FROM road_segments WHERE road_name LIKE 'seed:%'`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS cluster_fun_zones(
      FLOAT, FLOAT, INT, FLOAT, FLOAT, INT, INT, FLOAT
    )`);
  }
}
