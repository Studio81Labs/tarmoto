import { ApiProperty } from '@nestjs/swagger';
import type { PublicProfile } from '@tarmoto/shared';

/**
 * Public-facing rider profile (US-27, convergence US-345). Returned by
 * `GET /users/:userId/profile` and consumed by both mobile and the companion
 * rider page so the two clients stay on a single contract.
 *
 * The `implements PublicProfile` clause locks the field set / nullability to
 * the canonical interface in `@tarmoto/shared` — drift here surfaces as a
 * compile error, not a runtime mismatch on the wire.
 *
 * `is_following` is computed from the authenticated viewer's perspective and
 * is `null` when the viewer is the target so the client can hide the follow
 * button without falsely defaulting to "not following".
 */
export class PublicProfileDto implements PublicProfile {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  display_name!: string;

  @ApiProperty({ nullable: true })
  avatar_url!: string | null;

  @ApiProperty({ nullable: true })
  bio!: string | null;

  @ApiProperty({ nullable: true })
  home_region!: string | null;

  @ApiProperty({ description: 'ISO 8601 join timestamp.' })
  created_at!: string;

  @ApiProperty()
  follower_count!: number;

  @ApiProperty()
  following_count!: number;

  @ApiProperty({
    description:
      "Lifetime distance ridden (km) summed over the rider's completed rides. 0 when none.",
  })
  total_distance_km!: number;

  @ApiProperty({
    description:
      'Count of the rider\'s publicly shared rides (the "Rides shared" tile).',
  })
  shared_ride_count!: number;

  @ApiProperty({
    nullable: true,
    description:
      "Viewer's follow state on the target. Null when the viewer is the target.",
  })
  is_following!: boolean | null;

  @ApiProperty({ description: 'True when the viewer is the target.' })
  is_self!: boolean;
}
