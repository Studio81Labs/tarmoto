import { registerAs } from "@nestjs/config";
import { parseRegions, type PoiImportRegion } from "@tarmoto/ingest";

/**
 * Config for the offline POI import (#745, continent-scaled in #850).
 *
 * The import mirrors OSM POIs into the `pois` table for offline use. It runs
 * from **per-country Geofabrik `.osm` extracts** (produced by the operator with
 * `osmium tags-filter` — see the runbook), not a live Overpass bbox, so it can
 * cover 15+ countries without hitting the Overpass public-API limits. Overpass
 * stays the live read-path fallback (poi.service), not the bulk importer.
 *
 * `enabled` defaults to **false** so the weekly job is dormant until a
 * deployment opts in (running a continent-scale import in dev / CI is
 * undesirable, and the live read paths work without it).
 *
 * `regions` is the coverage list. Each region carries its **authoritative
 * bbox** — the rectangle the operator clipped the extract to (`osmium extract
 * -b`). That bbox bounds **stale-by-absence tombstoning**: a re-import may
 * tombstone rows *inside* the region's bbox that are absent from the extract
 * (closed venues drop out), but never touches rows outside it. The bbox MUST
 * match the extract's clip, or in-bbox rows the extract didn't cover would be
 * wrongly tombstoned.
 */
export interface PoiImportConfig {
  enabled: boolean;
  /**
   * Directory holding the per-region extracts, named `<code>.osm`
   * (lower-case), e.g. `<extractDir>/cz.osm`. Null when unset — the service
   * throws when enabled without it (mirrors the roads importer's file check).
   */
  extractDir: string | null;
  /** Active regions (a subset of {@link DEFAULT_REGIONS}). */
  regions: PoiImportRegion[];
}

function boolEnv(value: string | undefined): boolean {
  return (value ?? "false").trim().toLowerCase() === "true";
}

export const osmPoiImportConfig = registerAs(
  "osmPoiImport",
  (): PoiImportConfig => {
    const extractDir = process.env.TARMOTO_OSM_POI_IMPORT_DIR?.trim();
    return {
      enabled: boolEnv(process.env.TARMOTO_OSM_POI_IMPORT_ENABLED),
      extractDir: extractDir ? extractDir : null,
      regions: parseRegions(
        process.env.TARMOTO_OSM_POI_IMPORT_REGIONS,
        "TARMOTO_OSM_POI_IMPORT_REGIONS",
      ),
    };
  },
);

/**
 * Config for the Foursquare OS Places bulk import (#869) — the second bulk
 * source alongside OSM, same shape + region model. The operator's offline
 * DuckDB recipe writes per-region `<code>.fsq.jsonl` extracts into
 * `TARMOTO_FSQ_POI_IMPORT_DIR` (see the runbook). Enabled defaults to **false**;
 * the coverage list defaults to the same {@link DEFAULT_REGIONS}, narrowed via
 * `TARMOTO_FSQ_POI_IMPORT_REGIONS` (CZ-first at launch).
 */
export const fsqPoiImportConfig = registerAs(
  "fsqPoiImport",
  (): PoiImportConfig => {
    const extractDir = process.env.TARMOTO_FSQ_POI_IMPORT_DIR?.trim();
    return {
      enabled: boolEnv(process.env.TARMOTO_FSQ_POI_IMPORT_ENABLED),
      extractDir: extractDir ? extractDir : null,
      regions: parseRegions(
        process.env.TARMOTO_FSQ_POI_IMPORT_REGIONS,
        "TARMOTO_FSQ_POI_IMPORT_REGIONS",
      ),
    };
  },
);
