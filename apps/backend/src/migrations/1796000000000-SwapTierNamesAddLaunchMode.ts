import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Three related changes to the tier/entitlement model:
 *
 * 1. Swap the paid tier names. The marketing page shipped the €29.99 mid
 *    tier as "Premium" and the €49.99 top tier as "Pro"; the decided
 *    naming is the other way around — `pro` = €29.99 mid tier,
 *    `premium` = €49.99 top tier. Existing rows swap values so every
 *    user keeps the plan (price point / feature set) they had.
 *    NOTE: Stripe products/prices use `pro`/`premium` lookup keys and the
 *    TARMOTO_STRIPE_{PREMIUM,PRO}_PRICE_ID env vars — those must be
 *    re-pointed to the matching amounts when billing goes live.
 *
 * 2. `users.plan_source` — tier provenance (`subscription` | `founder` |
 *    `promo` | `admin`); `founder` marks launch-mode auto-grants.
 *
 * 3. `app_settings` — generic operator key/value store backing the
 *    launch-mode tier grant (`launch_tier` = pro | premium; no row = off).
 *
 * Also seeds `force_on` for `unlimited_trip_planning` and
 * `full_road_quality_zoom`: both features are live and open to everyone
 * today, so flagging them must not regress free users until operators
 * clear the override (same launch-mode reasoning as 1795).
 */
export class SwapTierNamesAddLaunchMode1796000000000 implements MigrationInterface {
  name = 'SwapTierNamesAddLaunchMode1796000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE users SET subscription_tier = CASE subscription_tier
        WHEN 'premium' THEN 'pro'
        WHEN 'pro' THEN 'premium'
        ELSE subscription_tier
      END
      WHERE subscription_tier IN ('premium', 'pro');

      ALTER TABLE users ADD COLUMN plan_source VARCHAR(32);

      CREATE TABLE app_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key VARCHAR(64) NOT NULL,
        value VARCHAR(256) NOT NULL,
        updated_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX uq_app_settings_key ON app_settings (key);

      INSERT INTO feature_states (feature, state, reason)
      VALUES
        ('unlimited_trip_planning', 'force_on', 'Launch mode: keep pre-entitlement access open until tier enforcement goes live.'),
        ('full_road_quality_zoom', 'force_on', 'Launch mode: keep pre-entitlement access open until tier enforcement goes live.')
      ON CONFLICT DO NOTHING;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM feature_states
      WHERE feature IN ('unlimited_trip_planning', 'full_road_quality_zoom');

      DROP TABLE IF EXISTS app_settings CASCADE;

      ALTER TABLE users DROP COLUMN IF EXISTS plan_source;

      UPDATE users SET subscription_tier = CASE subscription_tier
        WHEN 'premium' THEN 'pro'
        WHEN 'pro' THEN 'premium'
        ELSE subscription_tier
      END
      WHERE subscription_tier IN ('premium', 'pro');
    `);
  }
}
