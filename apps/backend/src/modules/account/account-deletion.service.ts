import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { User } from '../../entities/user.entity.js';
import { TripInvite } from '../../entities/trip-invite.entity.js';
import { EmailLog } from '../../entities/email-log.entity.js';
import { HazardPhotoUpload } from '../../entities/hazard-photo-upload.entity.js';
import {
  HAZARD_PHOTO_UPLOAD_DIR,
  hazardPhotoUploadLockKey,
} from '../hazards/dto/hazard-photo.dto.js';
import {
  AccountDeletionLog,
  type AccountDeletionEvent,
} from '../../entities/account-deletion-log.entity.js';
import {
  STRIPE_BILLING_CLIENT,
  type StripeBillingClient,
} from './stripe-billing.client.js';
import {
  StoreReconciliationService,
  accountDeletionLockKey,
} from './store-reconciliation.service.js';
import { EmailService } from '../email/email.service.js';
import type { DeleteAccountDto } from './dto/delete-account.dto.js';
import type { DeleteAccountResponseDto } from './dto/delete-account-response.dto.js';

const DEFAULT_GRACE_PERIOD_DAYS = 30;
const SWEEPER_BATCH_SIZE = 50;

/**
 * GDPR Art. 17 account deletion (US-62).
 *
 * Two-phase: a `DELETE /account` request flips `deleted_at` and stamps
 * `deletion_scheduled_at` 30 days out (grace window for restore).
 * After the schedule passes, the cron-driven sweeper:
 *
 *   1. Cancels and detaches the rider's Stripe subscription/customer
 *      (best-effort — failures are logged and the row stays scheduled
 *      so the next sweep retries).
 *   2. Anonymizes `surface_readings` by nulling `user_id`. The FK is
 *      already `ON DELETE SET NULL` from migration 1715500000000, but
 *      we run the explicit UPDATE so the audit log can claim the
 *      anonymization regardless of FK drift.
 *   3. Deletes the `users` row. Cascades chain-clean every personal
 *      table (rides, hazards, reviews, follows, badges, contacts,
 *      trips, trip memberships, messages, etc.).
 *   4. Explicitly deletes the rows no FK cascade reaches — the
 *      email-keyed pending `trip_invites` and `email_log`, and the
 *      `hazard_photo_uploads` tracking rows — then unlinks the rider's
 *      pending photo files (their names embed the rider's UUID), so
 *      nothing identifying outlives the account.
 *   5. Writes a `purged` row to `account_deletion_log`.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(HazardPhotoUpload)
    private readonly hazardPhotoUploadRepo: Repository<HazardPhotoUpload>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(STRIPE_BILLING_CLIENT)
    private readonly stripe: StripeBillingClient,
    private readonly reconciliation: StoreReconciliationService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
  ) {}

  /**
   * Soft-delete the user. Validates the re-entered password (fresh
   * auth), schedules the hard delete, and immediately locks the
   * account from login.
   */
  async requestDeletion(
    userId: string,
    dto: DeleteAccountDto,
  ): Promise<DeleteAccountResponseDto> {
    const user = await this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.password_hash')
      .where('user.id = :id', { id: userId })
      .getOne();

    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (user.deleted_at != null) {
      throw new ForbiddenException('Account is already pending deletion');
    }

    const valid = await bcrypt.compare(dto.password, user.password_hash);
    if (!valid) {
      // 403 — not 401 — so the companion's `apiFetch` 401-handler does
      // NOT clear the session out from under a rider who simply mistyped
      // their password. The rider is authenticated; what's missing is
      // the fresh-auth proof for an irreversible action.
      throw new ForbiddenException('Password does not match');
    }

    const now = new Date();
    const graceDays = this.gracePeriodDays();
    const scheduledFor = new Date(
      now.getTime() + graceDays * 24 * 60 * 60 * 1000,
    );

    // Soft-delete and the `requested` audit row are written together so
    // a transient failure on the audit insert can't leave the account
    // locked-but-unaudited (the audit trail is part of the GDPR
    // compliance surface). If the transaction rolls back, the rider
    // sees the request fail and can retry.
    //
    // The UPDATE is gated on `deleted_at IS NULL` to make the endpoint
    // idempotent under concurrent submits (rider double-clicks, two
    // tabs open). The pre-check above only catches an already-pending
    // deletion that was committed BEFORE the read; two requests that
    // both pass the pre-check would otherwise both UPDATE by PK,
    // overwrite each other's `deletion_scheduled_at`, and append two
    // `requested` audit rows. Conditional UPDATE → second one returns
    // affected: 0 → audit row skipped → schedule the loser sees comes
    // from re-reading the row the winner committed.
    // A Stripe subscriber's deletion also needs the NEXT renewal stopped. We
    // model that as a durable `deletion_cancel_failed` reconciliation row that
    // the lock-guarded worker converges to the current deletion state (cancel
    // while scheduled, re-enable once restored). The row is INSERTED in the
    // SAME committed transaction as the schedule — never in a fragile
    // post-commit catch — so a later best-effort step failing can't lose it
    // (finding B). On a successful immediate cancel below we resolve it; on
    // failure it stays open for the worker.
    // The subscription id used for the cancel-flag work item is RE-READ INSIDE
    // the deletion transaction (below) rather than taken from the pre-txn
    // snapshot: an outstanding Checkout that a concurrent Stripe webhook
    // claims+activates BETWEEN this method's initial read and the transaction
    // would otherwise be invisible here — the snapshot's `stripe_subscription_id`
    // is still null, so no reconciliation opens and the newly-active sub keeps
    // renewing/charging a rider locked out for deletion. The opposite ordering
    // (activation landing AFTER this txn commits) is closed in
    // `handleSubscriptionUpdated`, which opens the same row when it activates a
    // subscription for an account already `deletion_scheduled_at`.
    const outcome = await this.dataSource.transaction(async (manager) => {
      const result = await manager.update(
        User,
        { id: user.id, deleted_at: IsNull() },
        {
          deleted_at: now,
          deletion_scheduled_at: scheduledFor,
          deletion_reason: dto.reason ?? null,
          updated_at: now,
        },
      );
      if (!result.affected) {
        return {
          wonRace: false,
          reconciliationId: null as string | null,
          subscriptionId: null as string | null,
        };
      }

      // Re-read the ownership slot inside the txn so a subscription a webhook
      // activated after the pre-txn snapshot is seen and reconciled.
      const fresh = await manager.getRepository(User).findOne({
        where: { id: user.id },
        select: {
          id: true,
          subscription_provider: true,
          stripe_customer_id: true,
          stripe_subscription_id: true,
        },
      });
      const isStripeSubscriber =
        fresh?.subscription_provider === 'stripe' ||
        fresh?.stripe_subscription_id != null;
      const subscriptionId =
        isStripeSubscriber && fresh?.stripe_subscription_id
          ? fresh.stripe_subscription_id
          : null;

      const log = manager.create(AccountDeletionLog, {
        user_id: user.id,
        email: user.email,
        event: 'requested' satisfies AccountDeletionEvent,
        scheduled_for: scheduledFor,
        stripe_customer_id:
          fresh?.stripe_customer_id ?? user.stripe_customer_id,
        stripe_subscription_id: subscriptionId,
        details: dto.reason ? { reason: dto.reason } : {},
      });
      await manager.save(AccountDeletionLog, log);

      let reconciliationId: string | null = null;
      if (subscriptionId) {
        // Open the cancel-flag work item ATOMICALLY with the schedule. If this
        // INSERT fails the whole transaction rolls back (mirrors the audit-row
        // guarantee) — the rider retries a clean request rather than ending up
        // locked-but-unreconciled.
        const row = await this.reconciliation.openConflictWith(manager, {
          userId,
          provider: 'stripe',
          stripeSubscriptionId: subscriptionId,
          reason: 'deletion_cancel_failed',
          detail: { subscriptionId, opened: 'deletion_scheduled' },
        });
        reconciliationId = row.id;
      }
      return { wonRace: true, reconciliationId, subscriptionId };
    });
    const wonRace = outcome.wonRace;
    const subscriptionId = outcome.subscriptionId;

    // If a parallel transaction beat us to the update, return the
    // schedule it committed so both submits see the same answer.
    let actualSchedule = scheduledFor;
    if (!wonRace) {
      const winner = await this.userRepo.findOne({
        where: { id: user.id },
        select: { id: true, deletion_scheduled_at: true },
      });
      if (winner?.deletion_scheduled_at) {
        actualSchedule = winner.deletion_scheduled_at;
      }
      this.logger.log(
        `Account ${user.id} deletion already scheduled by a concurrent request — returning existing schedule ${actualSchedule.toISOString()}`,
      );
    } else {
      this.logger.log(
        `Account ${user.id} scheduled for deletion at ${scheduledFor.toISOString()}`,
      );
    }

    // Best-effort: stop the NEXT Stripe renewal for a subscriber whose
    // account is now scheduled for deletion. Unlike the immediate
    // `cancelSubscription` run at actual purge, `setCancelAtPeriodEnd(…,
    // true)` is REVERSIBLE and preserves the current paid period — the
    // rider keeps what they paid for through the grace window, and the
    // toggle can be flipped back. This only prevents a mid-grace RENEWAL
    // charge; an annual sub whose period outlasts the grace is still
    // hard-cancelled at purge by `cancelStripe`.
    //
    // The durable `deletion_cancel_failed` row was already opened atomically
    // with the schedule (above). This immediate attempt is the fast path: on
    // success we RESOLVE the row under the lock; on ANY failure we leave it
    // open for the worker, which converges the cancel-flag to the current
    // deletion state (cancel while scheduled, re-enable once restored).
    // Restoration-reversal lives entirely in that worker now — `restoreAccount`
    // only clears the columns and ensures the row is open; it no longer calls
    // Stripe itself.
    //
    // Only the request that actually WON the schedule race runs this — a
    // concurrent-submit loser opened no row and must not duplicate the Stripe
    // call. The call is best-effort: on failure the durable row (never lost,
    // because it committed with the schedule) covers the retry; we never abort
    // the deletion request.
    if (wonRace && subscriptionId) {
      try {
        // Serialize the pending cancel with restore/worker under the SAME
        // per-rider advisory lock. Without it, a support restore that lands
        // between the schedule commit and this call (clearing the deletion
        // under the lock) would be undone here — this path would flip cancel
        // back to true on the now-restored subscription. Under the lock we
        // RE-CHECK that the deletion is still pending (mirrors the worker's
        // under-lock re-check); if it was restored, skip the cancel entirely
        // and leave the row open so the worker re-enables the renewal instead.
        await this.dataSource.transaction(async (manager) => {
          await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
            accountDeletionLockKey(userId),
          ]);
          const current = await manager.getRepository(User).findOne({
            where: { id: userId },
            select: { id: true, deletion_scheduled_at: true },
          });
          // Restored (or purged) between commit and here → nothing to cancel;
          // leave the row open so the worker reconciles the flag.
          if (!current || current.deletion_scheduled_at === null) {
            return;
          }
          await this.stripe.setCancelAtPeriodEnd(subscriptionId, true);
          // Cancel landed — resolve the work item under the same lock so a
          // concurrent restore can't re-read it as still-open.
          if (outcome.reconciliationId) {
            await this.reconciliation.resolveWith(
              manager,
              outcome.reconciliationId,
              'server_canceled',
            );
          }
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Never fatal: the schedule row is already committed and the durable
        // `deletion_cancel_failed` row stays OPEN for the worker to retry
        // before the next renewal. The GDPR contract is that the request still
        // returns `{status:'scheduled'}`.
        this.logger.warn(
          `Stripe setCancelAtPeriodEnd(${subscriptionId}) failed for user ${user.id}: ${message}. ` +
            'Leaving the deletion_cancel_failed reconciliation open for the worker to retry before renewal.',
        );
      }
    }

    // Always email the rider — even if a concurrent submit beat us to
    // the soft-delete row update — so they have a record of the
    // scheduled deletion in their inbox before any grace-period
    // restore window elapses. Wrapped in try/catch so a transient mail
    // failure doesn't surface a 500 from a deletion the row already
    // committed.
    try {
      await this.email.sendAccountDeletionScheduled(
        user.email,
        {
          displayName: user.display_name,
          scheduledFor: actualSchedule,
        },
        user.language,
      );
    } catch (err) {
      this.logger.warn(
        `Account-deletion-scheduled email failed for user ${user.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return {
      status: 'scheduled',
      scheduled_for: actualSchedule.toISOString(),
      grace_period_days: graceDays,
    };
  }

  /**
   * Reverse a pending soft-delete during the grace window (US-62 restore).
   *
   * This is the restore OPERATION — the method support tooling or a future
   * admin route calls. It intentionally exposes NO HTTP endpoint (out of P0
   * scope) and REPLACES the old manual-SQL restore (hand-clearing
   * `deleted_at` / `deletion_scheduled_at` in the DB), which left the Stripe
   * `cancel_at_period_end` flag set — so a restored subscriber still lapsed
   * at period end.
   *
   * The whole operation runs under a SESSION-level per-rider advisory lock
   * (`pg_advisory_lock(hashtext(accountDeletionLockKey(userId)))`) acquired up
   * front on a dedicated connection and released in a `finally`. That single
   * held lock SPANS three steps so the cancel-flag can only ever be touched
   * against a fresh `deletion_scheduled_at` (INV-serialized, round 4-D):
   *   1. txn1 — clear `deleted_at` / `deletion_scheduled_at` / `deletion_reason`
   *      (only if the row is currently soft-deleted) and ENSURE an OPEN
   *      `deletion_cancel_failed` reconciliation exists for a Stripe subscriber
   *      (reusing an already-open row, RESETTING its `attempts` to 0 so a row
   *      the deletion phase capped is picked up by the worker again). This txn
   *      COMMITS before any Stripe call (INV-durable, round 3) — a re-enable
   *      failure can never roll the restore back, so the account is never left
   *      "deleted + renewal-on".
   *   2. `setCancelAtPeriodEnd(subId, false)` — IMMEDIATELY re-enable the
   *      renewal, synchronously, so a subscriber whose current period ends
   *      within the hourly worker's window isn't terminated by Stripe before
   *      the worker runs.
   *   3. txn2 — resolve the reconciliation row (only on a successful re-enable).
   *
   * The session-level `pg_advisory_lock` shares the same lock space as the
   * worker's / request's `pg_advisory_xact_lock` on the same key, so a
   * concurrent re-deletion or worker retry still mutually excludes.
   *
   * On a re-enable FAILURE we do NOT resolve — the row stays OPEN (with its
   * `attempts` reset) so the lock-guarded worker retries `setCancelAtPeriodEnd`
   * as the backstop. The account is already durably restored either way.
   *
   * Returns `true` when this call actually restored the row, `false` when the
   * account was not pending deletion (already active, purged, or restored by
   * a concurrent caller).
   */
  async restoreAccount(userId: string): Promise<boolean> {
    const lockKey = accountDeletionLockKey(userId);
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    let lockAcquired = false;
    try {
      // Session-level advisory lock held on THIS connection for the whole op —
      // it spans [txn1 commit] → [Stripe re-enable] → [txn2 resolve]. Same lock
      // space as the worker's/request's `pg_advisory_xact_lock` on the same key,
      // so a concurrent re-deletion or in-flight retry still mutually excludes.
      await queryRunner.query('SELECT pg_advisory_lock(hashtext($1))', [
        lockKey,
      ]);
      lockAcquired = true;

      // ---- txn1: durably clear the soft-delete columns + ensure/reset the
      // open reconciliation row. Commits BEFORE the Stripe re-enable so a
      // re-enable failure can't undo the restore (INV-durable). ----
      let subscriptionId: string | null = null;
      let reconciliationId: string | null = null;

      await queryRunner.startTransaction();
      try {
        const manager = queryRunner.manager;

        const user = await manager.getRepository(User).findOne({
          where: { id: userId },
          select: {
            id: true,
            deleted_at: true,
            subscription_provider: true,
            stripe_subscription_id: true,
          },
        });

        // Only a currently soft-deleted account can be restored.
        if (!user || user.deleted_at === null) {
          await queryRunner.commitTransaction();
          return false;
        }

        // 1. Clear the soft-delete columns. Gated on `deleted_at IS NOT NULL`
        // as a backstop against a concurrent purge that dropped the row.
        const result = await manager.update(
          User,
          { id: userId, deleted_at: Not(IsNull()) },
          {
            deleted_at: null,
            deletion_scheduled_at: null,
            // Clear the reason too so a restored account carries no stale
            // deletion metadata — the reversal admin.restore delegates to.
            deletion_reason: null,
            updated_at: new Date(),
          },
        );
        if (!result.affected) {
          await queryRunner.commitTransaction();
          return false;
        }

        // 2. ENSURE an OPEN deletion_cancel_failed row exists for a Stripe
        // subscriber — the durable "re-enable needed" work item and the
        // worker's backstop if the immediate re-enable below fails. Reuse an
        // already-open row so we never leave two; RESET its attempts to 0 so a
        // row an ambiguous deletion-phase timeout capped is a fresh task the
        // worker's capped slice will pick up again.
        const isStripeSubscriber =
          user.subscription_provider === 'stripe' ||
          user.stripe_subscription_id != null;
        subscriptionId =
          isStripeSubscriber && user.stripe_subscription_id
            ? user.stripe_subscription_id
            : null;
        if (subscriptionId) {
          const open = await this.reconciliation.findOpenWith(manager, {
            userId,
            provider: 'stripe',
            reason: 'deletion_cancel_failed',
          });
          if (open.length === 0) {
            const row = await this.reconciliation.openConflictWith(manager, {
              userId,
              provider: 'stripe',
              stripeSubscriptionId: subscriptionId,
              reason: 'deletion_cancel_failed',
              detail: { subscriptionId, opened: 'restore_reenable' },
            });
            reconciliationId = row.id;
          } else {
            reconciliationId = open[0]!.id;
            await this.reconciliation.resetAttemptsWith(
              manager,
              reconciliationId,
            );
          }
        }

        await queryRunner.commitTransaction();
      } catch (err) {
        await queryRunner.rollbackTransaction();
        throw err;
      }

      // The restore is now DURABLY committed. Nothing below can un-restore it.

      // ---- Immediate, synchronous Stripe re-enable. If the current period
      // ends within the hourly worker's window, Stripe would terminate the
      // subscription before the worker's later re-enable — so we flip the flag
      // back NOW, still under the held session lock (against the just-committed
      // fresh `deletion_scheduled_at = null`). ----
      if (subscriptionId) {
        try {
          await this.stripe.setCancelAtPeriodEnd(subscriptionId, false);
        } catch (err) {
          // Leave the row OPEN (attempts already reset) so the lock-guarded
          // worker retries the re-enable. The account is already restored.
          this.logger.warn(
            `Immediate Stripe setCancelAtPeriodEnd(${subscriptionId}, false) failed on restore of user ${userId}: ${
              err instanceof Error ? err.message : String(err)
            }. Leaving the deletion_cancel_failed reconciliation open for the worker to retry.`,
          );
          this.logger.log(`Account ${userId} restored from pending deletion`);
          return true;
        }

        // ---- txn2: resolve the row under the same held session lock so a
        // concurrent restore/worker can't re-read it as still-open. ----
        if (reconciliationId) {
          await queryRunner.startTransaction();
          try {
            await this.reconciliation.resolveWith(
              queryRunner.manager,
              reconciliationId,
              'expired',
            );
            await queryRunner.commitTransaction();
          } catch (err) {
            await queryRunner.rollbackTransaction();
            // The re-enable already succeeded; a failed resolve only leaves the
            // row open, so the worker re-runs a harmless idempotent
            // setCancelAtPeriodEnd(false). Never un-restore.
            this.logger.warn(
              `Restore of user ${userId} re-enabled renewal but failed to resolve reconciliation ${reconciliationId}: ${
                err instanceof Error ? err.message : String(err)
              }. The worker will reconcile it.`,
            );
          }
        }
      }

      this.logger.log(`Account ${userId} restored from pending deletion`);
      return true;
    } finally {
      // Release the session lock on the SAME connection before releasing the
      // runner — finally-guaranteed so a throw can't leak the lock.
      try {
        if (lockAcquired) {
          await queryRunner.query('SELECT pg_advisory_unlock(hashtext($1))', [
            lockKey,
          ]);
        }
      } finally {
        await queryRunner.release();
      }
    }
  }

  /**
   * Sweeper hook. Finds every user whose `deletion_scheduled_at` has
   * passed and hard-deletes them. Each user is processed in its own
   * transaction so a single failing rider does not block the rest.
   *
   * Returns the number of users actually purged (useful for tests
   * and ops dashboards).
   */
  async processDueDeletions(now: Date = new Date()): Promise<number> {
    const due = await this.userRepo.find({
      where: {
        deleted_at: Not(IsNull()),
        deletion_scheduled_at: LessThanOrEqual(now),
      },
      take: SWEEPER_BATCH_SIZE,
    });

    let purged = 0;
    for (const user of due) {
      try {
        // Capture user-facing fields before the transaction so the
        // post-purge confirmation email has the rider's display name,
        // address, and language preference even though their row no
        // longer exists.
        const purgedFields = {
          email: user.email,
          displayName: user.display_name,
          language: user.language,
        };
        if (await this.purgeUser(user, now)) {
          purged += 1;
          try {
            await this.email.sendAccountDeletionCompleted(
              purgedFields.email,
              {
                displayName: purgedFields.displayName,
                deletedAt: now,
              },
              purgedFields.language,
            );
          } catch (err) {
            this.logger.warn(
              `Account-deletion-completed email failed for user ${user.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      } catch (err) {
        // Leave deletion_scheduled_at in place — the next sweep
        // retries. Don't abort the batch on one failure.
        this.logger.error(
          `Failed to purge user ${user.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }
    return purged;
  }

  /**
   * Per-user finalize entry point used by the BullMQ
   * `account-deletion-finalize` queue. Loads the row, runs the same
   * `purgeUser` path the legacy batch sweeper used, and sends the
   * post-purge confirmation email if the row was actually purged.
   *
   * Returns `true` when this call hard-deleted the row (and wrote
   * the audit entry), `false` when the row was no longer eligible
   * (concurrent purge, support-side restore, or postponed schedule).
   * The boolean is what the queue processor surfaces to job results
   * and structured logs.
   */
  async finalizeUser(userId: string): Promise<boolean> {
    const now = new Date();
    const user = await this.userRepo.findOne({
      where: {
        id: userId,
        deleted_at: Not(IsNull()),
        deletion_scheduled_at: LessThanOrEqual(now),
      },
    });
    if (!user) {
      // Row already purged by a concurrent worker, restored, or
      // postponed past the schedule. The producer is idempotent so
      // a duplicate enqueue will eventually find this same state;
      // log nothing — successful no-ops should not page on-call.
      return false;
    }

    // Capture user-facing fields before the transaction so the
    // post-purge confirmation email has the rider's display name,
    // address, and language preference even though their row no
    // longer exists.
    const purgedFields = {
      email: user.email,
      displayName: user.display_name,
      language: user.language,
    };

    const purged = await this.purgeUser(user, now);
    if (!purged) {
      return false;
    }

    try {
      await this.email.sendAccountDeletionCompleted(
        purgedFields.email,
        {
          displayName: purgedFields.displayName,
          deletedAt: now,
        },
        purgedFields.language,
      );
    } catch (err) {
      // Email failure must not bubble — the row is gone, the audit
      // is written, and re-running the job would do nothing useful.
      this.logger.warn(
        `Account-deletion-completed email failed for user ${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return true;
  }

  /**
   * Hard-delete a single user. Cancels Stripe state, nulls out the
   * defensive `surface_readings.user_id` (the FK is already
   * `ON DELETE SET NULL`), deletes the user row (CASCADE FKs handle
   * every other personal table), and writes the audit entry.
   *
   * Returns `true` if this call actually purged the row (and wrote the
   * audit entry), `false` if the row was no longer eligible by the
   * time we got to it — either because a concurrent sweeper already
   * finished, OR because support cleared `deleted_at` to restore the
   * account during the grace window. Distinguishing eligible-and-done
   * from no-longer-eligible prevents duplicate audit rows AND prevents
   * accidentally hard-deleting a restored account.
   */
  private async purgeUser(user: User, now: Date): Promise<boolean> {
    // Cheap pre-flight: skip Stripe entirely when the row is no longer
    // due (concurrent purge OR concurrent restore). Stripe calls are
    // slow and metered, and cancelling a subscription on a freshly
    // restored account is much harder to undo than skipping a redundant
    // DB hit. We re-check `deleted_at IS NOT NULL` and the schedule
    // here to narrow the restore-race window for the Stripe calls; the
    // delete inside the transaction below adds the same predicate as
    // the definitive backstop.
    const stillDue = await this.userRepo.findOne({
      where: {
        id: user.id,
        deleted_at: Not(IsNull()),
        deletion_scheduled_at: LessThanOrEqual(now),
      },
      select: { id: true },
    });
    if (!stillDue) {
      return false;
    }

    const stripeResult = await this.cancelStripe(user);

    const { purged, pendingPhotoFilenames } = await this.dataSource.transaction(
      async (manager) => {
        // Serialize against `HazardsService.uploadPhoto` on the SAME per-user
        // advisory key: an already-authenticated upload in flight when the purge
        // starts either commits its `hazard_photo_uploads` insert BEFORE our
        // snapshot below (so we reclaim it) or blocks until this transaction
        // commits. Without this, an upload could insert its row + write its file
        // AFTER an unsynchronized snapshot, leaving the deleted rider's UUID and
        // photo bytes to survive the purge until the 24h age-based sweep. (A
        // genuinely NEW upload arriving after the purge is inherently outside any
        // request-scoped lock; the orphan sweep remains its backstop.)
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          hazardPhotoUploadLockKey(user.id),
        ]);

        // Delete only if the row is still due — both `deleted_at` is set
        // AND `deletion_scheduled_at` has elapsed. Mirrors the pre-flight
        // predicate so support actions during the grace window are
        // honoured by the transaction even after Stripe ran:
        //   - clear `deleted_at` (restore) → affected: 0, user preserved
        //   - push `deletion_scheduled_at` into the future (postpone) →
        //     affected: 0, user preserved
        //   - concurrent sweeper already deleted the row → affected: 0
        // The user delete cascades to every personal table via the FK
        // rules from migration 1715500000000; `surface_readings.user_id`
        // is anonymized atomically via its `ON DELETE SET NULL` FK — no
        // separate UPDATE needed (and writing one before this delete
        // would orphan telemetry of restored / postponed users in the
        // affected: 0 case).
        const result = await manager.delete(User, {
          id: user.id,
          deleted_at: Not(IsNull()),
          deletion_scheduled_at: LessThanOrEqual(now),
        });
        if (!result.affected) {
          // Concurrent sweeper finished, or support restored, or support
          // postponed. Skip the audit and leave the row intact.
          return { purged: false, pendingPhotoFilenames: [] as string[] };
        }

        // Snapshot the rider's pending hazard-photo uploads INSIDE the lock (and
        // this committed purge) so it can't miss a row a racing upload inserts.
        // The rows have no FK to `users` (so the User delete above doesn't cascade
        // to them) and carry the rider's UUID; we reclaim them after the commit
        // (below) rather than here, so a failed on-disk unlink can RETAIN the row
        // for the sweep instead of dropping it and orphaning the file.
        const pendingPhotoFilenames = (
          await manager.find(HazardPhotoUpload, {
            where: { user_id: user.id },
            select: { filename: true },
          })
        ).map((row) => row.filename);

        // Pending trip invites are keyed by EMAIL, not user_id — no FK
        // cascade reaches them, so purge them explicitly or the address
        // outlives the account (invites the user SENT are detached by the
        // `invited_by` ON DELETE SET NULL rule instead).
        await manager.delete(TripInvite, {
          email: user.email.toLowerCase(),
        });

        // The email delivery log is keyed by recipient (no user FK), so purge it
        // explicitly too — otherwise every address this account was ever mailed at
        // outlives the account.
        await manager.delete(EmailLog, {
          recipient: user.email.toLowerCase(),
        });

        const log = manager.create(AccountDeletionLog, {
          user_id: user.id,
          email: user.email,
          event: 'purged' satisfies AccountDeletionEvent,
          scheduled_for: user.deletion_scheduled_at,
          stripe_customer_id: user.stripe_customer_id,
          stripe_subscription_id: user.stripe_subscription_id,
          details: {
            deletion_reason: user.deletion_reason,
            stripe_subscription_canceled: stripeResult.subscriptionCanceled,
            stripe_customer_deleted: stripeResult.customerDeleted,
            ...(stripeResult.errors
              ? { stripe_errors: stripeResult.errors }
              : {}),
          },
        });
        await manager.save(AccountDeletionLog, log);
        return { purged: true, pendingPhotoFilenames };
      },
    );

    if (purged && pendingPhotoFilenames.length > 0) {
      // Reclaim the rider's pending upload files so their UUID doesn't linger on
      // disk. Runs AFTER the commit so a filesystem hiccup can't roll back the
      // account purge, and only on an ACTUAL purge (never a restore/postpone).
      //
      // Delete a tracking row ONLY when this unlink actually removed a file on
      // disk. ANY other outcome — including ENOENT — RETAINS the row for the
      // grace-bounded orphan sweep. ENOENT is deliberately NOT treated as
      // success: `uploadPhoto` commits its tracking row BEFORE its `writeFile`,
      // and its advisory lock is released at that commit, so an upload that
      // committed but stalled before writing has a row here with no file yet.
      // Deleting the row on ENOENT would strand the file the stalled writer is
      // about to create with no tracking row — invisible to the table-driven
      // sweep, leaking permanently. Retaining the row is always safe: the sweep
      // only reaps rows past the 24h window (long after any real write finishes)
      // and re-checks the disk itself, so the file (and UUID) never leak beyond
      // the sweep's reach.
      await Promise.all(
        pendingPhotoFilenames.map(async (filename) => {
          let removed = false;
          try {
            await unlink(join(HAZARD_PHOTO_UPLOAD_DIR, filename));
            removed = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              this.logger.warn(
                `account purge: failed to unlink pending photo ${filename}; retained for the sweep: ${String(error)}`,
              );
            }
          }
          if (removed) {
            // The file is gone; drop its tracking row (carries the rider's
            // UUID). If this transient delete fails, the already-committed purge
            // must still report success — but surface it rather than swallowing:
            // the bare row lingers with the UUID until the grace-bounded sweep
            // reaps it (unlink → ENOENT → delete), and a silent failure would
            // hide personal data outliving finalization by up to the 24h window.
            await this.hazardPhotoUploadRepo
              .delete({ filename })
              .catch((error: unknown) => {
                this.logger.warn(
                  `account purge: unlinked ${filename} but its tracking-row delete failed; the orphan sweep will reclaim it: ${String(error)}`,
                );
              });
          }
        }),
      );
    }

    return purged;
  }

  private async cancelStripe(user: User): Promise<{
    subscriptionCanceled: boolean;
    customerDeleted: boolean;
    errors?: string[];
  }> {
    if (!this.stripe.isConfigured()) {
      return { subscriptionCanceled: false, customerDeleted: false };
    }

    // Each Stripe call gets its own try/catch — `customers.del` cascades
    // subscription cancellation server-side, so even if our explicit
    // `cancelSubscription` hits a transient 5xx we should still attempt
    // the customer delete. Otherwise a single flake permanently orphans
    // the Stripe customer (the DB row is gone after this returns, so
    // the sweeper never retries).
    let subscriptionCanceled = false;
    let customerDeleted = false;
    const errors: string[] = [];

    if (user.stripe_subscription_id) {
      try {
        await this.stripe.cancelSubscription(user.stripe_subscription_id);
        subscriptionCanceled = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Stripe cancelSubscription(${user.stripe_subscription_id}) failed for user ${user.id}: ${message}. ` +
            'Continuing to deleteCustomer — Stripe cascades subscription cancellation on customer deletion.',
        );
        errors.push(`cancelSubscription: ${message}`);
      }
    }

    if (user.stripe_customer_id) {
      try {
        await this.stripe.deleteCustomer(user.stripe_customer_id);
        customerDeleted = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Stripe deleteCustomer(${user.stripe_customer_id}) failed for user ${user.id}: ${message}. ` +
            'Continuing with database purge — the customer record will need manual cleanup.',
        );
        errors.push(`deleteCustomer: ${message}`);
      }
    }

    return {
      subscriptionCanceled,
      customerDeleted,
      ...(errors.length > 0 ? { errors } : {}),
    };
  }

  private gracePeriodDays(): number {
    const raw = this.config
      .get<string>('TARMOTO_ACCOUNT_DELETION_GRACE_DAYS')
      ?.trim();
    if (!raw) return DEFAULT_GRACE_PERIOD_DAYS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return DEFAULT_GRACE_PERIOD_DAYS;
    }
    return parsed;
  }
}
