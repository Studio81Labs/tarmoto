/**
 * Canonical wire shape for rider progression (XP / level / tier).
 *
 * Single source of truth — the backend `ProgressionDto implements
 * RiderProgression`, and mobile + companion consume it via
 * `import type { RiderProgression } from "@tarmoto/shared"`. A field added
 * here propagates to all three; drift surfaces as a TypeScript error in CI.
 *
 * XP is derived deterministically from the rider's lifetime achievement stats
 * (distance, rides, roads, hazards, reviews, shares + unlocked badge tiers) —
 * there is no XP ledger, so the value always reflects current achievements.
 */
export interface RiderProgression {
  /** Total XP, derived from lifetime achievement stats. */
  xp: number;
  /** Level derived from `xp` via the progression curve (min 1). */
  level: number;
  /** Current named tier (the highest whose level band the rider has reached). */
  tier: string;
  /** Next tier's name, or null when the rider is at the top tier. */
  next_tier: string | null;
  /** XP at the start of the current tier — the progress bar's left edge. */
  current_tier_xp: number;
  /** XP needed to reach the next tier, or null at the top tier. */
  next_tier_xp: number | null;
  /** XP remaining to the next tier; 0 at the top tier. */
  xp_to_next_tier: number;
}
