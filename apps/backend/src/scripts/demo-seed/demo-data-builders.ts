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

/** GeoJSON-compatible LineString (positions as plain number arrays). */
export interface GeoJSONLineString {
  type: 'LineString';
  coordinates: number[][];
}

/**
 * Slice a line to the [fromFrac, toFrac] vertex range (by index fraction,
 * not arc length — plenty for carving demo closures out of a day route).
 * Always returns at least two vertices.
 */
export function sliceLineByFraction(
  line: GeoJSONLineString,
  fromFrac: number,
  toFrac: number,
): GeoJSONLineString {
  const last = line.coordinates.length - 1;
  const from = Math.max(0, Math.min(last - 1, Math.floor(last * fromFrac)));
  const to = Math.max(from + 1, Math.min(last, Math.ceil(last * toFrac)));
  return {
    type: 'LineString',
    coordinates: line.coordinates.slice(from, to + 1),
  };
}

/** Parallel-offset copy of a line — a plausible demo detour polyline. */
export function offsetLine(
  line: GeoJSONLineString,
  dLng: number,
  dLat: number,
): GeoJSONLineString {
  return {
    type: 'LineString',
    coordinates: line.coordinates.map((position) => [
      round6((position[0] ?? 0) + dLng),
      round6((position[1] ?? 0) + dLat),
    ]),
  };
}

export interface DemoPassRow {
  name: string;
  country_code: string;
  region: string;
  lng: number;
  lat: number;
  elevation_m: number;
  typical_open_month: number;
  typical_close_month: number;
  notes: string;
}

/**
 * The canonical pass catalog from the AddMountainPasses migration — the
 * seeder re-inserts any that are missing (dev databases rebuilt from
 * dumps have the migration marked done but the rows gone).
 */
export const DEMO_PASS_ROWS: DemoPassRow[] = [
  {
    name: 'Stelvio Pass',
    country_code: 'IT',
    region: 'Lombardy',
    lng: 10.454,
    lat: 46.5285,
    elevation_m: 2757,
    typical_open_month: 6,
    typical_close_month: 10,
    notes: "Italy's second-highest paved pass; classic 48-hairpin climb.",
  },
  {
    name: 'Grossglockner High Alpine Road',
    country_code: 'AT',
    region: 'Carinthia/Salzburg',
    lng: 12.8267,
    lat: 47.0744,
    elevation_m: 2504,
    typical_open_month: 5,
    typical_close_month: 10,
    notes: 'Toll road; gates close at night even in season.',
  },
  {
    name: 'Furka Pass',
    country_code: 'CH',
    region: 'Uri/Valais',
    lng: 8.4156,
    lat: 46.5723,
    elevation_m: 2429,
    typical_open_month: 6,
    typical_close_month: 10,
    notes: 'Featured in the 1964 Bond film; spectacular Rhone glacier views.',
  },
  {
    name: 'Gotthard Pass (Tremola)',
    country_code: 'CH',
    region: 'Ticino',
    lng: 8.5664,
    lat: 46.5586,
    elevation_m: 2106,
    typical_open_month: 5,
    typical_close_month: 10,
    notes:
      'Cobblestone Tremola road on south side; tunnel alternative year-round.',
  },
  {
    name: 'San Bernardino Pass',
    country_code: 'CH',
    region: 'Graubünden',
    lng: 9.1728,
    lat: 46.4944,
    elevation_m: 2066,
    typical_open_month: 5,
    typical_close_month: 10,
    notes: 'Closes early after first heavy snow; tunnel below stays open.',
  },
  {
    name: 'Col du Galibier',
    country_code: 'FR',
    region: 'Hautes-Alpes',
    lng: 6.4078,
    lat: 45.0639,
    elevation_m: 2642,
    typical_open_month: 6,
    typical_close_month: 10,
    notes: 'Often used in Tour de France; tunnel bypasses summit when closed.',
  },
  {
    name: "Col d'Iseran",
    country_code: 'FR',
    region: 'Savoie',
    lng: 7.0306,
    lat: 45.4172,
    elevation_m: 2770,
    typical_open_month: 7,
    typical_close_month: 9,
    notes: 'Highest paved pass in the Alps; very short rideable season.',
  },
  {
    name: 'Timmelsjoch / Passo Rombo',
    country_code: 'AT',
    region: 'Tyrol/South Tyrol',
    lng: 11.0967,
    lat: 46.9094,
    elevation_m: 2509,
    typical_open_month: 6,
    typical_close_month: 10,
    notes: 'Toll road; closed at night; Austrian/Italian border.',
  },
  {
    name: 'Pordoi Pass',
    country_code: 'IT',
    region: 'Trentino/Veneto',
    lng: 11.8128,
    lat: 46.4878,
    elevation_m: 2239,
    typical_open_month: 5,
    typical_close_month: 11,
    notes: 'Dolomites; usually first to open and last to close in the region.',
  },
  {
    name: 'Ovčiarsky Vrch (Donovaly)',
    country_code: 'SK',
    region: 'Banská Bystrica',
    lng: 19.2225,
    lat: 48.8775,
    elevation_m: 960,
    typical_open_month: 1,
    typical_close_month: 12,
    notes: 'Open year-round but expect winter conditions Nov–Mar.',
  },
  {
    name: 'Červenohorské sedlo',
    country_code: 'CZ',
    region: 'Olomouc/Moravian-Silesian',
    lng: 17.1242,
    lat: 50.1125,
    elevation_m: 1013,
    typical_open_month: 1,
    typical_close_month: 12,
    notes:
      'Jeseníky pass on road 44; open year-round with frequent winter closures.',
  },
];
