import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-40 — road closures with date ranges.
 *
 * Adds the `road_closures` table for operator-entered road closures,
 * roadworks, and other temporary restrictions affecting a road stretch
 * over a date window. Population is manual to start; future sources
 * (OSM live feeds, official road-authority APIs) use the same table
 * with a different `source` value.
 */
export class AddRoadClosures1714100000000 implements MigrationInterface {
  name = 'AddRoadClosures1714100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE road_closures (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(160) NOT NULL,
        reason VARCHAR(20) NOT NULL
          CHECK (reason IN ('closure', 'roadworks', 'seasonal', 'weather', 'event', 'other')),
        severity VARCHAR(20) NOT NULL
          CHECK (severity IN ('advisory', 'partial', 'full')),
        geom GEOMETRY(LineString, 4326) NOT NULL,
        country_code VARCHAR(2) NOT NULL,
        region VARCHAR(120),
        starts_at TIMESTAMPTZ NOT NULL,
        ends_at TIMESTAMPTZ,
        notes TEXT,
        source VARCHAR(20) NOT NULL DEFAULT 'operator'
          CHECK (source IN ('operator', 'osm', 'official')),
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (ends_at IS NULL OR ends_at >= starts_at)
      );

      CREATE INDEX idx_road_closures_geom ON road_closures USING GIST (geom);
      CREATE INDEX idx_road_closures_country ON road_closures (country_code);
      CREATE INDEX idx_road_closures_window ON road_closures (starts_at, ends_at);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS road_closures CASCADE`);
  }
}
