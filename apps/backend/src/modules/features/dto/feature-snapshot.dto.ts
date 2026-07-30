import { ApiProperty } from '@nestjs/swagger';
import type { FeatureSnapshot } from '@tarmoto/shared';

/**
 * Resolved feature entitlements for the authenticated user — one boolean
 * per key in the `FEATURE_DEFINITIONS` registry. Rides along on
 * `/users/me` and the auth responses so clients can gate UI without an
 * extra call. Server-side `FeatureGuard` remains the authority.
 */
export class FeatureSnapshotDto implements FeatureSnapshot {
  // ── Free tier (granted to all tiers) ──
  @ApiProperty({ description: 'Turn-by-turn navigation.' })
  basic_navigation!: boolean;

  @ApiProperty({ description: 'Ride recording and basic stats.' })
  ride_tracking!: boolean;

  @ApiProperty({
    description:
      'Quality-colored road overlay (zoom-limited on the free tier via road_quality_max_zoom).',
  })
  road_quality_overlay!: boolean;

  @ApiProperty({ description: 'Receiving community hazard alerts.' })
  hazard_alerts!: boolean;

  @ApiProperty({ description: 'Submitting one-tap hazard reports.' })
  hazard_reporting!: boolean;

  @ApiProperty({ description: 'Crash detection and emergency-contact SOS.' })
  crash_detection!: boolean;

  @ApiProperty({ description: 'Severe weather alerts along the route.' })
  weather_alerts!: boolean;

  @ApiProperty({
    description:
      'Trip planner (count-limited on the free tier via max_active_trips).',
  })
  trip_planning!: boolean;

  @ApiProperty({ description: 'Import GPX from other platforms.' })
  gpx_import!: boolean;

  @ApiProperty({ description: 'Browse published rides and collections.' })
  community_access!: boolean;

  @ApiProperty({ description: 'CarPlay / Android Auto projection.' })
  carplay_android_auto!: boolean;

  // ── Pro tier (€29.99/yr) ──
  // `road_quality_full_zoom` retired — zoom depth is enforced solely by the
  // `road_quality_max_zoom` limit (see @tarmoto/shared FEATURE_DEFINITIONS).
  @ApiProperty({ description: 'Offline map region downloads.' })
  offline_maps!: boolean;

  @ApiProperty({ description: 'GPX export of rides and planned routes.' })
  gpx_export!: boolean;

  @ApiProperty({
    description:
      'Commuter mode — saved commutes, one-tap commute nav, alternatives, weekly summary.',
  })
  commuter_mode!: boolean;

  @ApiProperty({
    description:
      'Advanced ride stats — lean angles, elevation profile, detailed per-ride stats.',
  })
  advanced_ride_stats!: boolean;

  @ApiProperty({
    description:
      'Shared trip planning (collaborator count via max_trip_collaborators).',
  })
  collaborative_trips!: boolean;

  // ── Premium tier (€49.99/yr) ──
  @ApiProperty({ description: 'Real-time group location sharing (US-26).' })
  group_rides!: boolean;

  @ApiProperty({ description: 'Priority delivery of hazard alerts.' })
  priority_hazard_alerts!: boolean;

  @ApiProperty({ description: 'Riding analytics dashboard.' })
  advanced_analytics!: boolean;

  @ApiProperty({ description: 'Personal API token for ride/route data.' })
  api_access!: boolean;

  @ApiProperty({ description: 'Direct route export to Garmin.' })
  garmin_export!: boolean;
}

// Compile-time shape guard, the other half of the `implements` clause:
// `implements` fails the build when a registry key is MISSING here, and
// this conditional fails it when a STALE field lingers after a key is
// removed from FEATURE_KEYS. Together they keep DTO ≡ registry.
const _featureSnapshotShapeGuard: Record<
  keyof FeatureSnapshot,
  true
> extends Record<keyof FeatureSnapshotDto, true>
  ? true
  : never = true;
void _featureSnapshotShapeGuard;
