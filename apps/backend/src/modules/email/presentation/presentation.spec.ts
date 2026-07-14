import {
  digestPresentation,
  subscriptionCancelledPresentation,
  subscriptionConfirmedPresentation,
  TEMPLATE_WHITELIST,
  EDITABLE_TAGS,
  type EditableTag,
} from './index.js';

/**
 * Presentation-layer coverage for the admin email template editor (Phase 1).
 * `templates.snapshot.spec.ts` guards that the code templates still render
 * byte-identical output after the presentationContext extraction; these
 * tests guard the presentation functions themselves — the pluralization and
 * empty-value rules an admin block document will rely on later.
 */

const DIGEST_BASE = {
  displayName: 'Riku',
  totalKm: 213.7,
  totalMinutes: 372,
  percentExplored: 38,
  riddenSegments: 512,
  units: 'metric' as const,
  exploreUrl: 'https://app.tarmoto.example/explore',
  locale: 'en' as const,
};

describe('digestPresentation', () => {
  it('pluralizes "1 ride" for a single ride', () => {
    const { textVars } = digestPresentation({
      ...DIGEST_BASE,
      rideCount: 1,
      bestQuality: 4.2,
    });
    expect(textVars.rideSummary).toBe('1 ride');
  });

  it('pluralizes "4 rides" for multiple rides', () => {
    const { textVars } = digestPresentation({
      ...DIGEST_BASE,
      rideCount: 4,
      bestQuality: 4.2,
    });
    expect(textVars.rideSummary).toBe('4 rides');
  });

  it('renders an empty quality string when bestQuality is null', () => {
    const { textVars } = digestPresentation({
      ...DIGEST_BASE,
      rideCount: 4,
      bestQuality: null,
    });
    expect(textVars.quality).toBe('');
  });

  it('formats a non-null quality as "x.x / 5"', () => {
    const { textVars } = digestPresentation({
      ...DIGEST_BASE,
      rideCount: 4,
      bestQuality: 4.2,
    });
    expect(textVars.quality).toBe('4.2 / 5');
  });

  it('keeps the raw ride count separate from the pluralized summary', () => {
    const { textVars } = digestPresentation({
      ...DIGEST_BASE,
      rideCount: 4,
      bestQuality: 4.2,
    });
    expect(textVars.rideCount).toBe('4');
    expect(textVars.rideSummary).toBe('4 rides');
  });
});

describe('subscriptionConfirmedPresentation', () => {
  const BASE = {
    displayName: 'Riku',
    planName: 'Pro',
    priceLabel: '€29.99/mo',
    manageBillingUrl: 'https://app.tarmoto.example/billing',
    locale: 'en' as const,
  };

  it('renders the renewal sentence and the raw date when renewsAt is set', () => {
    const { textVars } = subscriptionConfirmedPresentation({
      ...BASE,
      renewsAt: new Date('2026-03-01T08:00:00.000Z'),
    });
    expect(textVars.renewsText).toBe(
      'Your next renewal is on Sun, 01 Mar 2026 08:00:00 GMT.',
    );
    expect(textVars.renewsDate).toBe('Sun, 01 Mar 2026 08:00:00 GMT');
  });

  it('renders the no-renewal sentence and an empty date when renewsAt is null', () => {
    const { textVars } = subscriptionConfirmedPresentation({
      ...BASE,
      renewsAt: null,
    });
    expect(textVars.renewsText).toBe('Your subscription is active.');
    expect(textVars.renewsDate).toBe('');
  });
});

describe('subscriptionCancelledPresentation', () => {
  const BASE = {
    displayName: 'Riku',
    planName: 'Pro',
    resubscribeUrl: 'https://app.tarmoto.example/billing',
    locale: 'en' as const,
  };

  it("renders the 'access kept until' sentence when endsAt is set", () => {
    const { textVars } = subscriptionCancelledPresentation({
      ...BASE,
      endsAt: new Date('2026-03-01T08:00:00.000Z'),
    });
    expect(textVars.accessText).toBe(
      "You'll keep Pro access until Sun, 01 Mar 2026 08:00:00 GMT.",
    );
  });

  it("renders the 'access has ended' sentence when endsAt is null", () => {
    const { textVars } = subscriptionCancelledPresentation({
      ...BASE,
      endsAt: null,
    });
    expect(textVars.accessText).toBe('Your Pro access has ended.');
  });
});

describe('TEMPLATE_WHITELIST', () => {
  it("includes weekly-digest's exploreUrl in the url whitelist", () => {
    expect(TEMPLATE_WHITELIST['weekly-digest'].urlVars).toContain('exploreUrl');
  });

  it('has an entry for every editable tag, each listing displayName', () => {
    const tags = Object.keys(TEMPLATE_WHITELIST) as EditableTag[];
    expect(tags.sort()).toEqual([...EDITABLE_TAGS].sort());
    for (const tag of tags) {
      expect(TEMPLATE_WHITELIST[tag].textVars).toContain('displayName');
    }
  });

  it('gives the two no-CTA deletion notices an empty url whitelist', () => {
    expect(TEMPLATE_WHITELIST['account-deletion-scheduled'].urlVars).toEqual(
      [],
    );
    expect(TEMPLATE_WHITELIST['account-deletion-completed'].urlVars).toEqual(
      [],
    );
  });
});
