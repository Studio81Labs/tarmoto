import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enforce MONOTONICITY of `users.subscription_notify_generation` at the DATABASE
 * boundary — the exact sibling of the `subscription_lock_fence` trigger
 * (migration 1827).
 *
 * The generation is only ever ADVANCED by `AccountService.nextNotifyGeneration`
 * (a fence-guarded `... + 1` on a raw UPDATE). But it is an ordinary mapped,
 * default-selected column, so an UNRELATED whole-entity save can clobber it:
 * `UsersService.updateProfile` / `uploadAvatar` load a `User` (generation = N),
 * a Stripe transition then advances it to N+1 and enqueues that job, and the
 * profile save re-persists every column — writing the stale N back. The worker
 * would then drop the valid N+1 notification (generation no longer matches), and
 * an older generation-N job could become eligible again.
 *
 * A `BEFORE UPDATE` row trigger clamps any UPDATE that would DECREASE the
 * generation back to the stored value — so no code path (ORM save, repository
 * update, raw SQL) can lower it, while the legitimate `... + 1` advance passes
 * through untouched. Cheaper and more robust than excluding the column from every
 * entity-save site.
 */
export class AddSubscriptionNotifyGenerationMonotonicTrigger1829000000000 implements MigrationInterface {
  name = 'AddSubscriptionNotifyGenerationMonotonicTrigger1829000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION users_subscription_notify_generation_monotonic()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.subscription_notify_generation < OLD.subscription_notify_generation THEN
          NEW.subscription_notify_generation := OLD.subscription_notify_generation;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_users_subscription_notify_generation_monotonic
        BEFORE UPDATE ON users
        FOR EACH ROW
        EXECUTE FUNCTION users_subscription_notify_generation_monotonic();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_users_subscription_notify_generation_monotonic ON users;`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS users_subscription_notify_generation_monotonic();`,
    );
  }
}
