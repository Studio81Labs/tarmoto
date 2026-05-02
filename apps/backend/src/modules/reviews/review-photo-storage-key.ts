import { basename } from 'node:path';
import { hasControlCharacters } from '../../common/control-characters.js';

/**
 * All review photos live under the `road-review-photos/` prefix in
 * the configured object storage. Mirrors the URL path tail emitted by
 * the upload endpoint so already-shipped mobile / companion clients
 * keep resolving stored URLs without a data backfill — the same
 * approach `avatars/` takes for the avatar surface.
 */
export const REVIEW_PHOTO_KEY_PREFIX = 'road-review-photos/';

/**
 * Resolve a stored review-photo URL back to its `ObjectStorage` key,
 * if (and only if) the URL points to a photo this backend manages.
 * Returns `null` for:
 *
 *   - empty / null / non-string URLs
 *   - URLs from a non-trusted origin (third-party CDN URLs are NEVER
 *     classified as managed even if the path tail collides — see
 *     `buildTrustedManagedOriginCheck`)
 *   - URLs whose path doesn't sit under `road-review-photos/`
 *   - filenames containing path separators, control characters, or
 *     `.` / `..` segments — these would let a crafted DB row turn a
 *     cascade-delete into an arbitrary unlink / S3 DeleteObject
 *
 * The resolver anchors on the LAST `/road-review-photos/` segment so
 * both `/uploads/road-review-photos/<file>` (LocalStorage URLs lifted
 * to absolute via the API public base URL) and
 * `/road-review-photos/<file>` (S3 / CDN URLs) collapse to the same
 * key. Same pattern as `avatarKeyFromUrl`.
 */
export function reviewPhotoKeyFromUrl(
  photoUrl: string | null | undefined,
  isTrustedOrigin: (parsed: URL) => boolean,
): string | null {
  if (!photoUrl) return null;

  let parsed: URL;
  try {
    parsed = new URL(photoUrl);
  } catch {
    return null;
  }

  if (!isTrustedOrigin(parsed)) return null;

  const idx = parsed.pathname.lastIndexOf('/road-review-photos/');
  if (idx === -1) return null;

  const encodedFilename = parsed.pathname.slice(
    idx + '/road-review-photos/'.length,
  );
  if (!encodedFilename) return null;

  let filename: string;
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    return null;
  }

  if (
    filename === '.' ||
    filename === '..' ||
    filename !== basename(filename) ||
    filename.includes('/') ||
    filename.includes('\\') ||
    hasControlCharacters(filename)
  ) {
    return null;
  }

  return `${REVIEW_PHOTO_KEY_PREFIX}${filename}`;
}

/**
 * Extract the filename portion of a managed review-photo storage key.
 * Used by the ownership check (filename must start with the caller's
 * `<segmentId>-<userId>-` prefix) so the cascade-delete can't be
 * tricked into removing another user's file.
 */
export function reviewPhotoFilenameFromKey(key: string): string {
  return key.slice(REVIEW_PHOTO_KEY_PREFIX.length);
}
