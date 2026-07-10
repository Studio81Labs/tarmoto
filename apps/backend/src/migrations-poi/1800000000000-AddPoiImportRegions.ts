import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #944 — schema for region-polygon POI import coverage.
 *
 * Coverage has so far been proximity/bbox-based (see `import_region` on
 * `pois`, #850), which over- and under-covers at borders. This table holds
 * one row per import region — a country/subdivision code and its real
 * boundary polygon — so later work can test "is this point inside an
 * imported region" with `ST_Covers(geom, point)` instead of a bbox or radius
 * guess.
 *
 * Schema-only: no importer populates or reads this table yet (follow-up
 * work). `imported_at` is nullable so a region row can be seeded (boundary
 * loaded) before its first import run stamps it. GiST on `geom` for the
 * `ST_Covers` membership queries this unlocks.
 */
export class AddPoiImportRegions1800000000000 implements MigrationInterface {
  name = 'AddPoiImportRegions1800000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "poi_import_regions" (
        "code" varchar(2) PRIMARY KEY,
        "geom" geometry(MultiPolygon, 4326) NOT NULL,
        "imported_at" timestamptz NULL
      );

      CREATE INDEX "poi_import_regions_geom_gix"
        ON "poi_import_regions" USING GIST ("geom");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "poi_import_regions_geom_gix";
      DROP TABLE IF EXISTS "poi_import_regions";
    `);
  }
}
