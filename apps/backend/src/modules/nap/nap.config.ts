import { registerAs } from '@nestjs/config';

/**
 * Configuration for the Czech NAP (NDIC) closure poller (#743).
 *
 * Credentials come from registration with the national registry
 * (registr.dopravniinfo.cz) for the `cz-ndic_d2-common-pull` source and
 * live only in `TARMOTO_NAP_*` env / secrets — never committed. NDIC
 * issues either HTTP Basic auth or a mutual-TLS client certificate; both
 * are supported (set whichever pair you were given).
 *
 * `pollEnabled` defaults to **false** so the poller stays dormant until
 * credentials exist — a misconfigured cron must not hammer NDIC or log
 * auth errors every few minutes on an unconfigured deployment.
 */
export interface NapConfig {
  /** Pull-snapshot URL for `cz-ndic_d2-common-pull`. */
  snapshotUrl: string;
  /** HTTP Basic credentials (use these OR the client cert, not both). */
  username: string;
  password: string;
  /** Mutual-TLS client cert + key paths (alternative to Basic auth). */
  clientCertPath: string;
  clientKeyPath: string;
  /**
   * `road_closures.source` value written for every feed row. Fixed to
   * `official` today; the reconcile pass scopes "this feed's rows" by it.
   */
  source: 'official';
  /** ISO-3166 alpha-2 stamped on imported rows (NDIC is Czech). */
  countryCode: string;
  /** Whether the scheduled poll runs. Off until credentials are set. */
  pollEnabled: boolean;
}

export const napConfig = registerAs('nap', (): NapConfig => ({
  snapshotUrl: process.env.TARMOTO_NAP_SNAPSHOT_URL ?? '',
  username: process.env.TARMOTO_NAP_USERNAME ?? '',
  password: process.env.TARMOTO_NAP_PASSWORD ?? '',
  clientCertPath: process.env.TARMOTO_NAP_CLIENT_CERT_PATH ?? '',
  clientKeyPath: process.env.TARMOTO_NAP_CLIENT_KEY_PATH ?? '',
  source: 'official',
  countryCode: process.env.TARMOTO_NAP_COUNTRY_CODE ?? 'CZ',
  pollEnabled:
    (process.env.TARMOTO_NAP_POLL_ENABLED ?? 'false').trim().toLowerCase() ===
    'true',
}));

export const NAP_CONFIG_TOKEN = napConfig.KEY;
