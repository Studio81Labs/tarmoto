import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddChallengeContentKey1816000000000 implements MigrationInterface {
  name = 'AddChallengeContentKey1816000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE challenges
      ADD COLUMN content_key VARCHAR(50)
    `);
    await queryRunner.query(`
      UPDATE challenges
      SET content_key = CASE
        WHEN metric IN (
          'total_distance', 'single_ride', 'ride_count',
          'roads_discovered', 'reviews_written',
          'hazards_reported', 'rides_shared'
        ) THEN metric
        ELSE 'generic'
      END
    `);
    await queryRunner.query(`
      ALTER TABLE challenges
      ALTER COLUMN content_key SET NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE challenges
      ADD CONSTRAINT chk_challenges_content_key
      CHECK (content_key IN (
        'total_distance', 'single_ride', 'ride_count',
        'roads_discovered', 'reviews_written',
        'hazards_reported', 'rides_shared', 'generic'
      ))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE challenges DROP CONSTRAINT chk_challenges_content_key
    `);
    await queryRunner.query(`
      ALTER TABLE challenges DROP COLUMN content_key
    `);
  }
}
