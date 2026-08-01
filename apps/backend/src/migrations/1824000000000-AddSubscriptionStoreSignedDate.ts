import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Monotonic optimistic-concurrency ordering value for store (Apple) claims.
 *
 * The Apple claim / terminal-clear paths need a strictly-monotonic value to
 * order two overlapping validations for the SAME original transaction id: a
 * later store state has a strictly greater JWS `signedDate`. The existing period
 * (`subscription_current_period_end`) is INSUFFICIENT — an `active` state and a
 * later `revoked`/`expired` state for the same OTID can share the same period,
 * so a `<=` period guard lets a stale active snapshot resurrect a subscription a
 * concurrent terminal clear already killed.
 *
 * This column records the last-observed Apple `signedDate` (ms epoch → tstz) so
 * `claimForApple` / `clearAppleTerminal` can gate their guarded UPDATEs on it.
 * Nullable, no backfill — the IAP feature ships dark, so no existing row has an
 * Apple signed date to record.
 */
export class AddSubscriptionStoreSignedDate1824000000000 implements MigrationInterface {
  name = 'AddSubscriptionStoreSignedDate1824000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users
         ADD COLUMN subscription_store_signed_date TIMESTAMP WITH TIME ZONE NULL;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users
         DROP COLUMN IF EXISTS subscription_store_signed_date;`,
    );
  }
}
