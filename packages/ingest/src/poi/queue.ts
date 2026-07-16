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

/**
 * Child-job payload for a single region's offline POI import (#850) — the
 * `import-region` job's wire shape. Shared by every producer (the backend
 * admin front-door's manual trigger, apps/ingest's own weekly-dispatch
 * fan-out) and apps/ingest's `PoiImportProcessor` (the sole consumer since
 * Task 5 moved the worker out of the backend) — kept in the pure lib so no
 * one app privately owns this cross-app contract.
 */
export interface PoiImportRegionJobData {
  /** Upper-case ISO 3166-1 alpha-2 code of the region to import. */
  code: string;
  /**
   * Bulk source to import this region from (`osm` / `fsq`, #869) — routes the
   * job back to the matching importer. Optional on the wire so a region job
   * enqueued before this field existed still runs (the worker defaults it to
   * `osm`, the only source at the time).
   */
  source?: string;
  /**
   * Who enqueued this region job (#847). `manual` = an admin trigger via the
   * POI admin UI; `cron`/absent = the weekly dispatcher. Recorded in
   * poi_import_runs so history distinguishes the two.
   */
  trigger?: "manual" | "cron";
}
