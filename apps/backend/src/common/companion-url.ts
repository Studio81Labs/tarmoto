import { ConfigService } from '@nestjs/config';

const DEFAULT_COMPANION_URL = 'http://localhost:3000';

/**
 * The Next.js companion's public origin — used to build links the
 * backend emits in transactional emails (verification, reset,
 * deletion-restore) and Stripe redirect URLs. Reads
 * `TARMOTO_COMPANION_URL` and strips the trailing slash so callers
 * can append `/path` without doubling up.
 *
 * Centralised so the env-var name + default + normalisation live in
 * one place; previously every service that built a companion link
 * carried its own copy and the rules were free to drift.
 */
export const getCompanionUrl = (config: ConfigService): string => {
  const raw =
    config.get<string>('TARMOTO_COMPANION_URL')?.trim() ??
    DEFAULT_COMPANION_URL;
  return raw.replace(/\/$/, '');
};
