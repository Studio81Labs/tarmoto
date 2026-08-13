import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { User } from '../../entities/user.entity.js';
import { BILLED_TIER_SQL, resolveBilledTier } from '../account/entitlement.js';
import {
  electRepresentative,
  type BillingSource,
} from '../account/billing-representative.js';
import { StoreSubscription } from '../../entities/store-subscription.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { Trip } from '../../entities/trip.entity.js';
import { CommuteRoute } from '../../entities/commute-route.entity.js';
import { NotificationPreferencesService } from '../push/notification-preferences.service.js';
import { AccountDeletionService } from '../account/account-deletion.service.js';
import type {
  NotificationPreferencesResponseDto,
  UpdateNotificationPreferencesDto,
} from '../push/dto/notification-preferences.dto.js';
import {
  AdminUserDetailDto,
  AdminUserListResponseDto,
  AdminUserRowDto,
  ListAdminUsersQueryDto,
} from './dto/admin-users.dto.js';

@Injectable()
export class AdminUsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Ride) private readonly rides: Repository<Ride>,
    @InjectRepository(HazardReport)
    private readonly hazards: Repository<HazardReport>,
    @InjectRepository(RoadReview)
    private readonly reviews: Repository<RoadReview>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(CommuteRoute)
    private readonly commutes: Repository<CommuteRoute>,
    private readonly notificationPrefs: NotificationPreferencesService,
    private readonly accountDeletion: AccountDeletionService,
    private readonly config: ConfigService,
    @InjectRepository(StoreSubscription)
    private readonly chains: Repository<StoreSubscription>,
  ) {}

  async list(query: ListAdminUsersQueryDto): Promise<AdminUserListResponseDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const deleted = query.deleted ?? 'active';

    const qb = this.users
      .createQueryBuilder('u')
      // Both are `select: false`, so the projection below cannot see them
      // otherwise and would report every store subscriber as Free.
      .addSelect([
        'u.store_subscription_tier',
        'u.store_subscription_tier_expires_at',
      ])
      .orderBy('u.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (deleted === 'active') {
      qb.andWhere('u.deleted_at IS NULL');
    } else if (deleted === 'deleted') {
      qb.andWhere('u.deleted_at IS NOT NULL');
    }

    if (query.q) {
      qb.andWhere('(u.email ILIKE :q OR u.display_name ILIKE :q)', {
        q: `%${query.q}%`,
      });
    }

    if (query.subscription) {
      const now = new Date();
      // The BILLED tier, not the raw column: a store-only payer keeps
      // `subscription_tier = 'free'`, so filtering on the column alone makes a
      // paying rider unfindable by the paid filters — the operator's search
      // disagreeing with what the rider is actually being charged for.
      // Status has no rollup column — only the tier does — so a store-only
      // rider keeps `canceled` on the users row and would be missed by every
      // status search. An EXISTS over the live chains answers the operator's
      // actual question ("is any subscription of theirs in this state?")
      // without replicating the representative election in SQL, which would be
      // a second copy of an ordering that has to stay in step with the code.
      qb.andWhere(
        `(${BILLED_TIER_SQL('u')} = :sub
           OR u.subscription_status = :sub
           OR EXISTS (
                SELECT 1 FROM store_subscriptions sc
                 WHERE sc.user_id = u.id
                   AND sc.status = :sub
                   AND (sc.current_period_end > :billedNow
                        OR (sc.current_period_end IS NULL
                            AND sc.store_signed_date > :chainCutoff))
              ))`,
        {
          sub: query.subscription,
          billedNow: now,
          // Same bounded window entitlement and the account snapshot use for a
          // chain with no known period end. Without it a silent chain keeps
          // returning the rider from status searches long after both of those
          // have stopped honouring it — the search outliving the subscription.
          chainCutoff: new Date(now.getTime() - this.overlapFallbackMs()),
        },
      );
    }

    const [rows, total] = await qb.getManyAndCount();
    const elected = await this.electPerUser(rows);

    return {
      rows: rows.map((u) => this.toRow(u, elected.get(u.id) ?? null)),
      total,
      page,
      pageSize,
    };
  }

  async getById(id: string): Promise<AdminUserDetailDto> {
    // addSelect, because both rollup columns are `select: false`: a plain
    // findOne leaves them absent, resolveBilledTier reads that as no store side,
    // and the detail page reports Free for the same rider the list endpoint
    // shows as paid. The two disagreeing is worse than either being wrong.
    const u = await this.users
      .createQueryBuilder('u')
      .where('u.id = :id', { id })
      .addSelect([
        'u.store_subscription_tier',
        'u.store_subscription_tier_expires_at',
      ])
      .getOne();
    if (!u) throw new NotFoundException('User not found');

    const [rides, hazardReports, roadReviews, trips, commuteRoutes] =
      await Promise.all([
        this.rides.count({ where: { user_id: id } }),
        this.hazards.count({ where: { user_id: id } }),
        this.reviews.count({ where: { user_id: id } }),
        this.trips.count({ where: { owner_id: id } }),
        this.commutes.count({ where: { user_id: id } }),
      ]);

    const [representative] = [(await this.electPerUser([u])).get(u.id) ?? null];

    return {
      ...this.toRow(u, representative),
      home_region: u.home_region,
      plan_source: u.plan_source,
      email_verified_at: u.email_verified_at?.toISOString() ?? null,
      // Renewal and cancellation follow the elected source too. Leaving them on
      // the Stripe columns beside a chain-aware tier and status is the same
      // contradiction one level deeper: an operator reading a paid, active
      // store rider would see a renewal date belonging to a Stripe
      // subscription that ended months ago, or none at all.
      subscription_current_period_end:
        representative?.currentPeriodEnd?.toISOString() ??
        u.subscription_current_period_end?.toISOString() ??
        null,
      subscription_cancel_at_period_end:
        representative?.cancelAtPeriodEnd ??
        u.subscription_cancel_at_period_end,
      deletion_scheduled_at: u.deletion_scheduled_at?.toISOString() ?? null,
      deletion_reason: u.deletion_reason,
      activity: { rides, hazardReports, roadReviews, trips, commuteRoutes },
    };
  }

  async softDelete(id: string): Promise<void> {
    const u = await this.users.findOne({ where: { id } });
    if (!u) throw new NotFoundException('User not found');
    // Idempotent: if the user is already soft-deleted, preserve the original
    // deleted_at timestamp rather than overwriting it with a newer value.
    if (u.deleted_at) return;
    await this.users.update(
      { id, deleted_at: IsNull() },
      { deleted_at: new Date(), deletion_reason: 'Soft-deleted by admin' },
    );
  }

  async restore(id: string): Promise<void> {
    const u = await this.users.findOne({ where: { id } });
    if (!u) throw new NotFoundException('User not found');
    // Delegate to the reversal path rather than clearing the columns directly:
    // it re-enables the rider's Stripe renewal (clears cancel_at_period_end) and
    // resolves any open deletion_cancel_failed reconciliation, all under the
    // per-rider advisory lock so it can't race the retry worker. It also clears
    // deleted_at / deletion_scheduled_at / deletion_reason, and is a safe no-op
    // for an account that isn't currently soft-deleted.
    await this.accountDeletion.restoreAccount(id);
  }

  /**
   * A user's notification preferences (defaults merged in when no row exists),
   * for support to inspect/adjust from the admin user detail. Reuses the same
   * service the user-facing settings endpoint uses, so the read shape and the
   * lazy-row semantics stay identical.
   */
  async getNotificationPreferences(
    id: string,
  ): Promise<NotificationPreferencesResponseDto> {
    await this.assertUserExists(id);
    return this.notificationPrefs.get(id);
  }

  async updateNotificationPreferences(
    id: string,
    dto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferencesResponseDto> {
    await this.assertUserExists(id);
    return this.notificationPrefs.update(id, dto);
  }

  private async assertUserExists(id: string): Promise<void> {
    const u = await this.users.findOne({ where: { id } });
    if (!u) throw new NotFoundException('User not found');
  }

  /**
   * The elected representative per rider, for a page of users.
   *
   * ONE query for the whole page rather than one per row: the admin list is
   * already paginated, and a per-row read would turn a 25-row page into 26
   * round trips for a display field.
   *
   * Uses the same election as the rider-facing snapshot, because an operator
   * comparing the two must see the same answer — a support conversation where
   * the admin page and the rider's own screen disagree about who is billing
   * them is worse than either being wrong alone.
   */
  private async electPerUser(
    users: readonly User[],
  ): Promise<Map<string, BillingSource | null>> {
    const ids = users.map((u) => u.id);
    const elected = new Map<string, BillingSource | null>();
    if (ids.length === 0) return elected;

    const now = new Date();
    const chains = await this.chains
      .createQueryBuilder('chain')
      .where('chain.user_id IN (:...ids)', { ids })
      .andWhere(
        `(chain.current_period_end > :now
          OR (chain.current_period_end IS NULL AND chain.store_signed_date > :cutoff))`,
        { now, cutoff: new Date(now.getTime() - this.overlapFallbackMs()) },
      )
      .getMany();

    const byUser = new Map<string, BillingSource[]>();
    for (const chain of chains) {
      const sources = byUser.get(chain.user_id) ?? [];
      sources.push({
        provider: chain.provider,
        identity: chain.target_key,
        tier: chain.tier,
        status: chain.status,
        currentPeriodEnd: chain.current_period_end,
        cancelAtPeriodEnd: chain.cancel_at_period_end,
      });
      byUser.set(chain.user_id, sources);
    }
    for (const user of users) {
      elected.set(user.id, electRepresentative(byUser.get(user.id) ?? []));
    }
    return elected;
  }

  /** The bounded window a chain with no known period end is trusted for. */
  private overlapFallbackMs(): number {
    return (
      this.config.get<number>('TARMOTO_BILLING_OVERLAP_FALLBACK_DAYS', 35) *
      24 *
      60 *
      60 *
      1000
    );
  }

  private toRow(
    u: User,
    representative: BillingSource | null,
  ): AdminUserRowDto {
    return {
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      // Shown as the BILLED tier so the list agrees with the filter above and
      // with what the rider sees. The function, not the SQL: this is the one
      // rule, expressed twice only because the filter must run in the database.
      subscription_tier: resolveBilledTier(u),
      // From the ELECTED source, for the same reason the tier is billed-aware:
      // a store-only rider keeps `canceled` on the users row, so projecting the
      // column beside a paid tier showed them as "paid but canceled" — a
      // contradiction an operator cannot act on.
      subscription_status: representative?.status ?? u.subscription_status,
      created_at: u.created_at.toISOString(),
      deleted_at: u.deleted_at?.toISOString() ?? null,
    };
  }
}
