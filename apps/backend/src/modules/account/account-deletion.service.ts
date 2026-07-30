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
import { HAZARD_PHOTO_UPLOAD_DIR } from '../hazards/dto/hazard-photo.dto.js';
import {
  AccountDeletionLog,
  type AccountDeletionEvent,
} from '../../entities/account-deletion-log.entity.js';
import {
  STRIPE_BILLING_CLIENT,
  type StripeBillingClient,
} from './stripe-billing.client.js';
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

    // Collect the rider's pending hazard-photo uploads BEFORE the purge — the
    // rows are removed inside the transaction below, so we snapshot the
    // filenames now to unlink the on-disk files afterwards. These carry the
    // rider's UUID (in `user_id` and the filename), have no FK to `users`, and
    // may outlive the account by up to the 24h orphan grace if left to the
    // sweep — which violates the hard-purge expectation for a zero-day
    // deletion.
    const pendingPhotoFilenames = (
      await this.hazardPhotoUploadRepo.find({
        where: { user_id: user.id },
        select: { filename: true },
      })
    ).map((row) => row.filename);

    const stripeResult = await this.cancelStripe(user);

    const purged = await this.dataSource.transaction(async (manager) => {
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
        return false;
      }

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
      return true;
    });

    if (purged && pendingPhotoFilenames.length > 0) {
      // Reclaim the rider's pending upload files so their UUID doesn't linger on
      // disk. Runs AFTER the commit so a filesystem hiccup can't roll back the
      // account purge, and only on an ACTUAL purge (never a restore/postpone).
      // Delete each tracking row ONLY once its file is confirmed gone (success /
      // ENOENT); a transient unlink failure RETAINS the row so the hourly orphan
      // sweep retries it — the file (and UUID) are never leaked beyond the
      // sweep's reach.
      await Promise.all(
        pendingPhotoFilenames.map(async (filename) => {
          let fileGone = false;
          try {
            await unlink(join(HAZARD_PHOTO_UPLOAD_DIR, filename));
            fileGone = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              fileGone = true;
            } else {
              this.logger.warn(
                `account purge: failed to unlink pending photo ${filename}; retained for the sweep: ${String(error)}`,
              );
            }
          }
          if (fileGone) {
            await this.hazardPhotoUploadRepo
              .delete({ filename })
              .catch(() => undefined);
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
