import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-47 — user-editable ride name.
 *
 * Nullable — UI falls back to `Ride on <date>` when unset. Populated
 * by the rename endpoint; GPX import may populate it later.
 */
export class AddRideName1713800000000 implements MigrationInterface {
  name = 'AddRideName1713800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // IF NOT EXISTS because docs/database/schema.sql — the baseline InitSchema1713
    // executes — is maintained as CURRENT state and already declares this column.
    // Existing databases ran this before that drift; a from-zero build finds it
    // present. See #1193.
    await queryRunner.query(
      `ALTER TABLE rides ADD COLUMN IF NOT EXISTS name VARCHAR(120)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE rides DROP COLUMN IF EXISTS name`);
  }
}
