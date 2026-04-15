export interface BadgeDefinition {
  key: string;
  name: string;
  description: string;
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
    name: 'Road Warrior',
    description: 'Total distance ridden',
    category: 'distance',
    tiers: { bronze: 100, silver: 1000, gold: 10000 },
  },
  {
    key: 'single_ride',
    name: 'Iron Butt',
    description: 'Longest single ride distance',
    category: 'distance',
    tiers: { bronze: 50, silver: 200, gold: 500 },
  },
  {
    key: 'ride_count',
    name: 'Regular Rider',
    description: 'Total number of completed rides',
    category: 'distance',
    tiers: { bronze: 10, silver: 50, gold: 200 },
  },

  // Exploration badges — unique road segments ridden
  {
    key: 'roads_discovered',
    name: 'Explorer',
    description: 'Unique road segments ridden',
    category: 'exploration',
    tiers: { bronze: 25, silver: 100, gold: 500 },
  },
  {
    key: 'reviews_written',
    name: 'Road Critic',
    description: 'Road reviews written',
    category: 'exploration',
    tiers: { bronze: 5, silver: 25, gold: 100 },
  },

  // Community badges — hazards reported, shared rides
  {
    key: 'hazards_reported',
    name: 'Safety Scout',
    description: 'Hazards reported to the community',
    category: 'community',
    tiers: { bronze: 5, silver: 25, gold: 100 },
  },
  {
    key: 'rides_shared',
    name: 'Social Rider',
    description: 'Rides shared with the community',
    category: 'community',
    tiers: { bronze: 3, silver: 15, gold: 50 },
  },
];

export function getBadgeDefinition(key: string): BadgeDefinition | undefined {
  return BADGE_DEFINITIONS.find((b) => b.key === key);
}

export function computeTier(
  value: number,
  tiers: BadgeDefinition['tiers'],
): string | null {
  if (value >= tiers.gold) return 'gold';
  if (value >= tiers.silver) return 'silver';
  if (value >= tiers.bronze) return 'bronze';
  return null;
}
