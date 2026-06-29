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
  const raw = process.env.TARMOTO_POI_IMPORT_BBOX?.trim();
  // Default only when unset/blank. A present-but-malformed value is a
  // configuration error — silently falling back to the CZ/Beskydy default
  // would import the wrong region as that environment's data (and hides a
  // typo, against AGENTS.md's no-silent-fallback rule).
  let bbox = DEFAULT_BBOX;
  if (raw) {
    const tokens = raw.split(',');
    const parts = tokens.map(Number);
    const valid =
      tokens.length === 4 &&
      // Reject blank tokens up front — `Number('')` is 0, so `14,,17,51`
      // would otherwise coerce to a valid-looking box and import a large
      // unintended region instead of failing on the typo.
      tokens.every((t) => t.trim() !== '') &&
      parts.every((n) => Number.isFinite(n)) &&
      parts[0] < parts[2] &&
      parts[1] < parts[3];
    if (!valid) {
      throw new Error(
        `Invalid TARMOTO_POI_IMPORT_BBOX="${raw}" — expected ` +
          `"minLng,minLat,maxLng,maxLat" with minLng<maxLng and minLat<maxLat`,
      );
    }
    bbox = {
      minLng: parts[0],
      minLat: parts[1],
      maxLng: parts[2],
      maxLat: parts[3],
    };
  }

  return {
    enabled:
      (process.env.TARMOTO_POI_IMPORT_ENABLED ?? 'false')
        .trim()
        .toLowerCase() === 'true',
    bbox,
  };
});
