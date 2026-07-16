/**
 * The `poi.import` queue contract, owned end-to-end by apps/ingest — since
 * Phase 3 it is the sole producer AND consumer. The backend enqueues nothing
 * directly: it triggers imports over apps/ingest's HTTP internal API, which
 * performs the actual enqueue. Kept here in the framework-free lib so the
 * strings stay a shared constant rather than being buried in the Nest app.
 * `as const` preserves literal types so apps/ingest's `QUEUE_NAMES` /
 * `JOB_NAMES` objects stay literally typed.
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
 * `import-region` job's wire shape. Produced within apps/ingest by both the
 * internal-API trigger handler (invoked over HTTP by the backend admin
 * front-door) and the weekly-dispatch fan-out, and consumed by its
 * `PoiImportProcessor`. Kept in the framework-free lib so the wire shape
 * stays a shared constant.
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
