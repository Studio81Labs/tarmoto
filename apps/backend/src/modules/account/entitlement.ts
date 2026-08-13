import {
  higherTier,
  type GrantTier,
  type StoreTier,
  type SubscriptionTier,
} from '@tarmoto/shared';

/**
 * The single place that answers "what tier is this rider entitled to?" (#1132).
 *
 * ## Why this exists
 *
 * A rider's entitlement has two independent sources — a GRANT (founder, promo,
 * admin) and a SUBSCRIPTION (Stripe, Apple, Google) — and they used to share one
 * column. That forced every subscription writer to re-derive *"is this tier mine
 * to touch?"* before writing, a predicate that reached three separate spellings
 * in a single PR and accounted for six of its eleven review rounds.
 *
 * Resolving as the MAX of the two removes the question. A subscription writer
 * owns only the subscription side and can write whatever the provider says
 * without consulting the grant; a grant writer owns only the grant side. Neither
 * can revoke the other:
 *
 *  - a failed checkout or a terminal clear drops the subscription side to `free`
 *    and the grant still stands;
 *  - a paid upgrade above the grant wins on its own merit rather than being
 *    capped by an older grant.
 *
 * ## Not yet the only reader
 *
 * This ships alongside a backfill that leaves grant rows carrying the SAME value
 * in both columns, so it returns exactly what `subscription_tier` returned
 * before — a no-op on every existing row. Callers move onto it incrementally,
 * and only once they all have does a later change stop writing grants into
 * `subscription_tier` at all. Reading `user.subscription_tier` directly is
 * correct today and wrong after that change; prefer this from the start.
 */
export interface EntitlementSources {
  /**
   * The tier a non-subscription grant confers, or null when there is none.
   *
   * `GrantTier`, not `SubscriptionTier`: the database rejects `free` and so does
   * the entity, so accepting it here would let a projection or adapter construct
   * a shape persistence can never hold — and let a resolver test normalise an
   * impossible row. Revocation is `null`, not `free`.
   */
  grant_tier: GrantTier | null;
  /** The tier the rider's billing provider currently entitles. */
  subscription_tier: SubscriptionTier;
  /**
   * The max tier over the rider's LIVE store chains, or null for no store side.
   *
   * Rolled up onto `users` by the chain writers so this function can stay
   * synchronous — it has 13 call sites across 6 modules, and the enforcement
   * path selects only the columns it needs. Without the rollup, a store
   * purchase would look activated on `/users/me` while every feature guard and
   * admin limit reader still resolved the rider as `free`: told they are Pro,
   * then denied Pro features.
   *
   * `StoreTier`, not `SubscriptionTier`: the database rejects `free` here
   * (`users_store_rollup_tier_check`), and null is how "no store side" is
   * spelled — admitting `free` would be a second encoding of the same fact.
   */
  store_subscription_tier: StoreTier | null;
  /**
   * When {@link store_subscription_tier} stops being trustworthy.
   *
   * **In the signature deliberately.** A three-value resolver cannot
   * self-invalidate: it has no way to know the rollup has lapsed, so a reader
   * that selected only the tier would go on granting a stale paid tier — the
   * exact failure the expiry exists to prevent, reintroduced by leaving it out.
   * Requiring it here makes a caller that forgets it fail to COMPILE rather
   * than fail silently.
   *
   * NEVER null while the tier is set (`users_store_rollup_paired_check`): a
   * chain with no known period end contributes a bounded fallback expiry
   * instead, so the lapse check can always fire.
   */
  store_subscription_tier_expires_at: Date | null;
}

/**
 * Everything {@link resolveEntitledTier} reads, as a TypeORM `select`.
 *
 * One definition so a new entitlement source cannot be added to the resolver and
 * forgotten at a loader — which fails CLOSED and silently, denying a paying
 * rider rather than erroring.
 */
export const ENTITLEMENT_SELECT = {
  id: true,
  subscription_tier: true,
  grant_tier: true,
  store_subscription_tier: true,
  store_subscription_tier_expires_at: true,
} as const;

/**
 * The entitled tier: the max of the grant, the subscription, and the LIVE store
 * rollup.
 *
 * The store side is dropped once its expiry has passed. A chain can reach
 * `current_period_end` with no terminal webhook, and then no chain writer runs —
 * so a rollup that were only writer-maintained would keep granting the paid tier
 * after the live predicate stopped including that chain, until some unrelated
 * write happened to touch the row. Self-invalidation is what stops a derived
 * cache becoming permanent, and it is why correctness here does not depend on
 * the recomputation worker having run; that worker is for ACCURACY.
 *
 * `now` is injected rather than read from the clock so the lapse boundary is
 * testable, and so a caller resolving several riders in one pass cannot have the
 * clock move underneath it mid-batch.
 */
