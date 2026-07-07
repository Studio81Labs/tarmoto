import { MigrationInterface, QueryRunner } from 'typeorm';

// ADR 0007: `pois` now lives in its own PostGIS instance. Drop the orphaned
// app-DB copy. Idempotent (IF EXISTS) so it is a no-op on a fresh app DB that
// never ran AddPois. One-way cutover — `down` is intentionally a no-op; the
// table is recreated in the POI DB by its own migration lineage, not here.
export class DropPois1797000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS pois');
  }

  public async down(): Promise<void> {
    // no-op: pois is owned by the separate POI database (ADR 0007).
  }
}
