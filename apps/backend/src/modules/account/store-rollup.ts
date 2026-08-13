import { higherTier, type StoreTier } from '@tarmoto/shared';

/** One live chain, as the rollup computation sees it. */
export interface RollupChain {
  tier: StoreTier;
  /** Null means "no known end" — bounded below, never treated as eternal. */
  currentPeriodEnd: Date | null;
  /** Last time the store told us about this chain (`store_signed_date`). */
  observedAt: Date;
}

/** What `users.store_subscription_tier` / `_expires_at` should hold. */
export interface StoreRollupValue {
  tier: StoreTier | null;
  expiresAt: Date | null;
}

/** The rider has no store side — both columns null, which the paired CHECK requires. */
const NO_STORE: StoreRollupValue = { tier: null, expiresAt: null };

/**
 * Compute the rollup from a rider's LIVE chains.
 *
 * The tier is the max over those chains. The expiry is the LATEST period end
 * among the chains **at that max tier** — not among all of them, and not the
 * earliest.
 *
 * Why the latest at the max tier: the rollup's expiry answers "when does this
 * cached tier stop being trustworthy?", and the tier stops being produced when
 * the last chain producing it ends. Taking the earliest would invalidate the
 * cache while a sibling chain at the same tier was still paying for it — a
 * paying rider dropped to `free` until recomputation ran. Taking the latest
 * across ALL chains would keep a Premium rollup alive on the strength of a Pro
 * chain's longer period, granting a tier nobody is paying for.
 *
 * A null period end contributes the BOUNDED FALLBACK rather than nothing.
 * Letting it produce a null expiry would defeat self-invalidation twice over:
 * the lapse check could never fire, and the sweep's partial index would still
 * find the row but have no deadline to act on — so a lost terminal would grant
 * paid access indefinitely. `store_subscription_tier_expires_at` is therefore
 * NEVER null while the tier is set, which is what `users_store_rollup_paired_check`
 * enforces at the database.
 *
 * Pure and synchronous: the caller decides which chains are live and supplies
 * the window, so this can be reused by the claim writers and by the expiry
 * sweep without either owning the liveness rule.
 */
export function computeStoreRollup(
  liveChains: readonly RollupChain[],
  fallbackWindowMs: number,
): StoreRollupValue {
  if (liveChains.length === 0) return NO_STORE;

  const tier = liveChains.reduce<StoreTier | null>(
    (best, chain) =>
      best == null || higherTier(best, chain.tier) === chain.tier
        ? chain.tier
        : best,
    null,
  );
  if (tier == null) return NO_STORE;

  const expiresAt = liveChains
    .filter((chain) => chain.tier === tier)
    .reduce<Date | null>((latest, chain) => {
      const end =
        chain.currentPeriodEnd ??
        new Date(chain.observedAt.getTime() + fallbackWindowMs);
      return latest == null || end.getTime() > latest.getTime() ? end : latest;
    }, null);

  return { tier, expiresAt };
}