export function resolveEntitledTier(
  user: EntitlementSources,
  now: Date = new Date(),
): SubscriptionTier {
  return higherTier(
    higherTier(user.grant_tier, user.subscription_tier),
    liveStoreTier(user, now),
  );
}

/**
 * The store rollup pair, passed separately from the user entity.
 *
 * Its own type, and a REQUIRED argument wherever it is needed, because passing a
 * whole `User` cannot express whether the rollup was actually loaded: both
 * columns are `select: false`, so an entity that never selected them
 * type-checks perfectly and reads as no store side at runtime — a paying store
 * subscriber silently denied every paid feature. A separate parameter makes the
 * decision explicit at each call site instead of implicit in a `select`.
 */
export interface StoreRollup {
  store_subscription_tier: StoreTier | null;
  store_subscription_tier_expires_at: Date | null;
}

/** A rider with no store side — what a caller passes when there is none. */
export const NO_STORE_ROLLUP: StoreRollup = {
  store_subscription_tier: null,
  store_subscription_tier_expires_at: null,
};

/**
 * The BILLED tier: `max(subscription, live store chains)` — grant EXCLUDED.
 *
 * What `/users/me.subscription_tier` answers, which is "what am I paying for?"
 * rather than "what may I use?". The distinction is deliberate (#1132): the
 * mobile activation loop polls this until it reflects the purchase, and folding
 * the grant in breaks that comparison for anyone whose grant out-ranks what they
 * just bought — a premium-granted rider buying pro would see no change and
 * conclude the purchase failed.
 *
 * It must include the store side or the same loop breaks the other way: a store
 * claim writes only a chain row, this column never moves, and the client polls
 * to timeout while the backend has already granted the features. The purchase
 * works and looks like it failed.
 *
 * And it applies the SAME expiry as entitlement. Reporting a lapsed rollup here
 * splits the system in the worst direction — cached user state and mobile upsell
 * say paid while every feature guard denies.
 */
export function resolveBilledTier(
  user: Pick<
    EntitlementSources,
    | 'subscription_tier'
    | 'store_subscription_tier'
    | 'store_subscription_tier_expires_at'
  >,
  now: Date = new Date(),
): SubscriptionTier {
  return higherTier(user.subscription_tier, liveStoreTier(user, now));
}

/**
 * The store rollup's contribution, or null once it has lapsed.
 *
 * Exported because the projection needs the same predicate: a reader that showed
 * a store plan the resolver had already stopped honouring would tell a rider
 * they are Pro on a page whose features are denied.
 */
export function liveStoreTier(
  user: Pick<
    EntitlementSources,
    'store_subscription_tier' | 'store_subscription_tier_expires_at'
  >,
  now: Date = new Date(),
): StoreTier | null {
  const {
    store_subscription_tier: tier,
    store_subscription_tier_expires_at: expiresAt,
  } = user;
  if (tier == null) return null;
  // A null expiry cannot occur (the paired CHECK forbids it) but is treated as
  // LAPSED rather than eternal: if the invariant is ever broken, failing closed
  // costs a paying rider one recomputation, while failing open grants paid
  // access forever — which is the failure the expiry exists to prevent.
  if (expiresAt == null) return null;
  return expiresAt.getTime() > now.getTime() ? tier : null;
}

/**
 * Does the rider hold a grant that OUT-RANKS their subscription?
 *
 * The narrow question a subscription writer may legitimately ask — not to decide
 * what to write (it never should: it owns only its own side), but to decide what
 * to TELL the rider. A cancellation email is wrong for someone who keeps premium
 * through a founder grant, even though their subscription really did end.
 *
 * Deliberately NOT a rewrite of the old "is this tier mine to touch?" predicate.
 * That one gated a WRITE and had to be correct or entitlement was destroyed;
 * this gates a MESSAGE, and the worst case is a confusing email.
 *
 * **Takes only the two tiers it reads, and deliberately ignores the store
 * rollup.** Whether a store chain ending should be suppressed by an outranking
 * grant is the same question for stores as for Stripe, but the answer belongs
 * with source-aware notification delivery (#1191 item 6), where the payload
 * carries the provider and `stillMatches` validates the source. Widening it
 * here would change which emails send, silently, in a readers-only change.
 */
export function grantOutranksSubscription(
  user: Pick<EntitlementSources, 'grant_tier' | 'subscription_tier'>,
): boolean {
  return (
    user.grant_tier != null &&
    higherTier(user.grant_tier, user.subscription_tier) === user.grant_tier &&
    user.grant_tier !== user.subscription_tier
  );
}
