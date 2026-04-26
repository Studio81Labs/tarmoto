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

  @ApiProperty({
    description:
      'Total ascent (m) along the day, summed from intersected ' +
      '`road_segments.elevation_max - elevation_min` spans. Approximates ' +
      'true gain — exact per-vertex profile is not available without ' +
      'an elevation API integration.',
  })
  elevation_gain!: number;

  @ApiProperty({
    description:
      'Total descent (m) along the day. **Currently mirrors ' +
      '`elevation_gain` as an upper-bound proxy** — for a loop trip ' +
      'this is exact, for a one-way day it is an over-estimate. Will ' +
      'become independent once a per-vertex elevation profile is ' +
      'available.',
  })
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
