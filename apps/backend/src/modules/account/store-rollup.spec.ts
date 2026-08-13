import { computeStoreRollup, type RollupChain } from './store-rollup.js';

describe('computeStoreRollup (#1191)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const FALLBACK = 35 * DAY;
  const T0 = new Date('2026-08-13T12:00:00Z');
  const at = (ms: number) => new Date(T0.getTime() + ms);
  const chain = (over: Partial<RollupChain> = {}): RollupChain => ({
    tier: 'pro',
    currentPeriodEnd: at(30 * DAY),
    observedAt: T0,
    ...over,
  });

  it('is EMPTY for a rider with no live chains', () => {
    // Both columns null together — the shape users_store_rollup_paired_check
    // requires, and what "no store side" is spelled as.
    expect(computeStoreRollup([], FALLBACK)).toEqual({
      tier: null,
      expiresAt: null,
    });
  });

  it('takes the MAX tier across chains', () => {
    expect(
      computeStoreRollup(
        [chain({ tier: 'pro' }), chain({ tier: 'premium' })],
        FALLBACK,
      ).tier,
    ).toBe('premium');
  });

  it('expires with the LAST chain at the max tier, not the first', () => {
    // Taking the earliest would invalidate the cache while a sibling chain at
    // the same tier was still paying for it — dropping a paying rider to free
    // until recomputation ran.
    const result = computeStoreRollup(
      [
        chain({ tier: 'premium', currentPeriodEnd: at(10 * DAY) }),
        chain({ tier: 'premium', currentPeriodEnd: at(60 * DAY) }),
      ],
      FALLBACK,
    );
    expect(result.expiresAt).toEqual(at(60 * DAY));
  });

  it('IGNORES a longer period on a LOWER tier', () => {
    // The expiry answers "when does THIS tier stop being produced?". A Pro chain
    // running longer must not keep a Premium rollup alive — that grants a tier
    // nobody is paying for, which is the failure direction that costs money.
    const result = computeStoreRollup(
      [
        chain({ tier: 'premium', currentPeriodEnd: at(10 * DAY) }),
        chain({ tier: 'pro', currentPeriodEnd: at(90 * DAY) }),
      ],
      FALLBACK,
    );
    expect(result.tier).toBe('premium');
    expect(result.expiresAt).toEqual(at(10 * DAY));
  });

  it('gives a NULL-period chain the bounded fallback, never a null expiry', () => {
    // A null expiry would defeat self-invalidation twice: the lapse check could
    // never fire, and the sweep would find the row with no deadline to act on —
    // so a lost terminal would grant paid access indefinitely.
    const result = computeStoreRollup(
      [chain({ currentPeriodEnd: null, observedAt: T0 })],
      FALLBACK,
    );
    expect(result.expiresAt).toEqual(at(FALLBACK));
  });

  it('anchors the fallback on LAST OBSERVED, not on now', () => {
    // A chain last seen a month ago is nearly out of its window; anchoring on
    // the recomputation instant would renew that trust every time the sweep ran
    // and the deadline would never arrive.
    const observedAt = at(-30 * DAY);
    const result = computeStoreRollup(
      [chain({ currentPeriodEnd: null, observedAt })],
      FALLBACK,
    );
    expect(result.expiresAt).toEqual(new Date(observedAt.getTime() + FALLBACK));
  });

  it('prefers a real date over a fallback at the same tier', () => {
    // The fallback is a floor for an unknown end, not a claim that access runs
    // that long — but it must still win if it genuinely outlasts the known one,
    // since both chains are live and at the max tier.
    const result = computeStoreRollup(
      [
        chain({ tier: 'pro', currentPeriodEnd: at(5 * DAY) }),
        chain({ tier: 'pro', currentPeriodEnd: null, observedAt: T0 }),
      ],
      FALLBACK,
    );
    expect(result.expiresAt).toEqual(at(FALLBACK));
  });
});
