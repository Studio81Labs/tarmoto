import type { ConfigService } from '@nestjs/config';
import { LOOPBACK_HOSTS } from './loopback-hosts.js';

/**
 * Decide whether a `<scheme>://<host>` origin belongs to *our* upload
 * storage for managed photos (review photos, hazard photos, …).
 *
 * Used to gate the cascade-delete + ownership guards that fire on
 * managed URLs. Without it, a third-party URL that happens to share
 * our managed pathname prefix (e.g.
 * `https://cdn.example.com/uploads/road-review-photos/...`) would be
 * misclassified as managed, and either the ownership check would 400
 * spuriously or the delete cascade would attempt a local `unlink` of
 * a coincidentally-matching filename in our managed directory.
 *
 * Treat as managed iff the origin matches `TARMOTO_PUBLIC_BASE_URL`
 * OR (outside production) the host is loopback — same trust posture
 * the upload endpoints use when they build outgoing URLs.
 *
 * Single source of truth so a future security fix lands once and
 * applies to every photo surface (`reviews.service`, `hazards.service`,
 * and any future managed-photo module).
 */
export function buildTrustedManagedOriginCheck(
  config: ConfigService,
): (parsed: URL) => boolean {
  const configured = config.get<string>('TARMOTO_PUBLIC_BASE_URL')?.trim();
  let configuredOrigin: string | null = null;
  if (configured && configured.length > 0) {
    try {
      configuredOrigin = new URL(configured).origin;
    } catch {
      // Bad config falls through; the upload endpoint's own probe
      // (`isAllowed*PhotoUrl` against the resolved base URL) will
      // surface the 500 with a clearer error than this resolver could.
    }
  }
  return (parsed: URL): boolean => {
    if (configuredOrigin && parsed.origin === configuredOrigin) return true;
    // Loopback hosts are only trusted outside production — same rule
    // the per-domain `isAllowed*PhotoUrl` enforces, so a stored prod
    // row that somehow points at localhost can't be silently deleted.
    if (
      process.env.NODE_ENV !== 'production' &&
      LOOPBACK_HOSTS.has(parsed.hostname)
    ) {
      return true;
    }
    return false;
  };
}
