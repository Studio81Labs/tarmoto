import {
  SUBSCRIPTION_PROVIDERS,
  type SubscriptionProvider,
} from '@tarmoto/shared';
import type { StoreTier } from '@tarmoto/shared';

/**
 * One live billing source, as the projection sees it.
 *
 * "Live" is the caller's judgement, not this module's: Stripe liveness comes
 * from the snapshot's `entitling` flag, a chain's from its period end. By the
 * time a source reaches the election it is already known to entitle, so the
 * ordering below never has to reason about expiry.
 */
export interface BillingSource {
  provider: SubscriptionProvider;
  /**
   * The stable identity within the provider — a Stripe subscription id, or a
   * chain's `target_key`.
   *
   * Present solely to make the ordering TOTAL. Two chains of one provider can
   * match on tier and period end, and without a final key the election would be
   * decided by whatever order the database happened to return — so two replicas
   * could show different `provider` / `managed_by` for the same rider.
   */
  identity: string;
  tier: StoreTier;
  status: 'active' | 'trialing' | 'past_due' | 'canceled';
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/** `stripe` < `apple` < `google` — a fixed order, not the enum's declaration order. */
const PROVIDER_RANK: Record<SubscriptionProvider, number> = {
  stripe: 0,
  apple: 1,
  google: 2,
};

/** Paid tiers ascending, so "highest tier" is a number comparison. */
const TIER_RANK: Record<StoreTier, number> = { pro: 1, premium: 2 };

/**
 * Elect the ONE source whose billing the API reports.
 *
 * Entitlement is a max over every source; the projection is single-valued. With
 * two live chains at different tiers, periods or statuses there is no natural
 * rule for which drives the management link and the displayed renewal, so the
 * design supplies one and this is it.
 *
 * **This does NOT decide `current_plan.tier`.** That answers "what is the rider
 * entitled to?" and is the resolved tier, grant included. The representative
 * answers the different question "who manages the billing behind it?" — every
 * other field comes from here. Collapsing the two breaks grants: a Premium grant
 * alongside a live Pro subscription has no Premium source to elect, so the
 * projection would show a weaker plan than the backend actually grants.
 *
 * Order, in full:
 *
 * 1. **Highest tier** — the source that actually produces the entitled tier.
 *    Anything else shows a rider a plan weaker than the one they hold.
 * 2. **Latest `currentPeriodEnd`, NULLS LAST** — the access that survives
 *    longest. The null rule is explicit because both sides can produce one, and
 *    "nulls first", "nulls last" and a database default would each elect a
 *    different source. Losing is the right side for null: `renews_at` is read
 *    from the representative, so electing a source with no known end hands the
 *    rider a blank where a real date was available.
 * 3. **Provider rank**, then **identity ascending** — which makes the order
 *    total, so the projection is stable across requests and across replicas
 *    rather than merely deterministic-looking.
 *
 * Deliberately NOT `created_at`: Stripe stays on the `users` row, which has no
 * subscription-created timestamp, and the billing snapshot does not carry one
 * either — so that rule would need an undocumented fallback and two replicas
 * could disagree.
 */
export function electRepresentative(
  sources: readonly BillingSource[],
): BillingSource | null {
  if (sources.length === 0) return null;
  return [...sources].sort(compareBillingSources)[0] ?? null;
}

/** Exported for the tests that pin each tie-break independently. */
export function compareBillingSources(
  a: BillingSource,
  b: BillingSource,
): number {
  const byTier = TIER_RANK[b.tier] - TIER_RANK[a.tier];
  if (byTier !== 0) return byTier;

  const byPeriodEnd = comparePeriodEndDesc(
    a.currentPeriodEnd,
    b.currentPeriodEnd,
  );
  if (byPeriodEnd !== 0) return byPeriodEnd;

  const byProvider = PROVIDER_RANK[a.provider] - PROVIDER_RANK[b.provider];
  if (byProvider !== 0) return byProvider;

  return a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
}

/** Later first; a null end is the LOSER, never the winner. */
function comparePeriodEndDesc(a: Date | null, b: Date | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return b.getTime() - a.getTime();
}

/** Every provider has a rank — a new one must be given one deliberately. */
export const PROVIDER_RANK_IS_TOTAL: boolean = SUBSCRIPTION_PROVIDERS.every(
  (provider) => PROVIDER_RANK[provider] !== undefined,
);
