/**
 * Wire shapes for the POI-import admin surface (#847), shared between
 * apps/ingest's internal API (which computes them) and the backend admin
 * proxy + its Swagger DTOs (which re-serve them). Pure interfaces, no deps —
 * safe for this Nest-free package. Moved here from the backend
 * `poi-import-admin.service.ts` in Phase 3 so both apps name one type.
 */

/** One `poi_import_runs` row, serialized for the admin API (#847). */
export interface RunSummary {
  id: string;
  source: string;
  region_code: string;
  status: string;
  trigger: string;
  fetched: number | null;
  upserted: number | null;
  tombstoned: number | null;
  skip_reason: string | null;
  /** Set when a `success` run withheld part of its normal work (e.g. the
   *  tombstone wipe-guard's partial-accept path) — null on every clean
   *  success, both skip reasons, and any `running`/`failed` row. */
  warning: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/**
 * Per-`(source, region)` admin status row (#847) — everything the POI
 * Imports admin page needs to render one row of the coverage table without a
 * second round-trip.
 */
export interface RegionImportStatus {
  source: string;
  code: string;
  /** True when this source is enabled AND `code` is in that source's
   *  configured `regions` list (Phase 3 enablement view). A disabled or
   *  unconfigured pair is `false` — the admin hides it and the manual trigger
   *  400s it. */
  configured: boolean;
  /** Coverage stamp — OSM-only. `poi_import_regions` has no `source` column
   *  and is only stamped by the OSM import path, so a non-OSM row always
   *  reports `null` here rather than reusing OSM's stamp for the same code. */
  imported_at: string | null;
  poi_count: number;
  extract: {
    present: boolean;
    size_bytes: number;
    modified_at: string;
  } | null;
  last_run: RunSummary | null;
  live_state: "idle" | "queued" | "running";
}

/**
 * Response body of the manual import trigger (`POST /internal/poi/import` and
 * the backend `POST /admin/poi/regions/:source/:code/import`) — the enqueued
 * BullMQ job id.
 */
export interface TriggerImportResponse {
  job_id: string;
}

/**
 * Response body of `GET /internal/poi/import-status` (#1011 review, FIX 2) —
 * a cheap "is an import currently running/queued for this (source, code)"
 * check. Restores, across the app boundary, the upload-vs-import guard that
 * `PoiImportAdminService.storeExtract` lost when Phase 3 moved the
 * `poi.import` queue entirely into apps/ingest: the backend's `storeExtract`
 * calls this (best-effort) before writing a replacement extract, so it
 * doesn't race a worker that's still reading the CURRENT one.
 */
export interface ImportStatusResponse {
  in_flight: boolean;
}
