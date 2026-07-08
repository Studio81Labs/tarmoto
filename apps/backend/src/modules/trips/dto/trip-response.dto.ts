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
 * Masked pre-join preview for an invited (not-yet-member) rider, served by
 * `GET /trips/:tripId/invite/:code/preview`. Authorized by a live invite code,
 * NOT membership — a trip is otherwise private/collaborator-only. Carries only
 * a raw route overview (geometry + totals) plus the invite context so the
 * companion can render a "preview + accept" screen; it deliberately omits the
 * member roster, invite codes, and per-day waypoint detail so accepting the
 * invite is what actually opens the trip.
 */
export class TripInvitePreviewDto {
  @ApiProperty()
  trip_id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({
    nullable: true,
    description: 'Display name of the trip owner. `null` when unresolved.',
  })
  owner_name!: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Display name of the rider who sent this invite. `null` when unresolved.',
  })
  invited_by_name!: string | null;

  @ApiProperty({
    enum: TRIP_MEMBER_ROLES,
    description: 'The role the rider will hold after accepting.',
  })
  role!: TripMemberRole;

  @ApiProperty({ nullable: true })
  region!: string | null;

  @ApiProperty()
  num_days!: number;

  @ApiProperty({
    nullable: true,
    description: 'Total planned distance in km. `null` when unknown.',
  })
  distance_km!: number | null;

  @ApiProperty({
    type: 'array',
    items: {
      type: 'array',
      items: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2,
      },
    },
    description:
      'Simplified per-day route polylines — each an array of [lng, lat] pairs. Empty when the trip has no geometry.',
  })
  lines!: number[][][];

  @ApiProperty({
    description:
      'True when the authenticated caller is already a member — the client can skip straight to the trip instead of re-accepting.',
  })
  already_member!: boolean;
}
