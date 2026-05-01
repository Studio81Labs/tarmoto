import { ApiProperty } from '@nestjs/swagger';

export class GroupRidePathPointDto {
  @ApiProperty()
  lat!: number;

  @ApiProperty()
  lng!: number;

  @ApiProperty({
    description: 'ISO timestamp when the position was recorded.',
  })
  at!: string;
}

export class GroupRideMemberDto {
  @ApiProperty()
  user_id!: string;

  @ApiProperty()
  display_name!: string;

  @ApiProperty()
  joined_at!: string;

  @ApiProperty({
    nullable: true,
    description: 'Last known latitude broadcast by the member.',
  })
  last_lat!: number | null;

  @ApiProperty({ nullable: true })
  last_lng!: number | null;

  @ApiProperty({
    nullable: true,
    description: 'Last reported speed in km/h (metric).',
  })
  last_speed!: number | null;

  @ApiProperty({
    nullable: true,
    description: 'Heading in degrees clockwise from true north.',
  })
  last_heading!: number | null;

  @ApiProperty({
    nullable: true,
    description: 'ISO timestamp of the last broadcast position.',
  })
  last_position_at!: string | null;

  @ApiProperty({
    type: [GroupRidePathPointDto],
    description:
      'Capped recent path (oldest → newest) so reconnecting clients ' +
      'can render the trail without waiting for the next live tick.',
  })
  recent_path!: GroupRidePathPointDto[];
}

export class GroupRideDetailDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  owner_id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({
    description: 'Six-character invite code shown to other riders.',
  })
  code!: string;

  @ApiProperty()
  started_at!: string;

  @ApiProperty({ nullable: true })
  ended_at!: string | null;

  @ApiProperty({ type: [GroupRideMemberDto] })
  members!: GroupRideMemberDto[];
}
