import { DEFAULT_REGIONS, type PoiImportRegion } from './poi-import.config.js';

/**
 * Config for the automated OSM extract refresh (#976) — the "fetch" half of the
 * offline POI pipeline. A scheduled osmium+node container (see
 * `apps/backend/Dockerfile.poi-refresh`) downloads the per-country Geofabrik
 * PBF, filters it to the POI tag set, clips it to each region's bbox, and writes
 * fresh `<code>.osm` files to the shared import volume BEFORE the weekly import
 * cron (Sunday 03:00 UTC) reads them — so the store mirrors CURRENT data instead
 * of re-importing a static file.
 *
 * Region set + target dir are shared with the importer (same
 * `TARMOTO_POI_IMPORT_REGIONS` / `TARMOTO_POI_IMPORT_DIR`), and bboxes come
 * straight from `DEFAULT_REGIONS`, so the clip box can never drift from the one
 * the importer's stale-by-absence tombstoning is bounded by (#850).
 *
 * FSQ is intentionally NOT covered here: OS Places is a token-gated
 * DuckDB/Iceberg pull with a wholly different shape (see the runbook), tracked
 * as its own follow-up.
 */

/** Geofabrik hosts all 17 coverage countries under its `europe/` tree. */
export const GEOFABRIK_BASE_URL = 'https://download.geofabrik.de/europe';

/**
 * `DEFAULT_REGIONS` code → Geofabrik country slug. Geofabrik-specific naming
 * (e.g. `bosnia-herzegovina`, `macedonia`, `kosovo`), so it lives here rather
 * than on the importer's region config. A wrong slug surfaces as a clear 404 on
 * download. Every `DEFAULT_REGIONS` code must appear here — enforced by
 * `poi-refresh.config.spec`.
 */
export const GEOFABRIK_SLUGS: Readonly<Record<string, string>> = {
  CZ: 'czech-republic',
  SK: 'slovakia',
  PL: 'poland',
  DE: 'germany',
  AT: 'austria',
  IT: 'italy',
  SI: 'slovenia',
  HR: 'croatia',
  BA: 'bosnia-herzegovina',
  RS: 'serbia',
  ME: 'montenegro',
  MK: 'macedonia',
  AL: 'albania',
  XK: 'kosovo',
  BG: 'bulgaria',
  RO: 'romania',
  GR: 'greece',
};

/**
 * `osmium tags-filter` expressions — the §7 POI tag set (fuel, food incl.
 * `fast_food` + ice cream, accommodation, viewpoints, rest areas). MUST stay a
 * superset of what the importer's OSM parser recognizes, or a refreshed extract
 * would silently drop POIs the importer would otherwise keep — kept verbatim in
 * lockstep with the runbook's worked example. `nwr/` = nodes, ways AND relations
 * (hotels / campsites / rest areas are often mapped as areas, not just points).
 */
export const POI_TAGS_FILTER_EXPRESSIONS: readonly string[] = [
  'nwr/amenity=fuel,restaurant,cafe,fast_food,ice_cream',
  'nwr/tourism=hotel,guest_house,motel,hostel,chalet,apartment,camp_site,viewpoint',
  'nwr/highway=rest_area,services',
  'nwr/shop=ice_cream',
];

/** Geofabrik download URL for a region's country PBF (null if no slug). */
export function geofabrikUrl(code: string): string | null {
  const slug = GEOFABRIK_SLUGS[code];
  return slug ? `${GEOFABRIK_BASE_URL}/${slug}-latest.osm.pbf` : null;
}

/** `osmium extract -b` bbox arg: `minLng,minLat,maxLng,maxLat`. */
export function bboxArg(bbox: PoiImportRegion['bbox']): string {
  return `${bbox.minLng},${bbox.minLat},${bbox.maxLng},${bbox.maxLat}`;
}

function boolEnv(value: string | undefined): boolean {
  return (value ?? 'false').trim().toLowerCase() === 'true';
}

export interface PoiRefreshConfig {
  /** Gate — off unless `TARMOTO_POI_REFRESH_ENABLED=true`. */
  enabled: boolean;
  /**
   * Directory the fresh `<code>.osm` files are written to — the SAME
   * `TARMOTO_POI_IMPORT_DIR` the importer reads. `null` when unset (the script
   * fails fast: there's nowhere to write).
   */
  targetDir: string | null;
  /**
   * Regions to refresh: `DEFAULT_REGIONS` narrowed by
   * `TARMOTO_POI_IMPORT_REGIONS` (default all). Shares the importer's region env
   * so the refresh and the import always target the same set; an unknown code
   * fails fast (like the importer's `parseRegions`) rather than being silently
   * dropped.
   */
  regions: readonly PoiImportRegion[];
}

/**
 * Resolve the refresh config from the environment — standalone (no Nest DI), so
 * the refresh container needn't boot the app.
 */
export function resolvePoiRefreshConfig(
  env: NodeJS.ProcessEnv = process.env,
): PoiRefreshConfig {
  const known = new Set(DEFAULT_REGIONS.map((r) => r.code));
  const requested = env.TARMOTO_POI_IMPORT_REGIONS?.trim();
  const codes = requested
    ? requested
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean)
    : [];
  // Fail fast on a typo/unsupported code, matching the importer's `parseRegions`
  // (#976 review): silently dropping it would let the scheduled task exit green
  // having refreshed nothing, while the import keeps reusing stale files.
  for (const code of codes) {
    if (!known.has(code)) {
      throw new Error(
        `Invalid TARMOTO_POI_IMPORT_REGIONS: unknown region "${code}". ` +
          `Known regions: ${DEFAULT_REGIONS.map((r) => r.code).join(', ')}`,
      );
    }
  }
  const wanted = codes.length > 0 ? new Set(codes) : null; // null = all
  const regions = DEFAULT_REGIONS.filter(
    (r) => wanted === null || wanted.has(r.code),
  );
  const dir = env.TARMOTO_POI_IMPORT_DIR?.trim();
  return {
    enabled: boolEnv(env.TARMOTO_POI_REFRESH_ENABLED),
    targetDir: dir ? dir : null,
    regions,
  };
}
