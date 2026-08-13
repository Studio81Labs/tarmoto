import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { User } from '../../entities/user.entity.js';
import { higherTier, type PlanSource } from '@tarmoto/shared';
import { BILLED_TIER_SQL } from '../account/entitlement.js';
import {
  CHAIN_ELECTION_ORDER,
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
      // Provenance of the tier ACTUALLY DISPLAYED, which is what the DTO
      // promises. For a chain-only payer the raw column stays null once store
      // writers stop touching the Stripe-owned columns, so support would see a
      // paid, active, renewing rider whose access has no recorded source —
      // indistinguishable from untracked access.
      plan_source: this.planSourceFor(u, representative),
      email_verified_at: u.email_verified_at?.toISOString() ?? null,
      // Renewal and cancellation follow the elected source too. Leaving them on
      // the Stripe columns beside a chain-aware tier and status is the same
      // contradiction one level deeper: an operator reading a paid, active
      // store rider would see a renewal date belonging to a Stripe
      // subscription that ended months ago, or none at all.
      // Same distinction as the rider-facing snapshot: an elected source with an
      // unknown end must report null, not the losing source's date.
      subscription_current_period_end: representative
        ? (representative.currentPeriodEnd?.toISOString() ?? null)
        : (u.subscription_current_period_end?.toISOString() ?? null),
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
    // DISTINCT ON returns only the winning chain per rider. The page size bounds
    // USERS, not their chains, so a rider who bought several annual plans before
    // the earlier ones expired would otherwise materialise all of them just to
    // have one chosen in JavaScript.
    const chains = await this.chains
      .createQueryBuilder('chain')
      .distinctOn(['chain.user_id'])
      .where('chain.user_id IN (:...ids)', { ids })
      .andWhere(
        `(chain.current_period_end > :now
          OR (chain.current_period_end IS NULL AND chain.store_signed_date > :cutoff))`,
        { now, cutoff: new Date(now.getTime() - this.overlapFallbackMs()) },
      )
      .orderBy(`chain.user_id`, 'ASC')
      .addOrderBy(CHAIN_ELECTION_ORDER('chain'))
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
      elected.set(
        user.id,
        electRepresentative([
          ...this.stripeSourceOf(user, now),
          ...(byUser.get(user.id) ?? []),
        ]),
      );
    }
    return elected;
  }

  /**
   * The rider's Stripe side as an election candidate, from the `users` columns.
   *
   * Without it this election only ever sees chains, so a rider with Stripe
   * Premium beside an Apple Pro chain gets the chain's status and renewal shown
   * against their Stripe-derived Premium tier — while the rider's own screen
   * elects Stripe. The admin page and the rider disagreeing about who is
   * billing them is the exact failure the shared election exists to prevent.
   *
   * Derived from the stored columns rather than a live Stripe read: this is a
   * paginated operator list, and one API call per row is not a trade worth
   * making for a display field. The columns are what ingestion has already
   * persisted, so they are the same values the snapshot falls back to.
   *
   * Paid tiers only, matching the snapshot: a `free` tier contributes no
   * entitlement, and admitting it would invent a source that could win the
   * election and mislabel a store-funded plan as Stripe-managed.
   */
  private stripeSourceOf(user: User, now: Date): BillingSource[] {
    // EVIDENCE FIRST: a paid `subscription_tier` is not proof of a Stripe
    // subscription. Registration still dual-writes grants into that column, so
    // a founder or promo rider carries a paid tier with every Stripe identifier
    // null — and fabricating a candidate from it elects a subscription that
    // does not exist, handing the row the users table's `canceled` status and
    // null renewal while the rider's own screen correctly shows their chain.
    //
    // Third time this design has been bitten by inventing a source (the free
    // price coercion, then the unmapped-price case). The rule that generalises:
    // admit a source only on evidence it exists, never on a value that merely
    // implies it should.
    if (user.stripe_subscription_id == null) return [];
    const tier = user.subscription_tier;
    if (tier !== 'pro' && tier !== 'premium') return [];
    // BILLED provenance, not merely an id plus a paid tier. AccountService
    // deliberately preserves both when a founder checkout never entitles — the
    // grant keeps its paid tier and the checkout leaves its subscription id
    // behind — so the pair alone still describes a subscription that never
    // started. The rider-facing snapshot excludes it through Stripe's live
    // `entitling` flag; this list has no live read, so a PERIOD is the evidence
    // available: a subscription that has billed has one, a failed checkout does
    // not.
    //
    // Provenance is the STATUS, not the presence of a period. An active or
    // trialing Stripe subscription can legitimately have no persisted period
    // end, and the rider-facing election admits exactly that source — so
    // requiring one dropped Stripe here while /account/subscription elected it,
    // which is the admin-disagrees-with-the-rider failure again.
    //
    // A never-entitling founder checkout is excluded by this instead: it leaves
    // its id and the grant's tier behind, but not an entitling status.
    if (
      user.subscription_status !== 'active' &&
      user.subscription_status !== 'trialing' &&
      user.subscription_status !== 'past_due'
    ) {
      return [];
    }
    // The period still decides LIVENESS when there is one — a canceled-but-not-
    // yet-ended subscription entitles to its period end — but a missing period
    // is "no known end", not "ended".
    const end = user.subscription_current_period_end;
    if (end != null && end.getTime() <= now.getTime()) return [];
    return [
      {
        provider: 'stripe',
        identity: user.stripe_subscription_id,
        tier,
        status: user.subscription_status,
        currentPeriodEnd: end,
        cancelAtPeriodEnd: user.subscription_cancel_at_period_end,
      },
    ];
  }

  /**
   * Which side produced the tier the row is showing.
   *
   * Reads the grant first, because a grant that OUT-RANKS the billing side is
   * what the rider is actually holding — reporting `subscription` there would
   * point support at a payment that is not the reason for their access.
   */
  private planSourceFor(
    user: User,
    representative: BillingSource | null,
  ): PlanSource | null {
    // The same billing tier the row displays, from the representative rather
    // than the rollup — otherwise provenance and tier could be computed from
    // two different reads and disagree about which side won.
    const billed = representative?.tier ?? user.subscription_tier;
    if (
      user.grant_tier != null &&
      higherTier(user.grant_tier, billed) === user.grant_tier &&
      user.grant_tier !== billed
    ) {
      return user.grant_source ?? user.plan_source;
    }
    return representative != null ? 'subscription' : user.plan_source;
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
      // From the ELECTED source, not the rollup — which also removes a read.
      // The election's first rule is highest tier, so the winner's tier IS the
      // max over live billing sources: the billed tier, by construction.
      //
      // Taking it from the same object as the status below means both come from
      // one query. Reading the rollup off the user row instead let a chain
      // writer commit between the two statements and render a `free` tier
      // beside an `active` store representative, or a paid tier beside the
      // legacy `canceled` status.
      //
      // No representative means no live billing, so the rider's own column is
      // what remains — a grant, or a lapsed plan.
      //
      // The GRANT is folded in because this row is what support reads to answer
      // "what does this rider have?". Showing the billing tier alone renders a
      // Premium founder with a live Pro chain as `pro` while plan_source says
      // `founder` — a row that contradicts itself and understates the access
      // being investigated. Today the dual-write hides it; once grants stop
      // being written into subscription_tier it would be plainly wrong.
      subscription_tier: higherTier(
        u.grant_tier,
        representative?.tier ?? u.subscription_tier,
      ),
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
