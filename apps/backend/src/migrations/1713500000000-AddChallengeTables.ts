import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddChallengeTables1713500000000 implements MigrationInterface {
  name = 'AddChallengeTables1713500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE challenges (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(100) NOT NULL,
        description TEXT NOT NULL,
        metric VARCHAR(30) NOT NULL,
        target INT NOT NULL,
        starts_at TIMESTAMPTZ NOT NULL,
        ends_at TIMESTAMPTZ NOT NULL,
        reward_badge_key VARCHAR(50),
        is_active BOOLEAN NOT NULL DEFAULT true
      );
    `);

    await queryRunner.query(`
      CREATE TABLE challenge_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        progress FLOAT NOT NULL DEFAULT 0,
        completed BOOLEAN NOT NULL DEFAULT false,
        completed_at TIMESTAMPTZ,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT idx_challenge_entries_unique UNIQUE (challenge_id, user_id)
      );

      CREATE INDEX idx_challenge_entries_challenge ON challenge_entries (challenge_id);
      CREATE INDEX idx_challenge_entries_user ON challenge_entries (user_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS challenge_entries CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS challenges CASCADE`);
  }
}
