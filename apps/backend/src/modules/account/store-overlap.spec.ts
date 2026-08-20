import {
  allOverlapPairs,
  buildOverlapPair,
  computeEscalateAfter,
  decodeOverlapMember,
  encodeOverlapMember,
  type OverlapMember,
} from './store-overlap.js';
import {
  effectivePeriodEnd,
  isFutureBilling,
  isSourceLive,
} from './store-chain-liveness.js';

const DAY = 24 * 3600_000;
const FALLBACK_MS = 35 * DAY;
const GRACE_MS = 72 * 3600_000;
const NOW = new Date('2026-08-20T12:00:00.000Z');

const member = (over: Partial<OverlapMember> = {}): OverlapMember => ({
  provider: 'google',
  identity: 'GPA.1',
  currentPeriodEnd: new Date(NOW.getTime() + 30 * DAY),
  observedAt: NOW,
  purchasedAt: null,
  ...over,
});

describe('overlap member encoding', () => {
  it('is provider-qualified and round-trips', () => {
    expect(encodeOverlapMember('apple', 'otid-1')).toBe('apple:otid-1');
    expect(decodeOverlapMember('apple:otid-1')).toEqual({
      provider: 'apple',
      identity: 'otid-1',
    });
    // Identities can themselves contain the separator (Stripe ids do not, but
    // the format only reserves the FIRST colon).
    expect(decodeOverlapMember('google:GPA.3:4')).toEqual({
      provider: 'google',
      identity: 'GPA.3:4',
    });
  });

  it('rejects a bare or unknown-provider encoding', () => {
    expect(decodeOverlapMember('GPA.1')).toBeNull();
    expect(decodeOverlapMember('paypal:x')).toBeNull();
    expect(decodeOverlapMember('apple:')).toBeNull();
  });
});

describe('buildOverlapPair', () => {
  it('byte-sorts low/high regardless of argument order', () => {
    const a = member({ provider: 'stripe', identity: 'sub_9' });
    const b = member({ provider: 'apple', identity: 'otid-1' });
    const forward = buildOverlapPair(a, b);
    const backward = buildOverlapPair(b, a);
    expect(forward).toEqual(backward);
    expect(forward.low).toBe('apple:otid-1');
    expect(forward.high).toBe('stripe:sub_9');
  });

  it('names the store-chronology OLDER member as the refund target, surviving byte order', () => {
    // Chosen adversarially: byte order puts the NEWER member (apple) in `low`,
    // so a role read off the sort — instead of the chronology — points the
    // refund at the rider's intended newer plan.
    const older = buildOverlapPair(
      member({
        provider: 'stripe',
        identity: 'sub_1',
        purchasedAt: new Date('2026-01-01T00:00:00Z'),
      }),
      member({
        provider: 'apple',
        identity: 'otid-2',
        purchasedAt: new Date('2026-06-01T00:00:00Z'),
      }),
    );
    expect(older.low).toBe('apple:otid-2');
    expect(older.olderMember).toBe('stripe:sub_1');
  });

  it('records an AMBIGUOUS target (null) when either purchase time is missing', () => {
    const pair = buildOverlapPair(
      member({ purchasedAt: new Date('2026-01-01T00:00:00Z') }),
      member({ identity: 'GPA.2', purchasedAt: null }),
    );
    expect(pair.olderMember).toBeNull();
  });

  it('records an AMBIGUOUS target on EQUAL timestamps — never an invented tie-break', () => {
    // Stripe's `created` has second granularity, so equality is a real state;
    // a tie-broken answer hands an operator a confident wrong refund target.
    const at = new Date('2026-01-01T00:00:00Z');
    const pair = buildOverlapPair(
      member({ purchasedAt: at }),
      member({ identity: 'GPA.2', purchasedAt: new Date(at.getTime()) }),
    );
    expect(pair.olderMember).toBeNull();
  });
});

