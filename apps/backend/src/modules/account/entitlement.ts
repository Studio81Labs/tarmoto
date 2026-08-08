import {
  higherTier,
  type GrantTier,
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
}

export function resolveEntitledTier(
  user: EntitlementSources,
): SubscriptionTier {
  return higherTier(user.grant_tier, user.subscription_tier);
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
 */
export function grantOutranksSubscription(user: EntitlementSources): boolean {
  return (
    user.grant_tier != null &&
    higherTier(user.grant_tier, user.subscription_tier) === user.grant_tier &&
    user.grant_tier !== user.subscription_tier
  );
}
