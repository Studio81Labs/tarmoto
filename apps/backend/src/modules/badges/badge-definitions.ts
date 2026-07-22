import type { BadgeKey } from '@tarmoto/shared';

export interface BadgeDefinition {
  key: BadgeKey;
  category: 'distance' | 'exploration' | 'community';
  tiers: {
    bronze: number;
    silver: number;
    gold: number;
  };
}

export const BADGE_DEFINITIONS: BadgeDefinition[] = [
  // Distance badges — total km ridden
  {
    key: 'total_distance',
    category: 'distance',
    tiers: { bronze: 100, silver: 1000, gold: 10000 },
  },
  {
    key: 'single_ride',
    category: 'distance',
    tiers: { bronze: 50, silver: 200, gold: 500 },
  },
  {
    key: 'ride_count',
    category: 'distance',
    tiers: { bronze: 10, silver: 50, gold: 200 },
  },

  // Exploration badges — unique road segments ridden
  {
    key: 'roads_discovered',
    category: 'exploration',
    tiers: { bronze: 25, silver: 100, gold: 500 },
  },
  {
    key: 'reviews_written',
    category: 'exploration',
    tiers: { bronze: 5, silver: 25, gold: 100 },
  },

  // Community badges — hazards reported, shared rides
  {
    key: 'hazards_reported',
    category: 'community',
    tiers: { bronze: 5, silver: 25, gold: 100 },
  },
  {
    key: 'rides_shared',
    category: 'community',
    tiers: { bronze: 3, silver: 15, gold: 50 },
  },
];

export function computeTier(
  value: number,
  tiers: BadgeDefinition['tiers'],
): string | null {
  if (value >= tiers.gold) return 'gold';
  if (value >= tiers.silver) return 'silver';
  if (value >= tiers.bronze) return 'bronze';
  return null;
}
