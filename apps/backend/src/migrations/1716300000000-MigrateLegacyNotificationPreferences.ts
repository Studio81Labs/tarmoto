import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #278 — carry forward freeform notification settings out of
 * `users.preferences` JSONB into the typed `notification_preferences`
 * table introduced by #275.
 *
 * Pre-#275 the companion saved a freeform blob to `PATCH /users/me`
 * shaped roughly like:
 *
 *   {
 *     emailDigest: 'weekly' | 'daily' | 'never',
 *     marketingEmails: boolean,
 *     hazardAlertsSavedRoutes: { email, push },
 *     newFollowers:           { email, push },
 *     routeComments:          { email, push },
 *     rideLikes:              { email, push },
 *     tripCollaboration:      { email, push },
 *   }
 *
 * The companion controls map onto the canonical `NotificationCategory`
 * taxonomy from `@tarmoto/shared`. This migration:
 *
 *   1. Inserts a `notification_preferences` row for every user with a
 *      legacy `preferences->'notifications'` blob, translating the
 *      camelCase keys to the typed columns / category JSONB.
 *   2. Strips `notifications` out of `users.preferences` so the JSONB
 *      stops being a parallel source of truth — the typed endpoint is
 *      now authoritative.
 *
 * The carry-forward is best-effort: unknown keys in the legacy blob are
 * dropped, and missing keys keep the canonical defaults from
 * `@tarmoto/shared` (handled at read time by `mergeWithDefaults`).
 */
export class MigrateLegacyNotificationPreferences1716300000000 implements MigrationInterface {
  name = 'MigrateLegacyNotificationPreferences1716300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Install a temporary helper that maps the legacy {email, push}
    // channel object onto the canonical {email, push, in_app} JSONB.
    // `in_app` defaults to TRUE so users keep seeing in-app banners
    // they never opted out of pre-cutover. Returns NULL when the source
    // is missing/non-object so `jsonb_strip_nulls` below drops the key.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION pg_temp.tarmoto_legacy_channel(src JSONB)
      RETURNS JSONB
      LANGUAGE SQL IMMUTABLE AS $$
        SELECT CASE
          WHEN src IS NULL OR jsonb_typeof(src) <> 'object' THEN NULL
          ELSE jsonb_build_object(
            'email',  COALESCE((src->>'email')::boolean, FALSE),
            'push',   COALESCE((src->>'push')::boolean,  FALSE),
            'in_app', COALESCE((src->>'in_app')::boolean, TRUE)
          )
        END
      $$;
    `);

    // ON CONFLICT DO NOTHING: #275 created the table empty, but if a
    // user happened to write preferences to the typed endpoint before
    // this migration ran (e.g. during a staged rollout), the typed row
    // is canonical — don't clobber it with the legacy blob.
    //
    // Categories without legacy keys (`crash_followup`, `weather_alert`,
    // `subscription_billing`) are deliberately omitted; the read-time
    // merge fills them from `@tarmoto/shared` defaults.
    await queryRunner.query(`
      INSERT INTO notification_preferences (
        user_id,
        email_digest,
        marketing_emails,
        quiet_hours_start,
        quiet_hours_end,
        quiet_hours_timezone,
        categories,
        created_at,
        updated_at
      )
      SELECT
        u.id,
        COALESCE(
          NULLIF(u.preferences->'notifications'->>'emailDigest', ''),
          'weekly'
        ),
        COALESCE(
          (u.preferences->'notifications'->>'marketingEmails')::boolean,
          FALSE
        ),
        0,
        0,
        'UTC',
        jsonb_strip_nulls(jsonb_build_object(
          'hazard_alert',
          pg_temp.tarmoto_legacy_channel(
            u.preferences->'notifications'->'hazardAlertsSavedRoutes'
          ),
          'trip_collaboration',
          pg_temp.tarmoto_legacy_channel(
            u.preferences->'notifications'->'tripCollaboration'
          ),
          'new_follower',
          pg_temp.tarmoto_legacy_channel(
            u.preferences->'notifications'->'newFollowers'
          ),
          'route_comment',
          pg_temp.tarmoto_legacy_channel(
            u.preferences->'notifications'->'routeComments'
          ),
          'ride_like',
          pg_temp.tarmoto_legacy_channel(
            u.preferences->'notifications'->'rideLikes'
          )
        )),
        NOW(),
        NOW()
      FROM users u
      WHERE u.preferences ? 'notifications'
        AND jsonb_typeof(u.preferences->'notifications') = 'object'
      ON CONFLICT (user_id) DO NOTHING;
    `);

    // Drop the legacy notifications blob so the JSONB stops shadowing
    // the typed table. Other preferences (units, daily_km, etc.) stay.
    await queryRunner.query(`
      UPDATE users
      SET preferences = preferences - 'notifications'
      WHERE preferences ? 'notifications';
    `);

    // pg_temp.* functions die with the session; explicit DROP is just
    // belt-and-braces in case the migration runner reuses the session.
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS pg_temp.tarmoto_legacy_channel(JSONB);
    `);
  }

  public async down(): Promise<void> {
    // Down is a no-op on purpose: rebuilding the legacy JSONB from the
    // typed table would silently lose any preferences the user has
    // written through the typed endpoint since the migration ran (new
    // columns like quiet_hours_*, new categories like crash_followup,
    // marketing toggles flipped after the cutover). Restoring the
    // pre-#278 schema requires a backup, not a reverse migration.
  }
}
