import { ApiProperty } from '@nestjs/swagger';
import {
  ValidateBy,
  buildMessage,
  type ValidationOptions,
} from 'class-validator';
import { LOOPBACK_HOSTS } from '../../../common/loopback-hosts.js';

export const MAX_HAZARD_PHOTO_BYTES = 5 * 1024 * 1024;
export const HAZARD_PHOTO_PATH_PREFIX = '/uploads/hazard-photos/';

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

function isProductionEnv(): boolean {
  return process.env.TARMOTO_NODE_ENV === 'production';
}

/**
 * Validate a hazard photo URL against the same rule the response
 * sanitizer enforces: `https://` always wins, plain `http://` is
 * accepted only on loopback hosts (IPv4 + IPv6) AND only outside
 * production. Same posture as `isAllowedReviewPhotoUrl` — kept as a
 * sibling helper so the two surfaces evolve in lockstep without one
 * silently inheriting a relaxation the other didn't intend.
 */
export function isAllowedHazardPhotoUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.hostname.length === 0) return false;
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') {
    if (isProductionEnv()) return false;
    return LOOPBACK_HOSTS.has(parsed.hostname);
  }
  return false;
}

const IS_HAZARD_PHOTO_URL = 'isHazardPhotoUrl';

export function IsHazardPhotoUrl(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: IS_HAZARD_PHOTO_URL,
      validator: {
        validate: (value: unknown): boolean =>
          typeof value === 'string' && isAllowedHazardPhotoUrl(value.trim()),
        defaultMessage: buildMessage(
          (eachPrefix) =>
            eachPrefix +
            '$property must be an https URL (loopback http is only accepted in local development).',
          options,
        ),
      },
    },
    options,
  );
}

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
