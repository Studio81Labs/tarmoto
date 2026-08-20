import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, MoreThan, Repository } from 'typeorm';
import type { PlanSource, SubscriptionTier } from '@tarmoto/shared';
import { User } from '../../entities/user.entity.js';

/**
 * Shared FENCE-STALE guard for a 0-row guarded subscription UPDATE. Every guarded
 * write carries `subscription_lock_fence <= :fenceToken`, so a 0-row result has
 * two very different causes: a genuine BUSINESS rejection (ownership/identity/
 * signedDate/status guard), or this flow's FENCE being stale — a NEWER lock
 * holder advanced `subscription_lock_fence` past our token (its lease was handed
 * off while ours ran, possibly via a no-op that changed nothing else). The
 * business classifiers must NOT run on the second cause: they'd emit a wrong
 * verdict (a false exclusivity conflict / 409, an acknowledged-but-unapplied
 * terminal deletion, a spurious reconciliation). Call this right after a 0-row
 * guarded UPDATE, BEFORE any business classification: it re-reads the row's fence
 * and, if a newer holder is ahead of us, throws a retryable 503 so a fresh,
 * non-stale flow re-decides (the client / Stripe redelivery retries). A missing
 * row is not our concern here (a deleted rider) — the caller's own logic handles
 * that. `fence > token` can only happen if our lease was lost (only the lock
 * holder ever publishes a fence), so this cannot false-positive on a live holder.
 */
export async function assertSubscriptionFenceCurrent(
  repo: Repository<User>,
  userId: string,
  fenceToken: number,
): Promise<void> {
  // `existsBy` (not `findOne`) so this fresh check never disturbs a caller's
  // `findOne` sequencing, and reads only a boolean. True iff the rider's row
  // carries a fence STRICTLY GREATER than ours — i.e. a newer holder is ahead.
  const stale = await repo.existsBy({
    id: userId,
    subscription_lock_fence: MoreThan(fenceToken),
  });
  if (stale) {
    throw new ServiceUnavailableException({
      message: 'Subscription service is busy. Please retry shortly.',
      retryable: true,
    });
  }
}

/**
 * First row of a `query()` result, normalising TypeORM's two shapes.
 *
 * A plain `SELECT` yields `rows`. An `UPDATE`/`INSERT ... RETURNING` yields
 * **`[rows, affectedCount]`** — so `result[0]` is the ROW ARRAY, not a row, and
 * reading a column off it silently gives `undefined`.
 *
 * That is not a hypothetical: it shipped. `getPurchaseIdentity` (#1142) read
 * `rows[0]?.purchase_account_token` from an `UPDATE ... RETURNING` and therefore
 * threw `NotFoundException` for every caller, while its unit tests passed
 * because they mocked `query` with the assumed shape. Anything reading
 * `RETURNING` values must go through here, and be covered by a test that hits a
 * real database.
 */
export function firstReturnedRow<T>(result: unknown): T | undefined {
  if (!Array.isArray(result)) return undefined;
  const rows = Array.isArray(result[0]) ? (result[0] as unknown[]) : result;
  return rows[0] as T | undefined;
}

export interface StripeClaimFields {
  tier: SubscriptionTier;
  status: 'active' | 'trialing' | 'past_due' | 'canceled';
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  planSource: PlanSource | null;
  /**
   * The per-acquisition fencing token from the subscription-mutation lock
   * ({@link SubscriptionLockLease.fenceToken}). Stamped on the row and used as a
   * `subscription_lock_fence <= :token` guard so a flow whose lease was lost
   * mid-section can't clobber/resurrect a newer flow's state.
   */
  fenceToken: number;
}