describe('computeEscalateAfter', () => {
  it('is the EARLIEST member end plus grace — the earliest boundary discriminates', () => {
    const monthly = member({
      currentPeriodEnd: new Date(NOW.getTime() + 10 * DAY),
    });
    const annual = member({
      identity: 'GPA.2',
      currentPeriodEnd: new Date(NOW.getTime() + 300 * DAY),
    });
    expect(
      computeEscalateAfter([monthly, annual], FALLBACK_MS, GRACE_MS),
    ).toEqual(new Date(NOW.getTime() + 10 * DAY + GRACE_MS));
  });

  it('substitutes the fallback PER NULL MEMBER — an annual partner must not stretch the deadline to its boundary', () => {
    // The mixed case the design calls out: a null-period source beside an
    // ANNUAL one is due at the null member's own 35-day bound, not in a year.
    const nullPeriod = member({ currentPeriodEnd: null, observedAt: NOW });
    const annual = member({
      identity: 'GPA.2',
      currentPeriodEnd: new Date(NOW.getTime() + 300 * DAY),
    });
    expect(
      computeEscalateAfter([nullPeriod, annual], FALLBACK_MS, GRACE_MS),
    ).toEqual(new Date(NOW.getTime() + FALLBACK_MS + GRACE_MS));
  });

  it('anchors the null-member fallback on the LAST OBSERVATION, not row creation', () => {
    const observedEarlier = member({
      currentPeriodEnd: null,
      observedAt: new Date(NOW.getTime() - 5 * DAY),
    });
    const other = member({
      identity: 'GPA.2',
      currentPeriodEnd: new Date(NOW.getTime() + 300 * DAY),
    });
    expect(
      computeEscalateAfter([observedEarlier, other], FALLBACK_MS, GRACE_MS),
    ).toEqual(new Date(NOW.getTime() - 5 * DAY + FALLBACK_MS + GRACE_MS));
  });
});

describe('allOverlapPairs', () => {
  it('is pairwise: three sources produce THREE pairs', () => {
    const sources = [
      member({ provider: 'stripe', identity: 'sub_1' }),
      member({ provider: 'google', identity: 'GPA.2' }),
      member({ provider: 'google', identity: 'GPA.3' }),
    ];
    const pairs = allOverlapPairs(sources).map(([a, b]) =>
      [a.identity, b.identity].sort(),
    );
    expect(pairs).toHaveLength(3);
    expect(pairs).toContainEqual(['GPA.2', 'sub_1']);
    expect(pairs).toContainEqual(['GPA.3', 'sub_1']);
    expect(pairs).toContainEqual(['GPA.2', 'GPA.3']);
  });
});

describe('liveness predicates', () => {
  it('a null period end is bounded by the fallback window, never eternal', () => {
    expect(effectivePeriodEnd(null, NOW, FALLBACK_MS)).toEqual(
      new Date(NOW.getTime() + FALLBACK_MS),
    );
    expect(
      isSourceLive(
        { currentPeriodEnd: null, observedAt: NOW },
        NOW,
        FALLBACK_MS,
      ),
    ).toBe(true);
    expect(
      isSourceLive(
        {
          currentPeriodEnd: null,
          observedAt: new Date(NOW.getTime() - FALLBACK_MS - 1),
        },
        NOW,
        FALLBACK_MS,
      ),
    ).toBe(false);
  });

  it('futureBilling excludes a cancel-at-period-end source that still entitles', () => {
    // The clause a status-based implementation drops: entitling, non-terminal,
    // but its retiring event has already fired — pairing it creates a row
    // nothing can clear.
    const source = {
      terminal: false,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date(NOW.getTime() + 10 * DAY),
      observedAt: NOW,
    };
    expect(isSourceLive(source, NOW, FALLBACK_MS)).toBe(true);
    expect(isFutureBilling(source, NOW, FALLBACK_MS)).toBe(false);
  });

  it('futureBilling excludes a terminal source that still entitles to its period end', () => {
    const source = {
      terminal: true,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date(NOW.getTime() + 10 * DAY),
      observedAt: NOW,
    };
    expect(isSourceLive(source, NOW, FALLBACK_MS)).toBe(true);
    expect(isFutureBilling(source, NOW, FALLBACK_MS)).toBe(false);
  });

  it('futureBilling includes a NULL-period source inside its fallback window', () => {
    // Exercised through the real predicate on purpose: a literal
    // `current_period_end > now` skips it silently, and two subscriptions then
    // bill with no provisional row at all.
    expect(
      isFutureBilling(
        {
          terminal: false,
          cancelAtPeriodEnd: false,
          currentPeriodEnd: null,
          observedAt: NOW,
        },
        NOW,
        FALLBACK_MS,
      ),
    ).toBe(true);
  });

  it('past_due is not terminal: a retrying source still future-bills', () => {
    expect(
      isFutureBilling(
        {
          terminal: false,
          cancelAtPeriodEnd: false,
          currentPeriodEnd: new Date(NOW.getTime() + 3 * DAY),
          observedAt: NOW,
        },
        NOW,
        FALLBACK_MS,
      ),
    ).toBe(true);
  });
});
