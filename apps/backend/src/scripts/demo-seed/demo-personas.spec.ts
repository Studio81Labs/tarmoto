import { SUBSCRIPTION_TIERS } from '@tarmoto/shared';
import {
  BADGE_DEFINITIONS,
  computeTier,
} from '../../modules/badges/badge-definitions.js';
import { DEMO_PERSONAS, demoPasswordFor } from './demo-personas.js';
import { REAL_DEMO_RIDES, REAL_DEMO_TRIPS } from './real-demo-rides.data.js';

/**
 * Map a persona's declared activity volumes onto the same stat keys the
 * `BadgesService` computes, so the catalog can be asserted against the
 * real badge thresholds. `single_ride` mirrors the longest-ride bonus the
 * seeder applies (see demo-data-builders).
 */
function personaStats(
  p: (typeof DEMO_PERSONAS)[number],
): Record<string, number> {
  return {
    total_distance: p.rideCount * p.baseRideKm,
    single_ride: p.rideCount === 0 ? 0 : p.baseRideKm * 2,
    ride_count: p.rideCount,
    roads_discovered: p.roadsRiddenCount,
    reviews_written: p.reviewCount,
    hazards_reported: p.hazardCount,
    rides_shared: p.sharedRideCount,
  };
}

describe('demo-personas', () => {
  it('defines a non-empty catalog', () => {
    expect(DEMO_PERSONAS.length).toBeGreaterThanOrEqual(2);
  });

  it('includes the two named demo accounts from the request', () => {
    const emails = DEMO_PERSONAS.map((p) => p.email);
    expect(emails).toContain('newbie@tarmoto.app');
    expect(emails).toContain('road.hunter@tarmoto.app');
  });

  it('uses each email as a password that satisfies the register policy (8..72 chars)', () => {
    for (const persona of DEMO_PERSONAS) {
      const password = demoPasswordFor(persona);
      expect(password.length).toBeGreaterThanOrEqual(8);
      expect(password.length).toBeLessThanOrEqual(72);
    }
  });

  it('has unique @tarmoto.app emails', () => {
    const emails = DEMO_PERSONAS.map((p) => p.email);
    expect(new Set(emails).size).toBe(emails.length);
    for (const email of emails) {
      expect(email).toMatch(/^[^@]+@tarmoto\.app$/);
      expect(email).toBe(email.toLowerCase());
    }
  });

  it('uses only valid subscription tiers', () => {
    for (const p of DEMO_PERSONAS) {
      expect(SUBSCRIPTION_TIERS).toContain(p.subscription_tier);
    }
  });

  it('declares non-negative integer activity volumes', () => {
    const counts: (keyof (typeof DEMO_PERSONAS)[number])[] = [
      'rideCount',
      'roadsRiddenCount',
      'hazardCount',
      'reviewCount',
      'sharedRideCount',
      'tripCount',
      'joinedDaysAgo',
    ];
    for (const p of DEMO_PERSONAS) {
      for (const key of counts) {
        const value = p[key] as number;
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
      expect(p.bikes.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('never shares more rides than it completed', () => {
    for (const p of DEMO_PERSONAS) {
      expect(p.sharedRideCount).toBeLessThanOrEqual(p.rideCount);
    }
  });

  it('only follows other personas and never itself', () => {
    const emails = new Set(DEMO_PERSONAS.map((p) => p.email));
    for (const p of DEMO_PERSONAS) {
      for (const target of p.follows) {
        expect(emails.has(target)).toBe(true);
        expect(target).not.toBe(p.email);
      }
    }
  });

  it('keeps the newbie in a fresh, badge-free state', () => {
    const newbie = DEMO_PERSONAS.find((p) => p.email === 'newbie@tarmoto.app')!;
    expect(newbie.subscription_tier).toBe('free');
    const stats = personaStats(newbie);
    for (const def of BADGE_DEFINITIONS) {
      expect(computeTier(stats[def.key]!, def.tiers)).toBeNull();
    }
  });

  it('keeps a real-GPX persona in sync with the data module', () => {
    const real = DEMO_PERSONAS.filter((p) => p.useRealGpx);
    // The Brno rider is seeded from real Calimoto GPX; its ride/trip counts
    // must equal the generated data lengths or the seeder would over/under-run.
    expect(real.length).toBeGreaterThanOrEqual(1);
    for (const p of real) {
      expect(p.rideCount).toBe(REAL_DEMO_RIDES.length);
      expect(p.tripCount).toBe(REAL_DEMO_TRIPS.length);
    }
  });

  it('makes the road hunter a power user earning a gold badge', () => {
    const hunter = DEMO_PERSONAS.find(
      (p) => p.email === 'road.hunter@tarmoto.app',
    )!;
    const stats = personaStats(hunter);
    const tiers = BADGE_DEFINITIONS.map((def) =>
      computeTier(stats[def.key]!, def.tiers),
    );
    expect(tiers).toContain('gold');
  });
});
