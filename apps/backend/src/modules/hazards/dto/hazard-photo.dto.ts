import { join } from 'node:path';
import { ApiProperty } from '@nestjs/swagger';
import {
  buildManagedPhotoUrlValidator,
  isAllowedManagedPhotoUrl,
} from '../../../common/managed-photo-url.js';

export const MAX_HAZARD_PHOTO_BYTES = 5 * 1024 * 1024;
export const HAZARD_PHOTO_PATH_PREFIX = '/uploads/hazard-photos/';

// Advisory-lock key that serializes per-user access to `hazard_photo_uploads`.
// `uploadPhoto` holds it (as a `pg_advisory_xact_lock`) across its quota
// count + insert, and account deletion holds it across its pending-upload
// snapshot + purge so an in-flight upload can't insert a row the purge's
// snapshot misses. Single-sourced here so the two call sites can't drift —
// the key MUST be byte-identical for the lock to actually serialize.
export function hazardPhotoUploadLockKey(userId: string): string {
  return `hazard_photo_upload:${userId}`;
}
// On-disk directory for managed hazard photos. Shared so account deletion can
// purge a rider's files without importing HazardsService (which would create a
// module cycle).
export const HAZARD_PHOTO_UPLOAD_DIR = join(
  process.cwd(),
  'uploads',
  'hazard-photos',
);

/**
 * Maps each accepted upload mimetype to the on-disk extension. Mirrors
 * the review-photo set: only image formats every mainstream client can
 * render via plain `<img src>` so the popup / marker callout doesn't
 * need a per-format fallback path.
 */
export const ALLOWED_HAZARD_PHOTO_TYPES: ReadonlyMap<string, string> = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

/**
 * Re-exported for callers that need the same protocol check on their
 * own DB-loaded values (e.g. `sanitizeHazardPhotoUrl`). The underlying
 * rule lives in `common/managed-photo-url.ts` so review and hazard
 * photo surfaces stay in lockstep — see that module's comment for
 * the full https-vs-loopback rationale.
 */
export const isAllowedHazardPhotoUrl = isAllowedManagedPhotoUrl;

export const IsHazardPhotoUrl =
  buildManagedPhotoUrlValidator('isHazardPhotoUrl');

/**
 * Coerce a raw photo_url value from the DB into the response contract:
 * keep only URLs that pass the same rule `CreateHazardDto.photo_url`
 * enforces. Legacy rows could in principle predate the rule; both
 * response paths (`toResponse` and the `findNearby`/`findAlongRoute`
 * row mappers) must go through this so the map and the detail popup
 * can't disagree on what's renderable.
 */
export function sanitizeHazardPhotoUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const candidate = raw.trim();
  if (!candidate) return null;
  return isAllowedHazardPhotoUrl(candidate) ? candidate : null;
}

export class HazardPhotoUploadResponseDto {
  @ApiProperty({
    description:
      'URL of the photo that was just uploaded. Submit it as the ' +
      '`photo_url` field on POST /hazards to attach the photo to a hazard.',
  })
  photo_url!: string;
}
