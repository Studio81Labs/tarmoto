import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #850 — tombstone + region-discriminator columns for the continent-scale bulk
 * POI import.
 *
 * `deactivated_at`: soft-tombstone stamp. The bulk importer parses per-country
 * Geofabrik extracts and stale-by-absence tombstones rows absent from a region's
 * latest extract. Mirrors the roads importer's contract — an UPDATE, never a
 * DELETE, so history is retained and a re-import revives a reopened venue (the
 * upsert clears it). Store read paths (#849) filter `deactivated_at IS NULL`.
 *
 * `import_region`: the region code (`CZ`, `SK`, …) whose extract last wrote this
 * row. The default region bboxes are rectangles over non-rectangular countries,
 * so they overlap at borders; the tombstone pass scopes its stale-candidate load
 * to `import_region = <this region>` so a country only ever tombstones rows *it*
 * imported — never a neighbour's border POI that merely falls inside its bbox.
 *
 * Both additive + nullable → a non-blocking change on the existing table.
 */
export class AddPoiDeactivatedAt1798000000000 implements MigrationInterface {
  name = 'AddPoiDeactivatedAt1798000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE pois
        ADD COLUMN deactivated_at TIMESTAMPTZ,
        ADD COLUMN import_region VARCHAR(2);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE pois
        DROP COLUMN IF EXISTS import_region,
        DROP COLUMN IF EXISTS deactivated_at;
    `);
  }
}
