import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enforce MONOTONICITY of `users.subscription_lock_fence` at the DATABASE
 * boundary, so it can never regress regardless of the write path.
 *
 * The fence is only ever ADVANCED by the subscription-mutation lock's guarded
 * writes (each gated on `subscription_lock_fence <= :token`, so they never lower
 * it). But the column is an ordinary mapped, default-selected column, so an
 * UNRELATED whole-entity save can clobber it: `UsersService.updateProfile` /
 * `uploadAvatar` load a `User` (fence = N), and TypeORM's `save()` re-persists
 * every column — including that now-stale N. If a newer lock holder published
 * N+1 in the meantime, the profile save would write the fence back to N,
 * reopening the exact resurrection window the fence exists to close (a
 * lease-lost token-N flow could then pass `subscription_lock_fence <= N` again).
 *
 * A `BEFORE UPDATE` row trigger clamps any UPDATE that would DECREASE the fence
 * back to the stored value — so no code path (ORM save, repository update, raw
 * SQL) can ever lower it, while the lock's legitimate advances (N → N+1) pass
 * through untouched. Cheaper and more robust than trying to exclude the column
 * from every entity-save site.
 */
export class AddSubscriptionLockFenceMonotonicTrigger1827000000000 implements MigrationInterface {
  name = 'AddSubscriptionLockFenceMonotonicTrigger1827000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION users_subscription_lock_fence_monotonic()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.subscription_lock_fence < OLD.subscription_lock_fence THEN
          NEW.subscription_lock_fence := OLD.subscription_lock_fence;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_users_subscription_lock_fence_monotonic
        BEFORE UPDATE ON users
        FOR EACH ROW
        EXECUTE FUNCTION users_subscription_lock_fence_monotonic();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_users_subscription_lock_fence_monotonic ON users;`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS users_subscription_lock_fence_monotonic();`,
    );
  }
}
