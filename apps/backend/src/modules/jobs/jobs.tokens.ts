import type { JobsConfig } from './jobs.config.js';

/**
 * DI token for the resolved {@link JobsConfig}. Kept in its own file
 * so any provider that needs the config can import the token without
 * pulling the heavier `jobs.config.ts` build factory along with it.
 */
export const JOBS_CONFIG_TOKEN = 'JOBS_CONFIG';

export type { JobsConfig };
