import {
  deriveProgression,
  levelForXp,
  xpForLevel,
  xpFromStats,
} from './progression-definitions.js';

describe('progression-definitions', () => {
  describe('xpForLevel', () => {
    it('starts level 1 at 0 XP and grows quadratically', () => {
      expect(xpForLevel(1)).toBe(0);
      expect(xpForLevel(0)).toBe(0);
      expect(xpForLevel(2)).toBe(250);
      expect(xpForLevel(5)).toBe(2500);
      expect(xpForLevel(10)).toBe(11250);
      expect(xpForLevel(14)).toBe(22750);
      expect(xpForLevel(15)).toBe(26250);
    });
  });

  describe('levelForXp', () => {
    it('is the inverse of xpForLevel at the boundaries', () => {
      expect(levelForXp(0)).toBe(1);
      expect(levelForXp(249)).toBe(1);
      expect(levelForXp(250)).toBe(2);
      expect(levelForXp(11250)).toBe(10);
      expect(levelForXp(22750)).toBe(14);
      // Just shy of the next threshold stays on the current level.
      expect(levelForXp(26249)).toBe(14);
      expect(levelForXp(26250)).toBe(15);
    });
  });

  describe('xpFromStats', () => {
    it('weights cumulative stats and adds badge-tier bonuses', () => {
      // 1000 km (gold Road Warrior? no — silver at 1000) → 1000 XP + silver bonus.
      // Build a tidy case: 100 km, 10 rides, no badges past bronze.
      const xp = xpFromStats({
        total_distance: 100, // 100 XP + bronze Road Warrior (150)
        ride_count: 10, // 500 XP + bronze Regular Rider (150)
        roads_discovered: 0,
        reviews_written: 0,
        hazards_reported: 0,
        rides_shared: 0,
        single_ride: 0,
      });
      // 100 + 500 weighted = 600; bronze total_distance(150) + bronze ride_count(150) = 300.
      expect(xp).toBe(900);
    });

    it('ignores single_ride in the weighted sum but still credits its badge', () => {
      const withLongRide = xpFromStats({
        total_distance: 0,
        ride_count: 0,
        roads_discovered: 0,
        reviews_written: 0,
        hazards_reported: 0,
        rides_shared: 0,
        single_ride: 60, // bronze Iron Butt (≥50) → 150 XP, no weighted contribution
      });
      expect(withLongRide).toBe(150);
    });

    it('returns 0 for a rider with no achievements', () => {
      expect(xpFromStats({})).toBe(0);
    });
  });

  describe('deriveProgression', () => {
    it('places a high-mileage rider in the right tier with next-tier progress', () => {
      // 22,750 XP worth of distance lands exactly on level 14 (Curve Hunter),
      // next tier Mountain Goat starts at level 15 (26,250 XP).
      const p = deriveProgression({ total_distance: 22750 });
      // 22750 km also unlocks gold Road Warrior (+1000), so xp > 22750.
      expect(p.xp).toBe(23750);
      expect(p.level).toBe(14);
      expect(p.tier).toBe('Curve Hunter');
      expect(p.next_tier).toBe('Mountain Goat');
      expect(p.current_tier_xp).toBe(xpForLevel(10));
      expect(p.next_tier_xp).toBe(xpForLevel(15));
      expect(p.xp_to_next_tier).toBe(xpForLevel(15) - p.xp);
    });

    it('returns the Rookie tier at zero XP', () => {
      const p = deriveProgression({});
      expect(p.xp).toBe(0);
      expect(p.level).toBe(1);
      expect(p.tier).toBe('Rookie Rider');
      expect(p.next_tier).toBe('Road Tripper');
      expect(p.xp_to_next_tier).toBe(xpForLevel(5));
    });

    it('caps cleanly at the top tier (no next tier, 0 to go)', () => {
      const p = deriveProgression({ total_distance: 10_000_000 });
      expect(p.tier).toBe('Tarmac Legend');
      expect(p.next_tier).toBeNull();
      expect(p.next_tier_xp).toBeNull();
      expect(p.xp_to_next_tier).toBe(0);
    });
  });
});
