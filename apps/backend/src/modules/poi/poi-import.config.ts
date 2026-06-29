import { registerAs } from '@nestjs/config';

/**
 * Config for the offline POI import (#745).
 *
 * `enabled` defaults to **false** so the scheduled import is dormant until
 * a deployment opts in — running a weekly full-area Overpass fetch in dev
 * / CI is undesirable, and the live read paths still work without it.
 *
 * `bbox` bounds the import to a region (default: the CZ / Beskydy launch
 * box). Format `minLng,minLat,maxLng,maxLat`; an invalid value falls back
 * to the default rather than importing the whole planet.
 */
export interface PoiImportConfig {
  enabled: boolean;
  bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number };
}

const DEFAULT_BBOX = {
  minLng: 18.0,
  minLat: 49.3,
  maxLng: 18.9,
  maxLat: 49.75,
};

export const poiImportConfig = registerAs('poiImport', (): PoiImportConfig => {
  const raw = process.env.TARMOTO_POI_IMPORT_BBOX ?? '';
  const parts = raw.split(',').map(Number);
  const valid =
    parts.length === 4 &&
    parts.every((n) => Number.isFinite(n)) &&
    parts[0] < parts[2] &&
    parts[1] < parts[3];
  const bbox = valid
    ? { minLng: parts[0], minLat: parts[1], maxLng: parts[2], maxLat: parts[3] }
    : DEFAULT_BBOX;

  return {
    enabled:
      (process.env.TARMOTO_POI_IMPORT_ENABLED ?? 'false')
        .trim()
        .toLowerCase() === 'true',
    bbox,
  };
});
