import { ApiProperty } from '@nestjs/swagger';
import type { RiderProgression } from '@tarmoto/shared';

/**
 * Rider progression (XP / level / tier) — returned by
 * `GET /users/me/progression`. Implements the canonical `RiderProgression`
 * contract in `@tarmoto/shared` so backend, mobile, and companion stay on one
 * shape (drift is a compile error, not a runtime mismatch). XP is derived
 * deterministically from the rider's lifetime achievement stats — see
 * `progression-definitions.ts`.
 */
export class ProgressionDto implements RiderProgression {
  @ApiProperty({ description: 'Total XP, derived from lifetime stats.' })
  xp!: number;

  @ApiProperty({ description: 'Level derived from XP via the curve (min 1).' })
  level!: number;

  @ApiProperty({ description: 'Current named tier.' })
  tier!: string;

  @ApiProperty({
    nullable: true,
    description: "Next tier's name, or null at the top tier.",
  })
  next_tier!: string | null;

  @ApiProperty({ description: 'XP at the start of the current tier.' })
  current_tier_xp!: number;

  @ApiProperty({
    nullable: true,
    description: 'XP needed to reach the next tier, or null at the top tier.',
  })
  next_tier_xp!: number | null;

  @ApiProperty({ description: 'XP remaining to the next tier; 0 at the top.' })
  xp_to_next_tier!: number;
}
