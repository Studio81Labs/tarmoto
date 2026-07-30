import type { ConfigService } from '@nestjs/config';
import { MigrationInterface, QueryRunner } from 'typeorm';
import { buildTrustedManagedOriginCheck } from '../common/trusted-managed-origin.js';

/**
 * Backfill existing `hazard_reports.photo_url` values to their CANONICAL
 * managed form — `<origin>/uploads/hazard-photos/<decoded-filename>`, dropping
 * any query string / fragment and decoding percent-encoding.
 *
 * `create()` now canonicalizes managed photo URLs on write, but rows written
 * earlier could carry an equivalent-but-differently-serialized URL. Making
 * every stored reference deterministic lets the `hazard_reports_per_day`
 * cap-orphan cleanup use a targeted, server-side existence query (a filename
 * match scoped to the owner) instead of loading and parsing every one of a
 * rider's photo rows in JS — which would grow unbounded as retained history
 * accumulates.
 *
 * ONLY OUR OWN managed uploads are rewritten. The origin must pass the SAME
 * trusted-origin check the runtime uses (`TARMOTO_PUBLIC_BASE_URL`, plus
 * loopback outside production), so a third-party HTTPS photo that merely shares
 * the `/uploads/hazard-photos/` pathname — e.g. a signed CDN URL whose query
 * string carries its signature — is left untouched; stripping its query or
 * decoding its resource name could invalidate or repoint it.
 *
 * Idempotent: an already-canonical managed URL is left untouched, and rerunning
 * is a no-op. There is no meaningful `down` — the canonical form is a strict
 * normalization of our own URLs, so the original serialization is not
 * recoverable and not worth preserving.
 */

const MANAGED_PATH_PREFIX = '/uploads/hazard-photos/';

function canonicalizeManagedPhotoUrl(
  photoUrl: string,
  isTrustedOrigin: (parsed: URL) => boolean,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(photoUrl);
  } catch {
    return null;
  }
  // Gate on origin FIRST: a third-party URL is never ours to rewrite, even if
  // its pathname coincidentally starts with our managed prefix.
  if (!isTrustedOrigin(parsed)) return null;
  if (!parsed.pathname.startsWith(MANAGED_PATH_PREFIX)) return null;
  let filename: string;
  try {
    filename = decodeURIComponent(
      parsed.pathname.slice(MANAGED_PATH_PREFIX.length),
    );
  } catch {
    return null;
  }
  // Reject anything that isn't a plain filename — mirrors the resolver's
  // path-traversal guard; such rows are left as-is for a human to inspect.
  if (
    !filename ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('\0')
  ) {
    return null;
  }
  return `${parsed.origin}${MANAGED_PATH_PREFIX}${filename}`;
}

export class CanonicalizeHazardPhotoUrls1821000000000 implements MigrationInterface {
  name = 'CanonicalizeHazardPhotoUrls1821000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Reuse the runtime trusted-origin predicate (single source of truth) with
    // a thin env-backed shim in place of Nest's ConfigService.
    const isTrustedOrigin = buildTrustedManagedOriginCheck({
      get: (key: string) => process.env[key],
    } as unknown as ConfigService);

    const rows = (await queryRunner.query(
      `SELECT id, photo_url FROM hazard_reports
           WHERE photo_url LIKE '%${MANAGED_PATH_PREFIX}%'`,
    )) as Array<{ id: string; photo_url: string }>;
    for (const row of rows) {
      const canonical = canonicalizeManagedPhotoUrl(
        row.photo_url,
        isTrustedOrigin,
      );
      if (canonical && canonical !== row.photo_url) {
        await queryRunner.query(
          `UPDATE hazard_reports SET photo_url = $1 WHERE id = $2`,
          [canonical, row.id],
        );
      }
    }
  }

  public async down(): Promise<void> {
    // Normalization is not reversible; no-op.
  }
}
