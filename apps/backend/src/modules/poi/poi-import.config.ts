import { registerAs } from '@nestjs/config';

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
export interface PoiImportRegion {
  /** Upper-case ISO 3166-1 alpha-2 country code. */
  code: string;
  /** Authoritative clip rectangle for this region (also the tombstone bound). */
  bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number };
}

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

/**
 * The full target coverage list (#850): the launch region (CZ) plus its
 * touring neighbours and the Balkans / SE-Europe corridor. Bboxes are each
 * country's bounding rectangle — the operator clips the Geofabrik extract to
 * exactly this box (see runbook), so it doubles as the tombstone boundary.
 * Shipping all 17 as the default keeps the coverage list in the repo; a
 * deployment narrows it via `TARMOTO_POI_IMPORT_REGIONS` and enables the flag.
 */
export const DEFAULT_REGIONS: readonly PoiImportRegion[] = [
  {
    code: 'CZ',
    bbox: { minLng: 12.09, minLat: 48.55, maxLng: 18.86, maxLat: 51.06 },
  },
  {
    code: 'SK',
    bbox: { minLng: 16.83, minLat: 47.73, maxLng: 22.57, maxLat: 49.61 },
  },
  {
    code: 'PL',
    bbox: { minLng: 14.12, minLat: 49.0, maxLng: 24.15, maxLat: 54.84 },
  },
  {
    code: 'DE',
    bbox: { minLng: 5.87, minLat: 47.27, maxLng: 15.04, maxLat: 55.06 },
  },
  {
    code: 'AT',
    bbox: { minLng: 9.53, minLat: 46.37, maxLng: 17.16, maxLat: 49.02 },
  },
  {
    code: 'IT',
    bbox: { minLng: 6.63, minLat: 35.49, maxLng: 18.52, maxLat: 47.09 },
  },
  {
    code: 'SI',
    bbox: { minLng: 13.38, minLat: 45.42, maxLng: 16.61, maxLat: 46.88 },
  },
  {
    code: 'HR',
    bbox: { minLng: 13.49, minLat: 42.39, maxLng: 19.43, maxLat: 46.55 },
  },
  {
    code: 'BA',
    bbox: { minLng: 15.72, minLat: 42.56, maxLng: 19.62, maxLat: 45.28 },
  },
  {
    code: 'RS',
    bbox: { minLng: 18.82, minLat: 42.23, maxLng: 23.01, maxLat: 46.19 },
  },
  {
    code: 'ME',
    bbox: { minLng: 18.43, minLat: 41.85, maxLng: 20.36, maxLat: 43.56 },
  },
  {
    code: 'MK',
    bbox: { minLng: 20.46, minLat: 40.84, maxLng: 23.03, maxLat: 42.37 },
  },
  {
    code: 'AL',
    bbox: { minLng: 19.26, minLat: 39.62, maxLng: 21.06, maxLat: 42.66 },
  },
  {
    code: 'XK',
    bbox: { minLng: 20.01, minLat: 41.86, maxLng: 21.8, maxLat: 43.27 },
  },
  {
    code: 'BG',
    bbox: { minLng: 22.34, minLat: 41.24, maxLng: 28.61, maxLat: 44.22 },
  },
  {
    code: 'RO',
    bbox: { minLng: 20.26, minLat: 43.62, maxLng: 29.71, maxLat: 48.27 },
  },
  {
    code: 'GR',
    bbox: { minLng: 19.3, minLat: 34.8, maxLng: 29.65, maxLat: 41.75 },
  },
];

/**
 * Resolve the active region list from `TARMOTO_POI_IMPORT_REGIONS` (a
 * comma-separated list of country codes). Unset / blank → the full default
 * list. An unknown code is a configuration error (throws) rather than a
 * silent drop — a typo would otherwise quietly skip a country's import.
 */
function parseRegions(raw: string | undefined): PoiImportRegion[] {
  if (!raw || raw.trim() === '') return [...DEFAULT_REGIONS];
  const byCode = new Map(DEFAULT_REGIONS.map((r) => [r.code, r]));
  const codes = raw
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c !== '');
  if (codes.length === 0) return [...DEFAULT_REGIONS];
  const selected: PoiImportRegion[] = [];
  const seen = new Set<string>();
  for (const code of codes) {
    const region = byCode.get(code);
    if (!region) {
      throw new Error(
        `Invalid TARMOTO_POI_IMPORT_REGIONS: unknown region "${code}". ` +
          `Known regions: ${DEFAULT_REGIONS.map((r) => r.code).join(', ')}`,
      );
    }
    if (!seen.has(code)) {
      seen.add(code);
      selected.push(region);
    }
  }
  return selected;
}

export const poiImportConfig = registerAs('poiImport', (): PoiImportConfig => {
  const extractDir = process.env.TARMOTO_POI_IMPORT_DIR?.trim();
  return {
    enabled:
      (process.env.TARMOTO_POI_IMPORT_ENABLED ?? 'false')
        .trim()
        .toLowerCase() === 'true',
    extractDir: extractDir ? extractDir : null,
    regions: parseRegions(process.env.TARMOTO_POI_IMPORT_REGIONS),
  };
});
