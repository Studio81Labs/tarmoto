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
}

// Compile-time shape guard — same contract as FeatureSnapshotDto's.
const _limitSnapshotShapeGuard: Record<
  keyof LimitSnapshot,
  true
> extends Record<keyof LimitSnapshotDto, true>
  ? true
  : never = true;
void _limitSnapshotShapeGuard;
