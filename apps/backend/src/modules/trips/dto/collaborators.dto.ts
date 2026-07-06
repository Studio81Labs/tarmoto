import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Roles the owner can hand out. `owner` is never assignable — it is set
 * at trip creation and transferred nowhere (deleting the trip is the
 * only exit).
 */
export const ASSIGNABLE_TRIP_ROLES = ['editor', 'viewer'] as const;
export type AssignableTripRole = (typeof ASSIGNABLE_TRIP_ROLES)[number];

export class UpdateTripMemberRoleDto {
  @ApiProperty({
    enum: ASSIGNABLE_TRIP_ROLES,
    description:
      'New role for the member. `editor` can edit the route, propose ' +
      'suggestions, and vote; `viewer` can view the trip and comment only.',
  })
  @IsIn(ASSIGNABLE_TRIP_ROLES)
  role!: AssignableTripRole;
}

export class TripCollaboratorMemberDto {
  @ApiProperty()
  user_id!: string;

  @ApiProperty()
  display_name!: string;

  @ApiProperty({
    nullable: true,
    description:
      'Only present when the caller is the trip owner or an editor; ' +
      'viewers get `null` so the roster does not leak addresses.',
  })
  email!: string | null;

  @ApiProperty({ nullable: true })
  avatar_url!: string | null;

  @ApiProperty({ enum: ['owner', 'editor', 'viewer'] })
  role!: string;

  @ApiProperty()
  joined_at!: string;

  @ApiProperty({
    enum: ['joined'],
    description:
      'Collaborator state discriminator — members are always `joined`; ' +
      'pending email invitees appear in `invites` with state `invited`.',
  })
  state!: 'joined';
}

export class TripPendingInviteDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ enum: ASSIGNABLE_TRIP_ROLES })
  role!: string;

  @ApiProperty()
  created_at!: string;

  @ApiProperty({ enum: ['invited'] })
  state!: 'invited';
}

export class TripCollaboratorsDto {
  @ApiProperty({ type: [TripCollaboratorMemberDto] })
  members!: TripCollaboratorMemberDto[];

  @ApiProperty({
    type: [TripPendingInviteDto],
    description:
      'Pending email invites — visible to the owner and editors only; ' +
      'empty array for viewers.',
  })
  invites!: TripPendingInviteDto[];
}
