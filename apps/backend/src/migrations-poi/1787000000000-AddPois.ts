import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #745 — store POIs in PostGIS for offline use.
 *
 * Until now the planner fetched POIs live from Overpass per request, which
 * can't work offline and depends on Overpass uptime. The scheduled import
 * mirrors a configured area into `pois`, upserting by `(source,
 * external_id)` so re-runs are idempotent. Offline packs / a POI map tile
 * layer read from here.
 *
 * `source` keeps OSM and (future) Overture as separate joinable layers.
 * The unique index is plain (both columns are NOT NULL, so no NULL-skip
 * concern). GiST on `geom` for spatial reads; b-tree on `kind` for
 * category filters.
 */
export class AddPois1787000000000 implements MigrationInterface {
  name = 'AddPois1787000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      -- The standalone POI database (ADR 0007) never runs the app database's
      -- schema setup (InitSchema / schema.sql), which is where the app DB's
      -- PostGIS extension gets enabled. This lineage owns its own database
      -- end-to-end, so it must bootstrap PostGIS itself before the first
      -- migration that needs the \`geometry\` type. \`IF NOT EXISTS\` keeps
      -- this idempotent for the postgis/postgis Docker image, which already
      -- enables the extension in its default database.
      CREATE EXTENSION IF NOT EXISTS postgis;

      CREATE TABLE pois (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source VARCHAR(32) NOT NULL,
        external_id VARCHAR(128) NOT NULL,
        kind VARCHAR(32) NOT NULL,
        name VARCHAR(255),
        website VARCHAR(512),
        -- Wide enough for OSM's semicolon-separated multi-number phone
        -- tags; the import also truncates to these widths defensively so a
        -- pathological upstream value can never fail the whole upsert chunk.
        phone VARCHAR(255),
        geom GEOMETRY(Point, 4326) NOT NULL,
        last_imported_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX uq_pois_source_external ON pois (source, external_id);
      CREATE INDEX idx_pois_geom ON pois USING GIST (geom);
      CREATE INDEX idx_pois_kind ON pois (kind);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS pois;`);
  }
}
