// Run once: node apps/backend/src/scripts/derive-region-boundaries.mjs
// Requires network access; output is committed so runtime needs no network.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const NE_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';

// Derive the target codes straight from the config so the asset can't drift from
// DEFAULT_REGIONS (a plain regex over the source avoids importing TS from .mjs).
const configSrc = readFileSync(
  join(
    here,
    '..',
    '..',
    '..',
    '..',
    'packages',
    'ingest',
    'src',
    'poi',
    'regions.ts',
  ),
  'utf8',
);
const CODES = new Set(
  [...configSrc.matchAll(/code:\s*["']([A-Z]{2})["']/g)].map((m) => m[1]),
);
if (CODES.size < 2) throw new Error('Failed to parse DEFAULT_REGIONS codes');

const iso2 = (props) =>
  props.ISO_A2 && props.ISO_A2 !== '-99' ? props.ISO_A2 : props.ISO_A2_EH;

const toMultiPolygon = (geom) =>
  geom.type === 'MultiPolygon'
    ? geom
    : { type: 'MultiPolygon', coordinates: [geom.coordinates] };

const res = await fetch(NE_URL);
if (!res.ok) throw new Error(`NE fetch failed: ${res.status}`);
const ne = await res.json();

const features = [];
const found = new Set();
for (const f of ne.features) {
  const code = iso2(f.properties);
  if (!CODES.has(code)) continue;
  found.add(code);
  features.push({
    type: 'Feature',
    properties: { code },
    geometry: toMultiPolygon(f.geometry),
  });
}

const missing = [...CODES].filter((c) => !found.has(c));
if (missing.length)
  throw new Error(`Missing NE polygons for: ${missing.join(', ')}`);

const out = { type: 'FeatureCollection', features };
const dest = join(here, '..', 'assets', 'import-region-boundaries.geojson');
writeFileSync(dest, JSON.stringify(out));
console.log(`Wrote ${features.length} region polygons to ${dest}`);
