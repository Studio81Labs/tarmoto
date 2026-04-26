import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from '../../entities/user.entity.js';
import {
  AccountDeletionLog,
  type AccountDeletionEvent,
} from '../../entities/account-deletion-log.entity.js';
import {
  STRIPE_BILLING_CLIENT,
  type StripeBillingClient,
} from './stripe-billing.client.js';
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
 *   4. Writes a `purged` row to `account_deletion_log`.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(STRIPE_BILLING_CLIENT)
    private readonly stripe: StripeBillingClient,
    private readonly config: ConfigService,
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
    await this.dataSource.transaction(async (manager) => {
      await manager.update(User, user.id, {
        deleted_at: now,
        deletion_scheduled_at: scheduledFor,
        deletion_reason: dto.reason ?? null,
        updated_at: now,
      });

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
    });

    this.logger.log(
      `Account ${user.id} scheduled for deletion at ${scheduledFor.toISOString()}`,
    );

    return {
      status: 'scheduled',
      scheduled_for: scheduledFor.toISOString(),
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
        if (await this.purgeUser(user)) {
          purged += 1;
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

  @Cron(CronExpression.EVERY_HOUR, { name: 'account-deletion-sweeper' })
  async runScheduledSweeper(): Promise<void> {
    const purged = await this.processDueDeletions();
    if (purged > 0) {
      this.logger.log(`Hard-deleted ${purged} expired account(s)`);
    }
  }

  /**
   * Hard-delete a single user. Cancels Stripe state first (best-effort
   * before the row is gone — if the rider re-signs up later they get a
   * clean Stripe customer), then nulls out surface_readings.user_id,
   * then deletes the user row. CASCADE FKs from the migration take
   * care of every other table.
   */
  /**
   * Returns `true` if this call actually purged the row (and wrote the
   * audit entry), `false` if a concurrent sweeper had already deleted
   * it. Distinguishing the two prevents duplicate `purged` rows on the
   * audit log when multiple backend instances run the same hourly cron.
   */
  private async purgeUser(user: User): Promise<boolean> {
    // Cheap pre-flight: skip Stripe entirely when a concurrent sweeper
    // already finished the purge. Stripe calls are slow (~hundreds of
    // ms) and metered, so paying for one extra DB read here pays off
    // even on a single race. The check isn't race-free — a worker can
    // still slip in between this read and the delete — but the
    // `affected: 0` guard inside the transaction below remains the
    // definitive backstop against duplicate audit rows. Stripe's
    // `customers.del` is idempotent (`resource_missing` tolerated), so
    // any remaining duplicate call is harmless.
    const stillExists = await this.userRepo.findOne({
      where: { id: user.id },
      select: { id: true },
    });
    if (!stillExists) {
      return false;
    }

    const stripeResult = await this.cancelStripe(user);

    return this.dataSource.transaction(async (manager) => {
      await manager
        .createQueryBuilder()
        .update('surface_readings')
        .set({ user_id: null })
        .where('user_id = :id', { id: user.id })
        .execute();

      const result = await manager.delete(User, { id: user.id });
      if (!result.affected) {
        // Another sweeper instance got here first. Skip the audit
        // write so we don't fan out duplicate `purged` rows.
        return false;
      }

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