/**
 * Centralises the guarded, single-statement UPDATEs that make STRIPE's
 * ownership of a `users` row race-safe.
 *
 * ## Stripe-only since release A of the store chains move (#1191)
 *
 * This class used to also carry `claimForApple` / `claimForGoogle` /
 * `clearAppleTerminal` / `clearGoogleTerminal`, which wrote the SAME
 * single-slot `users.subscription_*` columns. Those are retired, not merely
 * unused: under the chain model the `users` billing columns are the STRIPE
 * side of `max(stripe, chains)`, and a store writer that touched them would
 * overwrite the rider's persisted Stripe state (a Google Pro chain landing on
 * Stripe Premium drops entitlement and un-elects Stripe). Store writers live
 * in `StoreChainWriterService` and write `store_subscriptions` plus the
 * rollup pair — never these columns. A step-5 consumer built against the old
 * single-slot guard would reject a legitimate Play plan replacement, which is
 * exactly why the issue orders the storage move before the consumer.
 *
 * All operations follow the conditional-claim pattern already used in
 * `AccountService` (see the activation/past_due transitions around
 * `account.service.ts:304-336`): a single UPDATE with the ownership/identity
 * check baked into the WHERE clause, so concurrent or out-of-order webhook
 * deliveries resolve via Postgres row-level locking instead of an
 * in-memory read-then-write race.
 */
