import { ApiProperty } from '@nestjs/swagger';
import { LatLngResponseDto } from '../../../common/lat-lng.dto.js';
import {
  ROUTE_PREFERENCES,
  type RoutePreferenceOption,
} from '../../routing/dto/route.dto.js';

export const TRIP_STATUSES = [
  'draft',
  'planned',
  'active',
  'completed',
] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

export const TRIP_ROAD_PREFERENCES = [
  'curvy',
  'scenic',
  'fast',
  'mixed',
] as const;
export type TripRoadPreference = (typeof TRIP_ROAD_PREFERENCES)[number];

export const TRIP_MEMBER_ROLES = ['owner', 'editor', 'viewer'] as const;
export type TripMemberRole = (typeof TRIP_MEMBER_ROLES)[number];

export const TRIP_WAYPOINT_TYPES = [
  'start',
  'via',
  'fuel',
  'food',
  'coffee',
  'hotel',
  'photo',
  'end',
] as const;
export type TripWaypointType = (typeof TRIP_WAYPOINT_TYPES)[number];

export class TripSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    description:
      'US-37 — owner uuid surfaced on the summary so the companion can decide whether to carry the source folder forward when duplicating (folders are private per-user; only the owner of the source can preserve filing without 404-ing the create).',
  })
  owner_id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ nullable: true })
  region!: string | null;

  @ApiProperty()
  num_days!: number;

  @ApiProperty({ enum: TRIP_STATUSES })
  status!: TripStatus;

  @ApiProperty()
  member_count!: number;

  @ApiProperty({
    nullable: true,
    description:
      'US-37 — uuid of the rider-owned folder this trip is filed under. `null` for unfiled trips.',
  })
  folder_id!: string | null;

  @ApiProperty()
  created_at!: string;

  @ApiProperty({
    nullable: true,
    description:
      'Total planned distance (km) = SUM of the trip days’ `distance_km`. ' +
      '`null` when no day has a recorded distance.',
  })
  distance_km!: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Distance-weighted average road quality (0–5) across the trip days. ' +
      '`null` when no day has a recorded quality.',
  })
  quality_avg!: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Count of mountain passes within 2 km of any of the trip’s day ' +
      'geometries. `0` when the trip has days but no nearby passes (or no day ' +
      'geometry); `null` only when the trip has no trip-days at all.',
  })
  passes_count!: number | null;
}

export class TripMemberDto {
  @ApiProperty()
  user_id!: string;

  @ApiProperty()
  display_name!: string;

  @ApiProperty({ enum: TRIP_MEMBER_ROLES })
  role!: TripMemberRole;

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

  @ApiProperty({ enum: TRIP_WAYPOINT_TYPES })
  waypoint_type!: TripWaypointType;

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

  @ApiProperty()
  start_linked!: boolean;

  @ApiProperty({
    required: false,
    nullable: true,
    enum: ROUTE_PREFERENCES,
    isArray: true,
    description:
      'Per-leg road-character overrides as saved (revision 3 §C): one ' +
      'routing preference per consecutive routing-waypoint pair, travel ' +
      'order. Null when every leg inherits the trip-wide preference.',
  })
  leg_preferences?: RoutePreferenceOption[] | null;

  @ApiProperty({
    type: [LatLngResponseDto],
    description: 'Polyline points (lat/lng) of the day route.',
  })
  route_geometry!: LatLngResponseDto[];

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

  @ApiProperty({ enum: TRIP_ROAD_PREFERENCES })
  road_preference!: TripRoadPreference;

  @ApiProperty({ type: [TripMemberDto] })
  members!: TripMemberDto[];

  @ApiProperty({ type: [TripDayDto] })
  days!: TripDayDto[];
}

/**
 * Read-only trip detail served to a NON-member through the community surface
 * (`GET /community/trips/:id`), used when a trip is exposed via a discoverable
 * (public/unlisted) collection. Deliberately a STANDALONE class (not a subclass
 * of {@link TripSummaryDto}/{@link TripDetailDto}) so sensitive owner-only
 * fields can never leak by inheritance — only the fields listed here are ever
 * sent. Notably excluded:
 *  - personal invite codes — join secrets; exposing them would let any viewer silently
 *    become a trip member.
 *  - the `members[]` roster — non-members get the aggregate `member_count` and
 *    (when permitted) the owner's name only, not rider identities.
 *  - `folder_id` — the owner's private filing folder.
 *
 * Owner identity (`owner_id` / `owner_name`) is masked to `null` for a viewer
 * who is not a trip member when the owner has `profile_visibility = 'private'`,
 * mirroring how the collection API hides the owner (#279 / #501) — otherwise the
 * discover→trip link would recover a deliberately-hidden rider identity.
 */
export class PublicTripDetailDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    nullable: true,
    description:
      'UUID of the trip owner. `null` when the owner keeps a private profile ' +
      'and the viewer is not a trip member (masked so the id can’t be ' +
      'cross-referenced to recover their identity).',
  })
  owner_id!: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Display name of the trip owner. `null` when masked for a private-profile ' +
      "owner, or when the owner's account is soft-deleted / unresolved.",
  })
  owner_name!: string | null;

  @ApiProperty()
  title!: string;

  @ApiProperty({ nullable: true })
  region!: string | null;

  @ApiProperty()
  num_days!: number;

  @ApiProperty({ enum: TRIP_STATUSES })
  status!: TripStatus;

  @ApiProperty()
  member_count!: number;

  @ApiProperty()
  created_at!: string;

  @ApiProperty({ nullable: true })
  distance_km!: number | null;

  @ApiProperty({ nullable: true })
  quality_avg!: number | null;

  @ApiProperty({ nullable: true })
  passes_count!: number | null;

  @ApiProperty()
  daily_km_min!: number;

  @ApiProperty()
  daily_km_max!: number;

  @ApiProperty()
  min_quality!: number;

  @ApiProperty({ enum: TRIP_ROAD_PREFERENCES })
  road_preference!: TripRoadPreference;

  @ApiProperty({ type: [TripDayDto] })
  days!: TripDayDto[];
}
