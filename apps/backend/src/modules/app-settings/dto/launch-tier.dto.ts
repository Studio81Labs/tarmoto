import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { LAUNCH_GRANT_TIERS, type LaunchGrantTier } from '@tarmoto/shared';

export class SetLaunchTierDto {
  @ApiProperty({
    enum: [...LAUNCH_GRANT_TIERS, null],
    nullable: true,
    description:
      'Tier auto-granted to new registrations (plan_source "founder"); ' +
      'null turns launch mode off. Existing users are never modified.',
  })
  @IsIn([...LAUNCH_GRANT_TIERS, null])
  tier!: LaunchGrantTier | null;
}

export class LaunchTierResponseDto {
  @ApiProperty({
    enum: [...LAUNCH_GRANT_TIERS, null],
    nullable: true,
  })
  tier!: LaunchGrantTier | null;

  @ApiProperty({ nullable: true, description: 'Admin who last set it.' })
  updated_by!: string | null;

  @ApiProperty({ nullable: true })
  updated_at!: string | null;
}
