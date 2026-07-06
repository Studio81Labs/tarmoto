import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tier-aware feature entitlements (sibling nexcue/tabletap pattern).
 *
 * The flag vocabulary moves from operator-created `feature_flags` rows to
 * the code-defined registry in `@tarmoto/shared` (`FEATURE_DEFINITIONS`).
 * The database now stores only override state:
 *   - `user_features`  — per-user grant/revoke (row presence = override)
 *   - `feature_states` — global force_off (kill switch) / force_on clamp
 *
 * Every registry feature is seeded `force_on` so gating existing endpoints
 * (GPX export, commuter mode, group rides) changes nothing for current
 * users. Operators clear the overrides when tier enforcement goes live.
 *
 * The legacy free-form `feature_flags` table is dropped: its keys never
 * had client consumers (`GET /config/flags` shipped unconsumed) and its
 * on/off semantics are superseded by `feature_states`.
 */
export class AddTierFeatureEntitlements1795000000000 implements MigrationInterface {
  name = 'AddTierFeatureEntitlements1795000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE user_features (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        feature VARCHAR(64) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_user_features_user_feature UNIQUE (user_id, feature)
      );
      CREATE INDEX idx_user_features_feature ON user_features (feature);

      CREATE TABLE feature_states (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        feature VARCHAR(64) NOT NULL,
        state VARCHAR(16) NOT NULL
          CONSTRAINT feature_states_state_check
          CHECK (state IN ('force_off', 'force_on')),
        reason VARCHAR(500),
        updated_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX uq_feature_states_feature ON feature_states (feature);

      INSERT INTO feature_states (feature, state, reason)
      VALUES
        ('gpx_export', 'force_on', 'Launch mode: keep pre-entitlement access open until tier enforcement goes live.'),
        ('commuter_mode', 'force_on', 'Launch mode: keep pre-entitlement access open until tier enforcement goes live.'),
        ('group_rides', 'force_on', 'Launch mode: keep pre-entitlement access open until tier enforcement goes live.')
      ON CONFLICT DO NOTHING;

      DROP TABLE IF EXISTS feature_flags CASCADE;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE feature_flags (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key VARCHAR(128) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT false,
        description VARCHAR(500),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX uq_feature_flags_key ON feature_flags (key);

      DROP TABLE IF EXISTS feature_states CASCADE;
      DROP TABLE IF EXISTS user_features CASCADE;
    `);
  }
}
