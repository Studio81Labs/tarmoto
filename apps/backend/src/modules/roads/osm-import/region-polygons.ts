import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Country boundary polygons for the folder-model road importer.
 *
 * The importer scopes stale-by-absence tombstoning to a region's actual country
 * polygon (not its bounding rectangle): adjacent countries' rectangles overlap,
 * but each `<code>.osm` extract is a per-country Geofabrik PBF, so a rectangle
 * scope lets a later region tombstone an earlier region's roads that fall in the
 * shared strip (destroying their segment id + crowd history). Both the incoming
 * filter and the existing-row load use the SAME `ST_Intersects(geom, polygon)`
 * test, so a border row is judged identically on both sides.
 *
 * The boundaries are the SAME asset the POI store loads
 * (`assets/import-region-boundaries.geojson`, a `FeatureCollection` of 17
 * `MultiPolygon`s keyed by `properties.code`; `nest-cli.json` copies
 * `assets/*.geojson` → `dist/assets/`). Loaded lazily and cached once; each
 * region's geometry is returned as a JSON string for `ST_GeomFromGeoJSON`.
 */

interface BoundaryFeature {
  properties: { code: string };
  geometry: unknown;
}

/** code → geometry JSON string. Built once on first access. */
let cache: Map<string, string> | null = null;

function load(): Map<string, string> {
  if (cache) return cache;
  // `__dirname` is `<tree>/modules/roads/osm-import`, three levels below the tree
  // root whose `assets/` holds the geojson — the layout is identical under the
  // ts-jest `src` tree and the compiled `dist` tree, so one relative path serves
  // both (mirrors `apps/ingest/.../load-region-boundaries.ts`).
  const path = join(
    __dirname,
    '..',
    '..',
    '..',
    'assets',
    'import-region-boundaries.geojson',
  );
  const fc = JSON.parse(readFileSync(path, 'utf8')) as {
    features: BoundaryFeature[];
  };
  cache = new Map(
    fc.features.map((f) => [f.properties.code, JSON.stringify(f.geometry)]),
  );
  return cache;
}

/**
 * The region's boundary geometry as a GeoJSON string (for `ST_GeomFromGeoJSON`).
 * Throws if the code has no bundled boundary — every `DEFAULT_REGIONS` code is
 * present (the POI boundary loader asserts this), so a miss is a misconfiguration,
 * not an empty region, and must fail loudly rather than silently skip scoping.
 */
export function regionPolygon(code: string): string {
  const geometry = load().get(code);
  if (geometry === undefined) {
    throw new Error(
      `No boundary polygon bundled for region code "${code}" ` +
        `(expected in assets/import-region-boundaries.geojson)`,
    );
  }
  return geometry;
}
