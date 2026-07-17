import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Numeric limit entitlements (sibling of 1795000000000-AddTierFeatureEntitlements,
 * the toggle-feature pair).
 *
 * The limit vocabulary lives in the same code-defined registry in
 * `@tarmoto/shared` (`FEATURE_DEFINITIONS`), but numeric limits need a
 * `value` rather than a boolean, so they get their own override pair:
 *   - `user_limits`  — per-user override (row presence = override; `value`
 *                      replaces the tier value, `NULL` = unlimited)
 *   - `limit_states` — global override (one row per feature key; `value`
 *                      replaces the tier layer for everyone, `NULL` =
 *                      unlimited); an explicit per-user override still
 *                      wins when it is MORE restrictive (min)
 *
 * `max_active_trips` is seeded `NULL` (unlimited) so tier caps stay dark
 * — launch mode — until monetization goes live, mirroring how 1795 seeded
 * every toggle feature `force_on`.
 */
export class AddLimitEntitlements1812000000000 implements MigrationInterface {
  name = 'AddLimitEntitlements1812000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE user_limits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        feature VARCHAR(64) NOT NULL,
        value INTEGER CHECK (value IS NULL OR value >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_user_limits_user_feature UNIQUE (user_id, feature)
      );
      CREATE INDEX idx_user_limits_feature ON user_limits (feature);

      CREATE TABLE limit_states (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        feature VARCHAR(64) NOT NULL,
        value INTEGER CHECK (value IS NULL OR value >= 0),
        reason VARCHAR(500),
        updated_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX uq_limit_states_feature ON limit_states (feature);

      INSERT INTO limit_states (feature, value, reason)
      VALUES ('max_active_trips', NULL, 'Launch mode: unlimited for everyone until tier enforcement goes live.')
      ON CONFLICT DO NOTHING;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS limit_states CASCADE;
      DROP TABLE IF EXISTS user_limits CASCADE;
    `);
  }
}
