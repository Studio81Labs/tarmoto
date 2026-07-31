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
    const wonRace = await this.dataSource.transaction(async (manager) => {
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
        return false;
      }

      const log = manager.create(AccountDeletionLog, {
        user_id: user.id,
        email: user.email,
        event: 'requested' satisfies AccountDeletionEvent,
        scheduled_for: scheduledFor,
        stripe_customer_id: user.stripe_customer_id,
        stripe_subscription_id: user.stripe_subscription_id,
        details: dto.reason ? { reason: dto.reason } : {},
      });
      await manager.save(AccountDeletionLog, log);
      return true;
    });

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
    // Restoration-reversal (clearing `cancel_at_period_end` when an account
    // is restored) lives in `restoreAccount` below — it re-enables the
    // renewal AND resolves any open `deletion_cancel_failed` reconciliation,
    // both under the same per-rider advisory lock the Task 8 worker takes so
    // a restore can't interleave with an in-flight retry.
    //
    // Only the request that actually WON the schedule race runs this — a
    // concurrent-submit loser would otherwise duplicate the Stripe call
    // and any reconciliation row. The call is best-effort: on failure we
    // RETAIN a durable `deletion_cancel_failed` reconciliation for the
    // worker to retry, but never abort the deletion request.
    const isStripeSubscriber =
      user.subscription_provider === 'stripe' ||
      user.stripe_subscription_id != null;
    if (wonRace && isStripeSubscriber && user.stripe_subscription_id) {
      const subscriptionId = user.stripe_subscription_id;
      try {
        // Serialize the pending cancel with restore/worker under the SAME
        // per-rider advisory lock. Without it, a support restore that lands
        // between the schedule commit and this call (clearing the deletion +
        // setting cancel_at_period_end=false under the lock) would be undone
        // here — this unlocked path would flip cancel back to true on the
        // now-restored subscription. Under the lock we RE-CHECK that the
        // deletion is still pending (mirrors the worker's under-lock re-check);
        // if it was restored, skip the cancel entirely.
        await this.dataSource.transaction(async (manager) => {
          await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
            accountDeletionLockKey(userId),
          ]);
          const current = await manager.getRepository(User).findOne({
            where: { id: userId },
            select: { id: true, deletion_scheduled_at: true },
          });
          // Restored (or purged) between commit and here → nothing to cancel.
          if (!current || current.deletion_scheduled_at === null) {
            return;
          }
          await this.stripe.setCancelAtPeriodEnd(subscriptionId, true);
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Stripe setCancelAtPeriodEnd(${user.stripe_subscription_id}) failed for user ${user.id}: ${message}. ` +
            'Opening a deletion_cancel_failed reconciliation for the worker to retry before renewal.',
        );
        // Guard the reconciliation insert too: a double failure (Stripe
        // cancel throws, THEN this INSERT throws) must NOT propagate a 500
        // out of a deletion whose schedule row is already committed — the
        // GDPR contract is that the request still returns
        // `{status:'scheduled'}`. Mirror the sibling email-send catch below:
        // log and continue. The worst case is a missed renewal cancel that
        // the rider can still resolve in the portal, versus a wedged
        // deletion request.
        await this.reconciliation
          .openConflict({
            userId,
            provider: 'stripe',
            stripeSubscriptionId: user.stripe_subscription_id,
            reason: 'deletion_cancel_failed',
            detail: {
              message,
              subscriptionId: user.stripe_subscription_id,
            },
          })
          .catch((reconErr: unknown) => {
            this.logger.warn(
              `Opening deletion_cancel_failed reconciliation failed for user ${user.id}: ${
                reconErr instanceof Error ? reconErr.message : String(reconErr)
              }`,
            );
          });
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
   * The DB restore commits FIRST, under the SAME per-rider advisory lock the
   * reconciliation retry worker takes (`accountDeletionLockKey`), so a restore
   * can't interleave with an in-flight `deletion_cancel_failed` retry (closing
   * the worker's `deletion_scheduled_at` TOCTOU). Inside that transaction it:
   *   1. clears `deleted_at` / `deletion_scheduled_at` / `deletion_reason`
   *      (only if the row is currently soft-deleted — a non-deleted account
   *      is a no-op);
   *   2. resolves any OPEN `deletion_cancel_failed` reconciliation for the
   *      rider (`expired` — the reason to cancel has lapsed, matching the
   *      worker's own restore resolution).
   *
   * Only AFTER that commit — and outside the lock — does it flip Stripe's
   * `cancel_at_period_end` back off (best-effort) for a Stripe subscriber, so
   * an irreversible Stripe re-enable can never roll the restore back. A failure
   * there is logged and swallowed: the account stays restored (renewal may lapse
   * until re-enabled), never deleted-with-renewal-on. The committed
   * `deletion_scheduled_at = null` is what keeps the post-commit, unlocked
   * Stripe call safe against a concurrent worker/request-cancel re-enable.
   *
   * Returns `true` when this call actually restored the row, `false` when the
   * account was not pending deletion (already active, purged, or restored by
   * a concurrent caller).
   */
  async restoreAccount(userId: string): Promise<boolean> {
    // Phase 1 — DURABLE restore. Clear the soft-delete columns and resolve the
    // open `deletion_cancel_failed` reconciliation, then COMMIT, all under the
    // per-rider advisory lock the retry worker holds. Only after this commits
    // do we touch Stripe (phase 2). The ordering is the whole point: the Stripe
    // re-enable is an IRREVERSIBLE external effect, so it must never sit inside
    // the same transaction as the DB restore. If it did and a later in-tx step
    // failed, the rollback would leave the account DELETED while Stripe renewal
    // was already RE-ENABLED — the worst state (a mid-grace charge on an account
    // that stays scheduled for purge). By committing the restore first, the only
    // reachable outcomes are (a) restored + renewal-on (correct) or (b) restored
    // + renewal-still-off (soft — the account is live, the sub lapses, retriable)
    // — never (c) deleted + renewal-on.
    const outcome = await this.dataSource.transaction(async (manager) => {
      // Same lock the retry worker holds — serialises restore against an
      // in-flight `deletion_cancel_failed` retry for this rider.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        accountDeletionLockKey(userId),
      ]);

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
        return { restored: false, subscriptionId: null as string | null };
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
          // deletion metadata — this is the reversal admin.restore delegates to.
          deletion_reason: null,
          updated_at: new Date(),
        },
      );
      if (!result.affected) {
        return { restored: false, subscriptionId: null as string | null };
      }

      // 2. Resolve any OPEN deletion_cancel_failed reconciliation — the
      // worker no longer has anything to cancel now the account is back.
      const openReconciliations = await this.reconciliation.findOpen({
        userId,
        provider: 'stripe',
        reason: 'deletion_cancel_failed',
      });
      for (const row of openReconciliations) {
        await this.reconciliation.resolve(row.id, 'expired');
      }

      // Capture the subscription to re-enable AFTER commit. Mirror the
      // subscriber gate `requestDeletion` used.
      const isStripeSubscriber =
        user.subscription_provider === 'stripe' ||
        user.stripe_subscription_id != null;
      const subscriptionId =
        isStripeSubscriber && user.stripe_subscription_id
          ? user.stripe_subscription_id
          : null;

      this.logger.log(`Account ${userId} restored from pending deletion`);
      return { restored: true, subscriptionId };
    });

    if (!outcome.restored) {
      return false;
    }

    // Phase 2 — BEST-EFFORT Stripe re-enable, AFTER the restore committed and
    // OUTSIDE the advisory lock/transaction. The deletion request set
    // `cancel_at_period_end = true`; restore must flip it back or the restored
    // subscriber still lapses at period end. We deliberately do NOT hold the
    // lock across this slow Stripe HTTP call (the purge path avoids the same
    // anti-pattern): the now-committed `deletion_scheduled_at = null` already
    // guards the interleave the lock protected — the retry worker re-reads
    // `deletion_scheduled_at` under its own lock and no-ops (resolving the row
    // as restored) rather than re-cancelling, and `requestDeletion`'s pending
    // cancel does the same re-check. So no concurrent path can re-enable
    // cancellation on the restored subscription.
    //
    // A failure here is SOFT and must not un-restore the account: log and
    // continue. The rider is live; worst case the subscription lapses at period
    // end and can be re-enabled from the portal — strictly better than the
    // rolled-back-restore state the old in-transaction ordering allowed.
    if (outcome.subscriptionId) {
      try {
        await this.stripe.setCancelAtPeriodEnd(outcome.subscriptionId, false);
      } catch (err) {
        this.logger.warn(
          `Account ${userId} restored, but re-enabling Stripe renewal ` +
            `(setCancelAtPeriodEnd(${outcome.subscriptionId}, false)) failed: ${
              err instanceof Error ? err.message : String(err)
            }. The account is restored; the subscription may lapse at period ` +
            'end until renewal is re-enabled (portal or a retry).',
        );
      }
    }

    return true;
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
