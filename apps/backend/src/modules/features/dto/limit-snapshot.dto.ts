import { ApiProperty } from '@nestjs/swagger';
import type { LimitSnapshot } from '@tarmoto/shared';

/**
 * Resolved numeric entitlements for the authenticated user — one value
 * per limit key in the `FEATURE_DEFINITIONS` registry; `null` =
 * unlimited. Rides along on `/users/me` and the auth responses beside
 * `features`. Server-side checks remain the authority.
 */
export class LimitSnapshotDto implements LimitSnapshot {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Maximum open (draft/planned/active) trips the user may own. null = unlimited.',
  })
  max_active_trips!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Collaborators per trip, excluding the owner. null = unlimited.',
  })
  max_trip_collaborators!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Live group-ride size. null = unlimited.',
  })
  max_group_ride_members!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Maximum zoom level at which the road quality overlay renders. null = unlimited.',
  })
  road_quality_max_zoom!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Offline map regions a user may download. null = unlimited.',
  })
  max_offline_regions!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Anti-abuse cap on hazard reports submitted per day. null = unlimited.',
  })
  hazard_reports_per_day!: number | null;
}

// Compile-time shape guard — same contract as FeatureSnapshotDto's.
const _limitSnapshotShapeGuard: Record<
  keyof LimitSnapshot,
  true
> extends Record<keyof LimitSnapshotDto, true>
  ? true
  : never = true;
void _limitSnapshotShapeGuard;
