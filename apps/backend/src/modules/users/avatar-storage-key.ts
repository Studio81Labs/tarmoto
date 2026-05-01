import { basename } from 'node:path';
import { hasControlCharacters } from '../../common/control-characters.js';

/**
 * All avatars live under the `avatars/` prefix in the configured
 * object storage. Keeping the prefix here (rather than at every call
 * site) means the migration that normalises stored URLs has a single
 * source of truth, and the LocalStorage public path stays in sync
 * with the historic `/uploads/avatars/...` URLs that already-shipped
 * mobile clients have cached.
 */
export const AVATAR_KEY_PREFIX = 'avatars/';

/**
 * URL path prefix for locally-stored avatars. Prior to the
 * `ObjectStorage` rollout the backend embedded an absolute
 * `${apiHost}/uploads/avatars/<file>` URL into `users.avatar_url`.
 * After the migration the value is server-relative
 * (`/uploads/avatars/<file>`) so the API host can move without
 * invalidating already-saved references; clients prefix their
 * `apiBaseUrl` when rendering.
 */
export const AVATAR_LOCAL_URL_PREFIX = '/uploads/avatars/';

/**
 * Resolve a stored `avatar_url` back to its `ObjectStorage` key, if
 * (and only if) the URL points to an avatar this backend manages.
 * Returns `null` for:
 *
 *   - empty / null URLs
 *   - URLs whose path doesn't sit under `avatars/`
 *   - filenames containing path separators, control characters, or
 *     `.` / `..` segments — these would let a malicious DB row turn
 *     a "delete previous avatar" call into an arbitrary unlink
 *
 * Both absolute (legacy `https://api.example/uploads/avatars/...`)
 * and relative (`/uploads/avatars/...`) URLs are accepted, plus
 * arbitrary CDN bases for the S3 case
 * (`https://cdn.example.com/avatars/...`). The matcher works off
 * the path's `avatars/<filename>` tail.
 */
export function avatarKeyFromUrl(avatarUrl: string | null): string | null {
  if (!avatarUrl) return null;

  let pathname: string;
  try {
    const parsed = new URL(avatarUrl, 'https://tarmoto.local');
    pathname = parsed.pathname;
  } catch {
    return null;
  }

  // Locate the LAST `avatars/` segment so a CDN URL like
  // `https://cdn.example.com/avatars/foo.png` and a legacy local URL
  // like `https://api.example/uploads/avatars/foo.png` both resolve
  // to the same key. Anchoring on `avatars/` (with leading slash)
  // ensures we don't false-positive on a path that merely contains
  // the word "avatars" elsewhere (e.g. `/old-avatars-archive/...`).
  const idx = pathname.lastIndexOf('/avatars/');
  if (idx === -1 && !pathname.startsWith('avatars/')) return null;

  const afterPrefix =
    idx === -1 ? pathname.slice('avatars/'.length) : pathname.slice(idx + 1);
  if (!afterPrefix.startsWith(AVATAR_KEY_PREFIX)) return null;

  const encodedFilename = afterPrefix.slice(AVATAR_KEY_PREFIX.length);
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

  return `${AVATAR_KEY_PREFIX}${filename}`;
}
