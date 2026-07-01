import { BADGE_DEFINITIONS, computeTier } from './badge-definitions.js';

/**
 * Rider progression — a deterministic XP / level / tier model derived purely
 * from the rider's lifetime achievement stats (the same aggregates
 * `BadgesService.computeStats` produces). There is no XP ledger: XP is
 * recomputed from current stats on every read, so it always reflects the
 * rider's real achievements and needs no event backfill. Delete a ride and
 * the XP that ride contributed disappears with it.
 */

/**
 * XP awarded per unit of each cumulative lifetime stat. Distance dominates for
 * touring riders, while exploration/community actions still move the needle.
 * `single_ride` (a max, not a cumulative count) is intentionally excluded from
 * the weighted sum — it contributes only through its badge bonus below.
 */
export const XP_WEIGHTS: Record<string, number> = {
  total_distance: 1, // 1 XP per km ridden
  ride_count: 50, // 50 XP per completed ride
  roads_discovered: 10, // 10 XP per unique road segment
  reviews_written: 20, // 20 XP per road review
  hazards_reported: 25, // 25 XP per hazard reported
  rides_shared: 30, // 30 XP per public share
};

/** Bonus XP for each badge tier the rider has unlocked. */
export const BADGE_TIER_XP: Record<string, number> = {
  bronze: 150,
  silver: 400,
  gold: 1000,
};

/**
 * Named tiers, each spanning a band of levels. The current tier is the
 * highest whose `minLevel` the rider has reached. Mirrors the v2 design
 * (Curve Hunter at levels 10–14, Mountain Goat next).
 */
export const TIERS: ReadonlyArray<{ name: string; minLevel: number }> = [
  { name: 'Rookie Rider', minLevel: 1 },
  { name: 'Road Tripper', minLevel: 5 },
  { name: 'Curve Hunter', minLevel: 10 },
  { name: 'Mountain Goat', minLevel: 15 },
  { name: 'Pass Master', minLevel: 20 },
  { name: 'Tarmac Legend', minLevel: 25 },
];

/**
 * Cumulative XP required to *reach* a level (level 1 = 0 XP). Quadratic growth
 * so early levels come quickly and later ones take real mileage:
 * L2=250, L5=2 500, L10=11 250, L14=22 750.
 */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return 125 * (level - 1) * level;
}

/** Largest level whose `xpForLevel` the rider's XP has reached (min 1). */
export function levelForXp(xp: number): number {
  if (xp < xpForLevel(2)) return 1;
  // Invert 125·L·(L−1) ≤ xp → L ≤ (1 + √(1 + 4·xp/125)) / 2.
  return Math.floor((1 + Math.sqrt(1 + (4 * xp) / 125)) / 2);
}

/** Total XP earned from the rider's lifetime stats + unlocked badge tiers. */
export function xpFromStats(stats: Record<string, number>): number {
  let xp = 0;
  for (const [key, weight] of Object.entries(XP_WEIGHTS)) {
    xp += Math.max(0, stats[key] ?? 0) * weight;
  }
  for (const def of BADGE_DEFINITIONS) {
    const tier = computeTier(stats[def.key] ?? 0, def.tiers);
    if (tier) xp += BADGE_TIER_XP[tier] ?? 0;
  }
  return Math.round(xp);
}

export interface ProgressionResult {
  xp: number;
  level: number;
  tier: string;
  /** Next tier's name, or null when the rider is at the top tier. */
  next_tier: string | null;
  /** XP at the start of the current tier (the progress bar's left edge). */
  current_tier_xp: number;
  /** XP needed to reach the next tier, or null at the top tier. */
  next_tier_xp: number | null;
  /** XP remaining to the next tier; 0 at the top tier. */
  xp_to_next_tier: number;
}

/** Derive the full progression snapshot from a rider's lifetime stats. */
export function deriveProgression(
  stats: Record<string, number>,
): ProgressionResult {
  const xp = xpFromStats(stats);
  const level = levelForXp(xp);

  // Current tier = the highest whose minLevel the rider has reached.
  let index = 0;
  for (let i = 0; i < TIERS.length; i++) {
    const tier = TIERS[i];
    if (tier && level >= tier.minLevel) index = i;
  }
  const current = TIERS[index];
  if (!current) throw new Error('TIERS must define at least one tier');
  const next = TIERS[index + 1] ?? null;

  const current_tier_xp = xpForLevel(current.minLevel);
  const next_tier_xp = next ? xpForLevel(next.minLevel) : null;
  const xp_to_next_tier =
    next_tier_xp != null ? Math.max(0, next_tier_xp - xp) : 0;

  return {
    xp,
    level,
    tier: current.name,
    next_tier: next?.name ?? null,
    current_tier_xp,
    next_tier_xp,
    xp_to_next_tier,
  };
}
