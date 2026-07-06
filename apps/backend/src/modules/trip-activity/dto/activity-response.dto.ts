import { ApiProperty } from '@nestjs/swagger';

export const TRIP_ACTIVITY_ACTIONS = [
  'member_joined',
  'member_left',
  'member_invited',
  'trip_updated',
  'trip_generated',
  'suggestion_created',
  'suggestion_deleted',
  'suggestion_voted',
  'suggestion_vote_removed',
  'suggestion_accepted',
  'suggestion_rejected',
  'suggestion_reopened',
  'member_removed',
  'member_role_changed',
] as const;

export class TripActivityEntryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  trip_id!: string;

  @ApiProperty({ nullable: true })
  actor_id!: string | null;

  @ApiProperty({ nullable: true })
  actor_name!: string | null;

  @ApiProperty({ enum: TRIP_ACTIVITY_ACTIONS })
  action!: (typeof TRIP_ACTIVITY_ACTIONS)[number];

  @ApiProperty({
    type: Object,
    description:
      'Action-specific structured payload. Shape depends on `action`.',
  })
  payload!: Record<string, unknown>;

  @ApiProperty()
  created_at!: string;
}

export class TripActivityListResponseDto {
  @ApiProperty({ type: [TripActivityEntryDto] })
  activity!: TripActivityEntryDto[];
}
