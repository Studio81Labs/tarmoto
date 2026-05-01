import { ApiProperty } from '@nestjs/swagger';

/**
 * Public-facing rider profile (US-27). Returned by
 * `GET /users/:userId/profile` to power the mobile rider profile screen
 * and the companion's `/community/[riderId]` view.
 *
 * `is_following` is computed from the authenticated viewer's perspective —
 * `null` when the viewer is looking at their own profile so the client can
 * hide the follow button without falsely defaulting to "not following".
 */
export class PublicProfileDto {
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
    nullable: true,
    description:
      "Viewer's follow state on the target. Null when the viewer is the target.",
  })
  is_following!: boolean | null;

  @ApiProperty({ description: 'True when the viewer is the target.' })
  is_self!: boolean;
}
