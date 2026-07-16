import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * #849 — index the geography cast used by the store-first radius + corridor
 * reads.
 *
 * `/poi/nearby`, `/poi/accommodations` and `/poi/along-route` (store path)
 * filter with `ST_DWithin(geom::geography, …, metres)` — geography, so the
 * buffer is real metres-on-the-sphere (the passes-module pattern). The existing
 * GiST index `idx_pois_geom` is on the raw `geom` (geometry), which PostGIS
 * cannot use for the `::geography` expression, so those reads would
 * sequential-scan as the import grows. A GiST index on the geography expression
 * makes them index-assisted. Additive — the geometry index stays for the
 * `ST_Intersects` bbox read (`/poi/in-bbox`). Not expressible via the `@Index`
 * decorator (a cast expression), so it lives here like `idx_pois_tags`.
 *
 * Built `CONCURRENTLY` so it never holds a write-blocking lock: this runs at
 * boot via `migrationsRun`, and at continent scale (millions of rows) a plain
 * `CREATE INDEX` would stall other instances + the import for minutes.
 * `CONCURRENTLY` cannot run in a transaction, so the POI datasource sets
 * `migrationsTransactionMode: 'none'` — safe, as every POI migration is a
 * single Postgres-atomic multi-statement query.
 */
export class AddPoiGeographyIndex1799000000000 implements MigrationInterface {
  name = "AddPoiGeographyIndex1799000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pois_geom_geography ON pois USING GIST ((geom::geography))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS idx_pois_geom_geography`,
    );
  }
}
