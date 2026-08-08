import {
  grantOutranksSubscription,
  resolveEntitledTier,
  type EntitlementSources,
} from './entitlement.js';

describe('resolveEntitledTier (#1132)', () => {
  const sources = (
    grant: EntitlementSources['grant_tier'],
    subscription: EntitlementSources['subscription_tier'],
  ): EntitlementSources => ({
    grant_tier: grant,
    subscription_tier: subscription,
  });

  it('is a NO-OP on every shape the backfill produces', () => {
    // The migration copies `subscription_tier` into `grant_tier` for grant rows
    // and leaves the original in place, so both columns hold the same value.
    // That is what makes the expand step behaviour-free — if this were not
    // exact, shipping the resolver would silently change live entitlement.
    expect(resolveEntitledTier(sources('pro', 'pro'))).toBe('pro');
    expect(resolveEntitledTier(sources('premium', 'premium'))).toBe('premium');
    // And on non-grant rows, where the backfill wrote nothing.
    expect(resolveEntitledTier(sources(null, 'pro'))).toBe('pro');
    expect(resolveEntitledTier(sources(null, 'free'))).toBe('free');
  });

  it('keeps the GRANT when the subscription drops to free', () => {
    // The bug this whole change exists to make impossible: a failed checkout or
    // a terminal clear zeroing the subscription side used to take the founder
    // grant with it, because they shared one column.
    expect(resolveEntitledTier(sources('premium', 'free'))).toBe('premium');
  });

  it('lets a paid upgrade EXCEED an older grant', () => {
    // The mirror failure: capping a rider at their grant would mean someone who
    // pays for premium while holding a pro grant gets pro.
    expect(resolveEntitledTier(sources('pro', 'premium'))).toBe('premium');
  });

  it('never returns less than either side', () => {
    const tiers = ['free', 'pro', 'premium'] as const;
    // A grant can only be a PAID tier — `free` is rejected by the type, the
    // entity and the database alike.
    const grants = ['pro', 'premium'] as const;
    for (const grant of [...grants, null]) {
      for (const subscription of tiers) {
        const resolved = resolveEntitledTier(sources(grant, subscription));
        expect(resolveEntitledTier(sources(null, resolved))).toBe(resolved);
        // Monotonic in both arguments — neither source can lower the result.
        expect(resolveEntitledTier(sources(grant, subscription))).not.toBe(
          undefined,
        );
        if (grant != null) {
          expect(tiers.indexOf(resolved)).toBeGreaterThanOrEqual(
            tiers.indexOf(grant),
          );
        }
        expect(tiers.indexOf(resolved)).toBeGreaterThanOrEqual(
          tiers.indexOf(subscription),
        );
      }
    }
  });
});

describe('grantOutranksSubscription (#1132)', () => {
  it('is true only when the grant is STRICTLY higher', () => {
    // Gates a MESSAGE, not a write: a cancellation email is wrong for a rider
    // who keeps premium through a grant, even though their subscription ended.
    expect(
      grantOutranksSubscription({
        grant_tier: 'premium',
        subscription_tier: 'free',
      }),
    ).toBe(true);
    // Equal is not outranking — the backfill's shape, and the common one.
    expect(
      grantOutranksSubscription({
        grant_tier: 'pro',
        subscription_tier: 'pro',
      }),
    ).toBe(false);
    expect(
      grantOutranksSubscription({
        grant_tier: 'pro',
        subscription_tier: 'premium',
      }),
    ).toBe(false);
    expect(
      grantOutranksSubscription({
        grant_tier: null,
        subscription_tier: 'free',
      }),
    ).toBe(false);
  });
});
