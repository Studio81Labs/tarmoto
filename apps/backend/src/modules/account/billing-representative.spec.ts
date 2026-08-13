import { SUBSCRIPTION_PROVIDERS } from '@tarmoto/shared';
import {
  electRepresentative,
  PROVIDER_RANK_IS_TOTAL,
  type BillingSource,
} from './billing-representative.js';

describe('electRepresentative (#1191)', () => {
  const T = (iso: string) => new Date(iso);
  const src = (over: Partial<BillingSource> = {}): BillingSource => ({
    provider: 'stripe',
    identity: 'sub_1',
    tier: 'pro',
    status: 'active',
    currentPeriodEnd: T('2026-09-01T00:00:00Z'),
    cancelAtPeriodEnd: false,
    ...over,
  });

  it('returns null when the rider has no live billing source', () => {
    // A grant-only rider. The caller still projects a tier — the RESOLVED one —
    // but there is no billing behind it to manage.
    expect(electRepresentative([])).toBeNull();
  });

  it('elects the HIGHEST tier first', () => {
    // Anything else shows a rider a plan weaker than the one they hold.
    const pro = src({ identity: 'a', tier: 'pro' });
    const premium = src({
      identity: 'b',
      tier: 'premium',
      provider: 'google',
      // Deliberately the WORSE key on every later rule, so only tier can be
      // what elected it.
      currentPeriodEnd: T('2026-08-20T00:00:00Z'),
    });
    expect(electRepresentative([pro, premium])).toBe(premium);
  });

  it('prefers the LATEST period end at equal tier', () => {
    const soon = src({
      identity: 'a',
      currentPeriodEnd: T('2026-09-01T00:00:00Z'),
    });
    const later = src({
      identity: 'b',
      currentPeriodEnd: T('2026-12-01T00:00:00Z'),
    });
    expect(electRepresentative([soon, later])).toBe(later);
  });

  it('sorts a NULL period end LAST, never first', () => {
    // renews_at is read from the representative, so electing a source with no
    // known end hands the rider a blank where a real date was available. Both
    // sides can produce a null, and nulls-first / nulls-last / database default
    // would each elect a different source.
    const unknownEnd = src({ identity: 'a', currentPeriodEnd: null });
    const knownEnd = src({
      identity: 'b',
      currentPeriodEnd: T('2026-08-20T00:00:00Z'),
    });
    expect(electRepresentative([unknownEnd, knownEnd])).toBe(knownEnd);
    expect(electRepresentative([knownEnd, unknownEnd])).toBe(knownEnd);
  });

  it('falls back to provider rank stripe < apple < google', () => {
    const google = src({ provider: 'google', identity: 'a' });
    const apple = src({ provider: 'apple', identity: 'b' });
    const stripe = src({ provider: 'stripe', identity: 'c' });
    expect(electRepresentative([google, apple, stripe])).toBe(stripe);
    expect(electRepresentative([google, apple])).toBe(apple);
  });

  it('breaks a full tie on identity, so the order is TOTAL', () => {
    // Two chains of one provider can match on tier and period end. Without this
    // the winner is whatever order the database returned, and two replicas could
    // report different provider / managed_by for the same rider.
    const b = src({ provider: 'google', identity: 'GPA.b' });
    const a = src({ provider: 'google', identity: 'GPA.a' });
    expect(electRepresentative([b, a])).toBe(a);
    expect(electRepresentative([a, b])).toBe(a);
  });

  it('is STABLE regardless of input order', () => {
    // The property the tie-breaks exist for: same set, same winner, every
    // permutation. A projection that depends on row order is a bug that only
    // shows up under a different plan or a different replica.
    const sources = [
      src({ provider: 'google', identity: 'g1', tier: 'pro' }),
      src({ provider: 'apple', identity: 'a1', tier: 'pro' }),
      src({ provider: 'stripe', identity: 's1', tier: 'pro' }),
      src({
        provider: 'apple',
        identity: 'a2',
        tier: 'pro',
        currentPeriodEnd: null,
      }),
    ];
    const permutations = [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [2, 0, 3, 1],
      [1, 3, 0, 2],
    ];
    const winners = permutations.map(
      (order) => electRepresentative(order.map((i) => sources[i]!))?.identity,
    );
    expect(new Set(winners).size).toBe(1);
    expect(winners[0]).toBe('s1');
  });

  it('does NOT let a canceled status lose to a lower tier', () => {
    // Status is not a tie-break. A canceled subscription still entitles until
    // its period ends, and the caller has already filtered to live sources — so
    // demoting it here would show the weaker plan of the two.
    const canceledPremium = src({
      identity: 'a',
      tier: 'premium',
      status: 'canceled',
      cancelAtPeriodEnd: true,
    });
    const activePro = src({ identity: 'b', tier: 'pro', status: 'active' });
    expect(electRepresentative([canceledPremium, activePro])).toBe(
      canceledPremium,
    );
  });

  it('ranks every provider in the shared vocabulary', () => {
    // A new provider added to @tarmoto/shared without a rank here would sort as
    // NaN and quietly randomise the election.
    expect(PROVIDER_RANK_IS_TOTAL).toBe(true);
    expect(SUBSCRIPTION_PROVIDERS.length).toBe(3);
  });
});
