import { ApiProperty } from '@nestjs/swagger';
import type { FeatureSnapshot } from '@tarmoto/shared';

/**
 * Resolved feature entitlements for the authenticated user — one boolean
 * per key in the `FEATURE_DEFINITIONS` registry. Rides along on
 * `/users/me` and the auth responses so clients can gate UI without an
 * extra call. Server-side `FeatureGuard` remains the authority.
 */
export class FeatureSnapshotDto implements FeatureSnapshot {
  // ── Free tier ──
  @ApiProperty({ description: 'Basic turn-by-turn navigation.' })
  basic_navigation!: boolean;

  @ApiProperty({
    description: 'Road quality overlay (limited zoom on the free tier).',
  })
  road_quality_overlay!: boolean;

  @ApiProperty({ description: 'Community hazard alerts.' })
  hazard_alerts!: boolean;

  // ── Pro tier (€29.99/yr) ──
  @ApiProperty({
    description:
      'Unlimited trip planning (the free tier is capped at 1 active trip).',
  })
  unlimited_trip_planning!: boolean;

  @ApiProperty({ description: 'Full-depth road quality zoom.' })
  full_road_quality_zoom!: boolean;

  @ApiProperty({ description: 'Offline map downloads.' })
  offline_maps!: boolean;

  @ApiProperty({ description: 'GPX export of recorded rides.' })
  gpx_export!: boolean;

  @ApiProperty({
    description: 'Commuter mode — saved commute routes, status, alternatives.',
  })
  commuter_mode!: boolean;

  // ── Premium tier (€49.99/yr) ──
  @ApiProperty({ description: 'Real-time group rides (unlimited).' })
  group_rides!: boolean;

  @ApiProperty({ description: 'Priority hazard alert delivery.' })
  priority_hazard_alerts!: boolean;

  @ApiProperty({ description: 'Advanced riding analytics dashboard.' })
  advanced_analytics!: boolean;
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
