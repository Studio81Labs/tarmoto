import type { ConfigService } from '@nestjs/config';
import { MigrationInterface, QueryRunner } from 'typeorm';
import { buildTrustedManagedOriginCheck } from '../common/trusted-managed-origin.js';

/**
 * Add `hazard_reports.photo_filename` — the resolved managed filename of
 * `photo_url` — and backfill it for existing managed rows.
 *
 * The `hazard_reports_per_day` cap-orphan cleanup needs to answer "is this file
 * still referenced by any hazard row?" cheaply. Matching on the `photo_url`
 * text is either wrong (equivalent serializations — query strings, percent-
 * encoding — miss) or slow (a leading-wildcard `LIKE` can't use an index and
 * scans every one of a rider's retained rows). A denormalized, indexed
 * filename turns that into a targeted equality lookup that is also immune to
 * URL-serialization differences.
 *
 * `photo_url` itself is left UNTOUCHED — third-party photos (e.g. signed CDN
 * URLs) keep their exact bytes; only rows whose origin passes the SAME
 * trusted-origin check the runtime uses get a non-null `photo_filename`.
 *
 * Scans in bounded keyset batches (ordered by the indexed `id`) so a large
 * retained history never materializes every photo row in Node memory. The
 * partial index is created AFTER the backfill so it isn't maintained row by
 * row during the fill. `down` drops the column and index.
 */

const MANAGED_PATH_PREFIX = '/uploads/hazard-photos/';
const BATCH_SIZE = 500;
// `id` is a v4 UUID; this sorts before every real value for keyset paging.
const MIN_UUID = '00000000-0000-0000-0000-000000000000';

function resolveManagedFilename(
  photoUrl: string,
  isTrustedOrigin: (parsed: URL) => boolean,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(photoUrl);
  } catch {
    return null;
  }
  // Gate on origin FIRST: a third-party URL is never ours, even if its pathname
  // coincidentally starts with our managed prefix.
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
  // path-traversal guard.
  if (
    !filename ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('\0')
  ) {
    return null;
  }
  return filename;
}

export class CanonicalizeHazardPhotoUrls1821000000000 implements MigrationInterface {
  name = 'CanonicalizeHazardPhotoUrls1821000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE hazard_reports ADD COLUMN IF NOT EXISTS photo_filename text`,
    );

    // Reuse the runtime trusted-origin predicate (single source of truth) with
    // a thin env-backed shim in place of Nest's ConfigService.
    const isTrustedOrigin = buildTrustedManagedOriginCheck({
      get: (key: string) => process.env[key],
    } as unknown as ConfigService);

    let afterId = MIN_UUID;
    for (;;) {
      // Keyset page over the PK — bounded memory, index-ordered, no OFFSET
      // drift. Only rows carrying the managed path and no filename yet.
      const rows = (await queryRunner.query(
        `SELECT id, photo_url FROM hazard_reports
            WHERE id > $1
              AND photo_filename IS NULL
              AND photo_url LIKE '%${MANAGED_PATH_PREFIX}%'
            ORDER BY id ASC
            LIMIT $2`,
        [afterId, BATCH_SIZE],
      )) as Array<{ id: string; photo_url: string }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        const filename = resolveManagedFilename(row.photo_url, isTrustedOrigin);
        if (filename) {
          await queryRunner.query(
            `UPDATE hazard_reports SET photo_filename = $1 WHERE id = $2`,
            [filename, row.id],
          );
        }
      }
      afterId = rows[rows.length - 1]!.id;
      if (rows.length < BATCH_SIZE) break;
    }

    // Partial index — only rows that carry a managed photo. Backs the
    // cap-orphan reference existence check.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_hazard_reports_photo_filename
         ON hazard_reports (photo_filename)
         WHERE photo_filename IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_hazard_reports_photo_filename`,
    );
    await queryRunner.query(
      `ALTER TABLE hazard_reports DROP COLUMN IF EXISTS photo_filename`,
    );
  }
}