@Injectable()
export class ProviderClaimService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /**
   * Resolves the `User` repository to use. When a caller passes the
   * `EntityManager` of the per-rider subscription-mutation lock's reserved
   * connection (see `SubscriptionMutationLockService`), the guarded UPDATE runs
   * on THAT connection so the lock winner needs no extra pool connection;
   * otherwise it uses the injected pool-backed repo (unchanged behaviour for
   * non-serialised callers).
   */
  private repoFor(manager?: EntityManager): Repository<User> {
    return manager ? manager.getRepository(User) : this.userRepo;
  }

  /**
   * Atomically claims (or re-confirms) Stripe ownership of a user's
   * subscription row. The WHERE clause only allows the write when the
   * row is unclaimed by another provider (`subscription_provider IS
   * NULL OR = 'stripe'`) and the stored subscription id is either unset
   * or already matches the incoming one — so a Stripe event can never
   * clobber an Apple/Google-owned row, and a stale event for a
   * different Stripe subscription id loses the race instead of
   * overwriting the current one.
   *
   * Returns `'claimed'` when the guard passed and the row was updated,
   * `'conflict'` otherwise (caller should skip dependent side effects).
   *
   * `options.skipStatus` omits the `subscription_status` write. The caller
   * passes it when an activation/past_due transition UPDATE already owns the
   * status for this event (it ran and either won or found the row already at
   * target): re-stamping the status here could clobber a NEWER, concurrently
   * committed status for the same subscription. The ownership/identity guard
   * and the mutable-field refresh (tier, period end, cancel flag, plan source)
   * still run, so conflict detection is unaffected.
   *
   * `options.skipOwnership` omits the `subscription_provider` /
   * `stripe_subscription_id` writes — the row is refreshed but the Stripe slot
   * is NOT taken. The caller passes it for a subscription that has never
   * entitled the rider landing on a founder/promo/admin grant: recording that
   * subscription as the row's owner would arm `clearStripeTerminal` (whose
   * guard is `subscription_provider = 'stripe'` AND the stored id) to wipe the
   * grant when the dead checkout later expires or is deleted. The WHERE clause
   * is deliberately untouched, so the exclusivity guard still rejects an
   * Apple/Google-owned row or a different subscription id and conflict
   * detection is unaffected.
   */
  async claimForStripe(
    userId: string,
    subscriptionId: string,
    fields: StripeClaimFields,
    options?: {
      skipStatus?: boolean;
      skipOwnership?: boolean;
      manager?: EntityManager;
    },
  ): Promise<'claimed' | 'conflict'> {
    const result = await this.repoFor(options?.manager)
      .createQueryBuilder()
      .update(User)
      .set({
        ...(options?.skipOwnership
          ? {}
          : {
              subscription_provider: 'stripe' as const,
              stripe_subscription_id: subscriptionId,
            }),
        subscription_tier: fields.tier,
        ...(options?.skipStatus ? {} : { subscription_status: fields.status }),
        subscription_current_period_end: fields.currentPeriodEnd,
        subscription_cancel_at_period_end: fields.cancelAtPeriodEnd,
        plan_source: fields.planSource,
        subscription_lock_fence: fields.fenceToken,
      })
      .where('id = :id', { id: userId })
      .andWhere(
        "(subscription_provider IS NULL OR subscription_provider = 'stripe')",
      )
      .andWhere(
        '(stripe_subscription_id IS NULL OR stripe_subscription_id = :sub)',
        { sub: subscriptionId },
      )
      // Fence: reject if a NEWER lock acquisition (higher token) already wrote
      // this row — a lease-lost stale flow can't clobber the newer state.
      .andWhere('subscription_lock_fence <= :fence', {
        fence: fields.fenceToken,
      })
      .execute();

    if ((result.affected ?? 0) > 0) return 'claimed';
    // 0 rows: distinguish a genuine exclusivity conflict from a STALE FENCE (a
    // newer holder advanced past us) — the latter throws a retryable 503 rather
    // than a false 'conflict' that would cancel/refund a valid subscription.
    await assertSubscriptionFenceCurrent(
      this.repoFor(options?.manager),
      userId,
      fields.fenceToken,
    );
    return 'conflict';
  }

  /**
   * Identity-guarded terminal clear for a Stripe subscription deletion.
   * The WHERE clause requires the row to currently be Stripe-owned
   * AND hold the exact subscription id from the event, so a stale
   * `customer.subscription.deleted` for a subscription id the user has
   * since replaced (a superseded/re-subscribed id) is a no-op instead
   * of wiping the current, still-active subscription.
   *
   * Returns whether a row was actually cleared.
   *
   * `options.preserveGrant` keeps `subscription_tier` and `plan_source` while
   * still releasing the Stripe slot (provider, subscription id, status, cancel
   * flag). The caller passes it when the row's tier comes from a
   * founder/promo/admin grant rather than from this subscription: a grant is
   * not the ending subscription's to revoke, and the rider would otherwise lose
   * it — and be mailed a cancellation for it — the moment an unrelated Stripe
   * subscription on the same row ended. Skipping ownership at claim time
   * (`claimForStripe`'s `skipOwnership`) cannot cover this, because it only
   * avoids ADDING ownership; a row that was ALREADY Stripe-owned when the grant
   * was applied still matches this clear's guard.
   *
   * The predicate itself deliberately stays in the caller
   * (`isNonSubscriptionGrant`) rather than being re-encoded as SQL here, so the
   * definition of "non-subscription grant" lives in exactly one place. The
   * WHERE clause is unchanged either way, so the identity/ownership/fence
   * guards — and the stale-fence 503 below — behave identically.
   */
  async clearStripeTerminal(
    userId: string,
    subscriptionId: string,
    fenceToken: number,
    options?: { preserveGrant?: boolean; manager?: EntityManager },
  ): Promise<boolean> {
    const manager = options?.manager;
    const result = await this.repoFor(manager)
      .createQueryBuilder()
      .update(User)
      .set({
        subscription_provider: null,
        stripe_subscription_id: null,
        subscription_status: 'canceled',
        subscription_cancel_at_period_end: false,
        subscription_lock_fence: fenceToken,
        ...(options?.preserveGrant
          ? {}
          : { subscription_tier: 'free' as const, plan_source: null }),
      })
      .where('id = :id', { id: userId })
      .andWhere("subscription_provider = 'stripe'")
      .andWhere('stripe_subscription_id = :sub', { sub: subscriptionId })
      // Fence (see `claimForStripe`): a lease-lost stale flow can't clear a row a
      // newer acquisition already advanced.
      .andWhere('subscription_lock_fence <= :fence', { fence: fenceToken })
      .execute();

    if ((result.affected ?? 0) > 0) return true;
    // 0 rows: a genuine stale/superseded deletion (identity guard) returns false
    // and the caller acks the webhook — but if OUR fence is stale (a newer holder
    // advanced past us), a false ack would leave the deleted subscription's paid
    // tier persisted with no Stripe retry. Distinguish: throw a retryable 503 on
    // a stale fence so Stripe redelivers.
    await assertSubscriptionFenceCurrent(
      this.repoFor(manager),
      userId,
      fenceToken,
    );
    return false;
  }
}
