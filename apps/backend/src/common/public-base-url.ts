import { InternalServerErrorException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type * as express from 'express';

/**
 * Shared resolver for the public origin used to build URLs that
 * round-trip through the database (review photos, avatars, signed
 * download links). Behind a reverse proxy `req.get('host')` may
 * report an internal pod hostname clients can't resolve, so
 * production hard-requires `TARMOTO_PUBLIC_BASE_URL`. Outside
 * production we fall back to the request-derived origin so dev
 * needs no env wiring.
 *
 * Single source of truth for this rule — `users` and `reviews`
 * controllers were drifting copies before this was extracted; keep
 * the env-var name, prod requirement, and trailing-slash trim
 * identical across all callers by routing through here.
 */
export function resolvePublicBaseUrl(
  req: express.Request,
  config: ConfigService,
  options: { feature: string },
): string {
  const configured = config.get<string>('TARMOTO_PUBLIC_BASE_URL')?.trim();
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd && (!configured || configured.length === 0)) {
    throw new InternalServerErrorException(
      `${options.feature} are misconfigured: TARMOTO_PUBLIC_BASE_URL ` +
        'must be set to the public https origin in production. See ' +
        'docs/process/runbook.md.',
    );
  }

  if (configured && configured.length > 0) {
    // Strip ALL trailing slashes, not just one — a paste error
    // like `https://api.example.com//` would otherwise leave a
    // single slash behind and yield `https://...//uploads/...`
    // when concatenated with a leading-slash path. Matches the
    // multi-slash trim used elsewhere in this codebase
    // (storage.config.ts, main.ts, s3-storage.ts).
    return configured.replace(/\/+$/, '');
  }
  return `${req.protocol}://${req.get('host')}`;
}
