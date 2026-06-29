import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTripDayStartLinked1718200000000 implements MigrationInterface {
  name = 'AddTripDayStartLinked1718200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE trip_days ADD COLUMN IF NOT EXISTS start_linked boolean NOT NULL DEFAULT false;',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE trip_days DROP COLUMN IF EXISTS start_linked;',
    );
  }
}
