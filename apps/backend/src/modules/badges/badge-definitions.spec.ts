import {
  BADGE_DEFINITIONS,
  getBadgeDefinition,
  computeTier,
} from './badge-definitions.js';

describe('badge-definitions', () => {
  describe('BADGE_DEFINITIONS', () => {
    it('should have 7 badge definitions', () => {
      expect(BADGE_DEFINITIONS).toHaveLength(7);
    });

    it('should have unique keys', () => {
      const keys = BADGE_DEFINITIONS.map((b) => b.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('should have valid tiers (bronze < silver < gold)', () => {
      for (const def of BADGE_DEFINITIONS) {
        expect(def.tiers.bronze).toBeLessThan(def.tiers.silver);
        expect(def.tiers.silver).toBeLessThan(def.tiers.gold);
      }
    });
  });

  describe('getBadgeDefinition', () => {
    it('should return definition for valid key', () => {
      const def = getBadgeDefinition('total_distance');
      expect(def?.name).toBe('Road Warrior');
    });

    it('should return undefined for invalid key', () => {
      expect(getBadgeDefinition('nonexistent')).toBeUndefined();
    });
  });

  describe('computeTier', () => {
    const tiers = { bronze: 100, silver: 1000, gold: 10000 };

    it('should return null below bronze', () => {
      expect(computeTier(50, tiers)).toBeNull();
    });

    it('should return bronze at threshold', () => {
      expect(computeTier(100, tiers)).toBe('bronze');
    });

    it('should return bronze between thresholds', () => {
      expect(computeTier(500, tiers)).toBe('bronze');
    });

    it('should return silver at threshold', () => {
      expect(computeTier(1000, tiers)).toBe('silver');
    });

    it('should return gold at threshold', () => {
      expect(computeTier(10000, tiers)).toBe('gold');
    });

    it('should return gold above threshold', () => {
      expect(computeTier(99999, tiers)).toBe('gold');
    });
  });
});
