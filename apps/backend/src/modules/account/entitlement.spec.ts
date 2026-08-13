import {
  grantOutranksSubscription,
  liveStoreTier,
  resolveEntitledTier,
  type EntitlementSources,
} from './entitlement.js';

describe('resolveEntitledTier (#1132)', () => {
  describe('the store rollup (#1191)', () => {
    it('raises the entitled tier while LIVE', () => {
      // The whole point of the rollup: without it a store purchase activates on
      // /users/me while every feature guard still resolves the rider as free.
      expect(
        resolveEntitledTier(sources(null, 'free', 'pro', later(60_000)), NOW),
      ).toBe('pro');
      expect(
        resolveEntitledTier(
          sources(null, 'free', 'premium', later(60_000)),
          NOW,
        ),
      ).toBe('premium');
    });

    it('is IGNORED once its expiry has passed', () => {
      // Self-invalidation. A chain can reach current_period_end with no terminal
      // webhook, and then no chain writer runs — a writer-maintained-only cache
      // would grant the paid tier until some unrelated write touched the row.
      expect(
        resolveEntitledTier(sources(null, 'free', 'premium', later(-1)), NOW),
      ).toBe('free');
    });

    it('lapses EXACTLY at the expiry, not after it', () => {
      // The boundary is the whole mechanism, so it is pinned rather than left to
      // whichever comparison the implementation happened to use.
      expect(resolveEntitledTier(sources(null, 'free', 'pro', NOW), NOW)).toBe(
        'free',
      );
      expect(
        resolveEntitledTier(sources(null, 'free', 'pro', later(1)), NOW),
      ).toBe('pro');
    });

    it('treats a tier with NO expiry as lapsed, not as eternal', () => {
      // users_store_rollup_paired_check forbids this row, so it should be
      // unreachable — but if the invariant is ever broken, failing closed costs
      // one recomputation while failing open grants paid access forever.
      expect(
        resolveEntitledTier(sources(null, 'free', 'premium', null), NOW),
      ).toBe('free');
    });

    it('never LOWERS a tier the grant or subscription already earned', () => {
      // It is a max, not a source of truth: a lapsed store side must not revoke
      // a live grant, and a pro store chain must not cap a premium subscription.
      expect(
        resolveEntitledTier(sources('premium', 'free', 'pro', later(-1)), NOW),
      ).toBe('premium');
      expect(
        resolveEntitledTier(
          sources(null, 'premium', 'pro', later(60_000)),
          NOW,
        ),
      ).toBe('premium');
    });

    it('resolves null as no store side at all', () => {
      expect(resolveEntitledTier(sources(null, 'pro', null, null), NOW)).toBe(
        'pro',
      );
    });

    it('exposes the same predicate the projection must use', () => {
      // A reader showing a store plan the resolver had already stopped honouring
      // would tell a rider they are Pro on a page whose features are denied.
      expect(
        liveStoreTier(
          {
            store_subscription_tier: 'pro',
            store_subscription_tier_expires_at: later(60_000),
          },
          NOW,
        ),
      ).toBe('pro');
      expect(
        liveStoreTier(
          {
            store_subscription_tier: 'pro',
            store_subscription_tier_expires_at: later(-1),
          },
          NOW,
        ),
      ).toBeNull();
    });
  });

  const sources = (
    grant: EntitlementSources['grant_tier'],
    subscription: EntitlementSources['subscription_tier'],
    store: EntitlementSources['store_subscription_tier'] = null,
    storeExpiresAt: EntitlementSources['store_subscription_tier_expires_at'] = null,
  ): EntitlementSources => ({
    grant_tier: grant,
    subscription_tier: subscription,
    store_subscription_tier: store,
    store_subscription_tier_expires_at: storeExpiresAt,
  });

  const NOW = new Date('2026-08-13T12:00:00Z');
  const later = (ms: number) => new Date(NOW.getTime() + ms);

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
