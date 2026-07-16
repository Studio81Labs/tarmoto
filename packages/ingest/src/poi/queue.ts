/**
 * The `poi.import` queue contract shared by BOTH apps: the backend enqueues into
 * it (producer) and apps/ingest processes it (worker/scheduler). Kept here in the
 * pure lib so neither app owns the strings. `as const` preserves literal types so
 * the backend's `QUEUE_NAMES` / `JOB_NAMES` objects stay literally typed.
 */
export const POI_IMPORT_QUEUE = "poi.import" as const;
export const POI_IMPORT_JOB = {
  /** Weekly dispatcher: fans out one import-region job per configured region. */
  DISPATCH: "dispatch",
  /** Per-region child job (staggered): imports one country's extract. */
  REGION: "import-region",
} as const;
/** Weekly Sunday 03:00 — offline POI import dispatcher. */
export const POI_IMPORT_WEEKLY_CRON = "0 3 * * 0" as const;
