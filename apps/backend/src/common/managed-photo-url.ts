import {
  ValidateBy,
  buildMessage,
  type ValidationOptions,
} from 'class-validator';
import { basename, join } from 'node:path';
import { hasControlCharacters } from './control-characters.js';
import { LOOPBACK_HOSTS } from './loopback-hosts.js';

/**
 * Mirror the runtime check the bootstrapper uses
 * (`apps/backend/src/main.ts`) so the loopback-http allowance below
 * stays in lockstep with the env that determines whether helmet's
 * full CSP is on, etc.
 */
function isProductionEnv(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Validate a managed-photo URL against the same rule the response
 * sanitizers enforce: `https://` always wins. Plain `http://` is
 * accepted only on loopback hosts (IPv4 + IPv6) AND only outside
 * production — local dev's `req.protocol`-derived URLs need to
 * round-trip through the create / update DTOs, but a production
 * client must never persist a non-https URL. A stored
 * `http://localhost/...` would render as `<img src="http://localhost/...">`
 * in every viewer's browser, hitting each viewer's own machine
 * (broken images at best, SSRF-by-rendering at worst).
 *
 * Single source of truth across every managed-photo surface (review
 * photos, hazard photos, future modules). Same divergence-risk
 * rationale as `buildTrustedManagedOriginCheck` — a future fix to
 * the protocol policy lands once and applies everywhere.
 */
export function isAllowedManagedPhotoUrl(value: string): boolean {
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

/**
 * Decoded basename + resolved absolute path of a managed-photo file
 * on local disk. Returned by `resolveManagedPhoto` so callers don't
 * have to repeat the slice-and-decode dance to figure out where the
 * file lives.
 */
export interface ManagedPhoto {
  filename: string;
  filePath: string;
}

/**
 * Resolve a photo URL to its managed filename + on-disk path inside
 * the given upload directory, or `null` when the URL is not one we
 * own. Single source of truth for the path-traversal guard across
 * every managed-photo surface (review photos, hazard photos, future
 * modules).
 *
 * Only honors the URL when the origin is trusted (per
 * `buildTrustedManagedOriginCheck`) AND the pathname carries the
 * caller's managed prefix, and rejects decoded filenames that
 * include path separators, control characters, or `.`/`..` segments
 * so a crafted entry can't make a cascade delete escape the managed
 * directory.
 *
 * Same divergence-risk rationale as the trusted-origin extraction —
 * a future fix to the path-traversal policy lands once and applies
 * everywhere.
 */
export function resolveManagedPhoto(
  photoUrl: string | null | undefined,
  options: {
    pathPrefix: string;
    uploadDir: string;
    isTrustedOrigin: (parsed: URL) => boolean;
  },
): ManagedPhoto | null {
  if (!photoUrl) return null;

  let parsed: URL;
  try {
    parsed = new URL(photoUrl);
  } catch {
    // Treat relative URLs as untrusted: we never emit relative photo
    // URLs from any upload endpoint, so anything without a scheme is
    // either a legacy or third-party value that can't be cleaned up
    // by the cascade.
    return null;
  }

  if (!options.isTrustedOrigin(parsed)) return null;
  if (!parsed.pathname.startsWith(options.pathPrefix)) return null;

  const encodedFilename = parsed.pathname.slice(options.pathPrefix.length);
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

  return { filename, filePath: join(options.uploadDir, filename) };
}

/**
 * class-validator decorator factory for a single managed-photo URL
 * field. The validator name is caller-supplied so each surface keeps
 * its own metadata key (`isReviewPhotoUrl`, `isHazardPhotoUrl`) —
 * needed by class-validator's per-property error map and by
 * downstream consumers that introspect the validator name. The
 * underlying check is shared, so the protocol policy stays
 * single-sourced even though the decorators themselves are distinct.
 */
export function buildManagedPhotoUrlValidator(
  name: string,
): (options?: ValidationOptions) => PropertyDecorator {
  return (options?: ValidationOptions) =>
    ValidateBy(
      {
        name,
        validator: {
          validate: (value: unknown): boolean =>
            typeof value === 'string' && isAllowedManagedPhotoUrl(value.trim()),
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
