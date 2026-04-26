import { ApiProperty } from '@nestjs/swagger';

export class TripSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ nullable: true })
  region!: string | null;

  @ApiProperty()
  num_days!: number;

  @ApiProperty({ enum: ['draft', 'planned', 'active', 'completed'] })
  status!: string;

  @ApiProperty()
  member_count!: number;

  @ApiProperty()
  created_at!: string;
}

export class TripMemberDto {
  @ApiProperty()
  user_id!: string;

  @ApiProperty()
  display_name!: string;

  @ApiProperty({ enum: ['owner', 'admin', 'member'] })
  role!: string;

  @ApiProperty()
  joined_at!: string;
}

export class TripWaypointDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  sequence!: number;

  @ApiProperty()
  lat!: number;

  @ApiProperty()
  lng!: number;

  @ApiProperty({ nullable: true })
  name!: string | null;

  @ApiProperty({
    enum: ['start', 'via', 'fuel', 'food', 'coffee', 'hotel', 'photo', 'end'],
  })
  waypoint_type!: string;

  @ApiProperty({ nullable: true })
  road_segment_id!: string | null;

  @ApiProperty({ nullable: true })
  notes!: string | null;

  @ApiProperty({ nullable: true })
  duration_min!: number | null;
}

export class TripDayDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  day_number!: number;

  @ApiProperty({ nullable: true })
  title!: string | null;

  @ApiProperty()
  distance_km!: number;

  @ApiProperty()
  avg_quality!: number;

  @ApiProperty()
  elevation_gain!: number;

  @ApiProperty()
  elevation_loss!: number;

  @ApiProperty()
  curviness_score!: number;

  @ApiProperty()
  scenic_score!: number;

  @ApiProperty()
  estimated_time_min!: number;

  @ApiProperty({
    type: [Object],
    description: 'Polyline points (lat/lng) of the day route.',
  })
  route_geometry!: Array<{ lat: number; lng: number }>;

  @ApiProperty({ type: [TripWaypointDto] })
  waypoints!: TripWaypointDto[];
}

export class TripDetailDto extends TripSummaryDto {
  @ApiProperty()
  daily_km_min!: number;

  @ApiProperty()
  daily_km_max!: number;

  @ApiProperty()
  min_quality!: number;

  @ApiProperty()
  road_preference!: string;

  @ApiProperty()
  invite_code!: string;

  @ApiProperty({ type: [TripMemberDto] })
  members!: TripMemberDto[];

  @ApiProperty({ type: [TripDayDto] })
  days!: TripDayDto[];
}
