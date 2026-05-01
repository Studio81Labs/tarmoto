import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #279 — typed privacy preferences. Replaces the freeform JSONB the
 * companion's privacy page was attempting to write into
 * `users.preferences` (the calls landed on a non-existent endpoint, so
 * the data path was a no-op, but the carry-forward below catches any
 * row that nonetheless ended up with a `privacy` key from a fixture or
 * an early experiment).
 *
 * Mirrors the shape used by the companion privacy page
 * (`apps/companion/src/lib/privacy-settings.ts`):
 *
 *   {
 *     profileVisibility: 'public' | 'riders-only' | 'private',
 *     defaultRideSharing: 'public' | 'private',
 *     roadDataContribution: boolean,
 *     locationRetention: '3months' | '6months' | '1year' | '2years' | 'forever',
 *     analyticsConsent: boolean,
 *     personalizedRecommendationsConsent: boolean,
 *   }
 *
 * Unknown values fall back to the canonical defaults via the
 * CASE / boolean coercion below — invalid enum strings would otherwise
 * blow up the column constraint and abort the entire migration.
 */
export class AddPrivacyPreferences1716400000000 implements MigrationInterface {
  name = 'AddPrivacyPreferences1716400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE privacy_preferences (
        user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        profile_visibility varchar(16) NOT NULL DEFAULT 'riders-only',
        default_ride_sharing varchar(16) NOT NULL DEFAULT 'private',
        road_data_contribution boolean NOT NULL DEFAULT TRUE,
        location_retention varchar(16) NOT NULL DEFAULT '1year',
        analytics_consent boolean NOT NULL DEFAULT TRUE,
        personalized_recommendations_consent boolean NOT NULL DEFAULT TRUE,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_privacy_preferences_retention
        ON privacy_preferences (location_retention)
        WHERE location_retention <> 'forever';
    `);

    // Helper that coerces a JSONB text value to a boolean WITHOUT
    // raising on a malformed string. A naive `(jsonb->>'k')::boolean`
    // raises `invalid input syntax for type boolean` on values like
    // `'yes'`, `'1'`, `'on'` or hand-edited blobs, which would abort
    // the whole migration. Only the canonical `true`/`false` strings
    // round-trip; anything else returns the supplied default so the
    // migration never blocks on a single weird row.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION pg_temp.tarmoto_safe_bool(
        src JSONB,
        fallback BOOLEAN
      ) RETURNS BOOLEAN
      LANGUAGE SQL IMMUTABLE AS $$
        SELECT CASE
          WHEN src IS NULL OR jsonb_typeof(src) = 'null' THEN fallback
          WHEN jsonb_typeof(src) = 'boolean' THEN (src::text)::boolean
          WHEN jsonb_typeof(src) = 'string'
            AND lower(src #>> '{}') IN ('true', 'false', 't', 'f', '1', '0', 'yes', 'no', 'on', 'off')
            THEN lower(src #>> '{}') IN ('true', 't', '1', 'yes', 'on')
          ELSE fallback
        END
      $$;
    `);

    // Carry forward any prior JSONB values written into
    // `users.preferences->'privacy'` (camelCase keys from the companion
    // shape). `ON CONFLICT DO NOTHING` covers the staged-rollout case
    // where someone already wrote through the typed endpoint before
    // this migration ran. Unknown enum values collapse to defaults so a
    // hand-edited blob can't fail the migration with a CHECK violation
    // — at column level we don't have one, but keeping the inputs in
    // the canonical set avoids surprising downstream readers.
    await queryRunner.query(`
      INSERT INTO privacy_preferences (
        user_id,
        profile_visibility,
        default_ride_sharing,
        road_data_contribution,
        location_retention,
        analytics_consent,
        personalized_recommendations_consent,
        created_at,
        updated_at
      )
      SELECT
        u.id,
        CASE
          WHEN u.preferences->'privacy'->>'profileVisibility'
            IN ('public', 'riders-only', 'private')
            THEN u.preferences->'privacy'->>'profileVisibility'
          ELSE 'riders-only'
        END,
        CASE
          WHEN u.preferences->'privacy'->>'defaultRideSharing'
            IN ('public', 'private')
            THEN u.preferences->'privacy'->>'defaultRideSharing'
          ELSE 'private'
        END,
        pg_temp.tarmoto_safe_bool(
          u.preferences->'privacy'->'roadDataContribution',
          TRUE
        ),
        CASE
          WHEN u.preferences->'privacy'->>'locationRetention'
            IN ('3months', '6months', '1year', '2years', 'forever')
            THEN u.preferences->'privacy'->>'locationRetention'
          ELSE '1year'
        END,
        pg_temp.tarmoto_safe_bool(
          u.preferences->'privacy'->'analyticsConsent',
          TRUE
        ),
        pg_temp.tarmoto_safe_bool(
          u.preferences->'privacy'->'personalizedRecommendationsConsent',
          TRUE
        ),
        NOW(),
        NOW()
      FROM users u
      WHERE u.preferences ? 'privacy'
        AND jsonb_typeof(u.preferences->'privacy') = 'object'
      ON CONFLICT (user_id) DO NOTHING;
    `);

    // Drop the legacy blob so the JSONB stops shadowing the typed
    // table. Other preferences (units, daily_km, etc.) stay intact.
    await queryRunner.query(`
      UPDATE users
      SET preferences = preferences - 'privacy'
      WHERE preferences ? 'privacy';
    `);

    // pg_temp.* functions die with the session; explicit DROP is
    // belt-and-braces in case the migration runner reuses the session.
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS pg_temp.tarmoto_safe_bool(JSONB, BOOLEAN);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Down is a no-op for the JSONB carry-forward (rebuilding it would
    // silently lose any updates posted through the typed endpoint
    // since this ran). The table itself can be dropped to revert the
    // schema; the JSONB shadow is gone.
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_privacy_preferences_retention;`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS privacy_preferences;`);
  }
}
