/**
 * Pure, deterministic builders for demo geometry and roads. Kept free of
 * DB access so they can be unit tested, and seeded by a small PRNG so a
 * re-run produces byte-identical data (stable diffs, reproducible demos).
 */
import { ROAD_QUALITY, haversineKm } from '@tarmoto/shared';

/** Prefix on `road_segments.road_number` that marks a row as demo data. */
export const DEMO_ROAD_MARKER = 'DEMO';

/**
 * SQL `LIKE` pattern matching exactly the demo road pool — roads are
 * numbered `DEMO-0001`, `DEMO-0002`, … so the trailing hyphen keeps
 * cleanup from touching an unrelated road whose number merely begins with
 * the string `DEMO` (e.g. an imported `DEMOLITION RD`).
 */
export const DEMO_ROAD_LIKE = `${DEMO_ROAD_MARKER}-%`;

/** A LineString whose coordinates are concrete `[lng, lat]` pairs. */
export interface LineString {
  type: 'LineString';
  coordinates: [number, number][];
}

export interface DemoRoadSpec {
  road_number: string;
  road_name: string;
  geom: LineString;
  length_m: number;
  curviness_score: number;
  quality_score: number;
  surface_type: string;
  reading_count: number;
  confidence: number;
}

/**
 * Mulberry32 — a tiny, fast, well-distributed 32-bit PRNG. Seeded so the
 * same `seed` always yields the same stream; returns floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic 32-bit hash (FNV-1a) — turns a persona email into a seed. */
export function seedFromString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Build a wandering LineString of `points` vertices starting at `start`.
 * Each step nudges lat/lng by up to ~±0.015° (~1.5 km), so a route stays
 * a plausible local ride rather than a straight line across the country.
 */
export function buildLineString(
  rng: () => number,
  start: { lat: number; lng: number },
  points: number,
): LineString {
  if (points < 2) {
    throw new Error('buildLineString requires at least two points.');
  }
  const coordinates: [number, number][] = [];
  let { lat, lng } = start;
  coordinates.push([round6(lng), round6(lat)]);
  for (let i = 1; i < points; i++) {
    lat += (rng() - 0.5) * 0.03;
    lng += (rng() - 0.5) * 0.03;
    coordinates.push([round6(lng), round6(lat)]);
  }
  return { type: 'LineString', coordinates };
}

const DEMO_SURFACES = ['asphalt', 'asphalt', 'asphalt', 'concrete', 'gravel'];

/**
 * Build `count` demo road segments spread across the Czech/Moravian region.
 * Deterministic: the same `count` always produces the same roads, so the
 * seeder can cleanly delete-and-recreate them.
 */
export function buildDemoRoadSpecs(count: number): DemoRoadSpec[] {
  // Fixed seed (not derived from `count`) so the first N roads are the same
  // regardless of how many are requested.
  const rng = mulberry32(0x1234abcd);
  const roads: DemoRoadSpec[] = [];
  for (let i = 0; i < count; i++) {
    const base = {
      lat: 49.4 + (rng() - 0.5) * 1.2,
      lng: 16.8 + (rng() - 0.5) * 2.4,
    };
    const geom = buildLineString(rng, base, 4 + Math.floor(rng() * 5));
    roads.push({
      road_number: `${DEMO_ROAD_MARKER}-${String(i + 1).padStart(4, '0')}`,
      road_name: `Demo Road ${i + 1}`,
      geom,
      length_m: Math.round(lineLengthKm(geom) * 1000),
      // Canonical curviness scale is 0–5 (fun-zone clustering gates on
      // `>= 3.0` and normalises via `/ 5.0`); seed across the full range so
      // demo rides show a real surface/curviness spread, not all "straight".
      curviness_score: round2(rng() * 5),
      quality_score: round2(
        ROAD_QUALITY.VERY_POOR +
          rng() * (ROAD_QUALITY.EXCELLENT - ROAD_QUALITY.VERY_POOR),
      ),
      surface_type:
        DEMO_SURFACES[Math.floor(rng() * DEMO_SURFACES.length)] ?? 'asphalt',
      reading_count: 5 + Math.floor(rng() * 200),
      confidence: 1 + Math.floor(rng() * 100),
    });
  }
  return roads;
}

/** Total length (km) of a LineString via summed haversine of its legs. */
export function lineLengthKm(line: LineString): number {
  let km = 0;
  for (let i = 1; i < line.coordinates.length; i++) {
    const from = line.coordinates[i - 1];
    const to = line.coordinates[i];
    if (!from || !to) continue;
    const [lng1, lat1] = from;
    const [lng2, lat2] = to;
    km += haversineKm(lat1, lng1, lat2, lng2);
  }
  return km;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
