// @ts-nocheck
/**
 * One-off generator: parse the Brno rider's Calimoto GPX exports into a compact,
 * committed data module (`real-demo-rides.data.ts`) that the demo seeder turns
 * into real rides + trips for the `brno.rider@tarmoto.app` persona.
 *
 * The raw GPX (~36 MB, dense 1 s tracks) is NOT committed — it lives outside the
 * repo. This script downsamples the geometry and pre-computes distance /
 * duration / elevation so only a small typed data module lands in git.
 *
 * Run from the repo root after dropping the exports somewhere:
 *   node apps/backend/src/scripts/demo-seed/generate-real-demo-rides.mjs [srcDir]
 * `srcDir` defaults to `_tmp/rides` and must contain `completed/*.gpx` (recorded
 * rides) and `planned/*.gpx` (planned routes; `Den N_*` files group into one
 * multi-day trip).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const srcDir = process.argv[2] ?? join(process.cwd(), '_tmp', 'rides');
const outFile = join(HERE, 'real-demo-rides.data.ts');

const MAX_RIDE_POINTS = 160; // enough to trace the road at map zoom, tiny in git
const MAX_TRIP_POINTS = 220; // routes read better with a touch more detail
const MAX_TRIP_VIAS = 8; // cap intermediate waypoints so the plan isn't cluttered
const ELE_THRESHOLD_M = 3; // hysteresis to keep GPS noise out of elevation gain
const COORD_DP = 5; // ~1 m; plenty for display

// ---- tiny GPX helpers (regex — the files are regular Calimoto output) -------

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** All `<trkpt lon lat><ele/><time/>` in document order. */
function parseTrackPoints(xml) {
  const re =
    /<trkpt\s+lon="([-\d.]+)"\s+lat="([-\d.]+)"\s*>([\s\S]*?)<\/trkpt>/g;
  const pts = [];
  let m;
  while ((m = re.exec(xml))) {
    const lng = Number(m[1]);
    const lat = Number(m[2]);
    const ele = /<ele>([-\d.]+)<\/ele>/.exec(m[3]);
    const time = /<time>([^<]+)<\/time>/.exec(m[3]);
    pts.push({
      lng,
      lat,
      ele: ele ? Number(ele[1]) : null,
      time: time ? time[1] : null,
    });
  }
  return pts;
}

/** `<rtept lon lat>` route geometry, in order. */
function parseRoutePoints(xml) {
  const re = /<rtept\s+lon="([-\d.]+)"\s+lat="([-\d.]+)"/g;
  const pts = [];
  let m;
  while ((m = re.exec(xml))) pts.push({ lng: Number(m[1]), lat: Number(m[2]) });
  return pts;
}

/** `<wpt lon lat>` stops. */
function parseWaypoints(xml) {
  const re = /<wpt\s+lon="([-\d.]+)"\s+lat="([-\d.]+)"/g;
  const pts = [];
  let m;
  while ((m = re.exec(xml))) pts.push({ lng: Number(m[1]), lat: Number(m[2]) });
  return pts;
}

function firstName(xml) {
  const m = /<name>([^<]+)<\/name>/.exec(xml);
  return m ? m[1].trim() : '';
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

function totalKm(pts) {
  let km = 0;
  for (let i = 1; i < pts.length; i++) km += haversineKm(pts[i - 1], pts[i]);
  return km;
}

function bearingDeg(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const p1 = toRad(a.lat);
  const p2 = toRad(b.lat);
  const dl = toRad(b.lng - a.lng);
  const y = Math.sin(dl) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/**
 * Curviness on the app's canonical **0–5** scale (matching
 * `road_segments.curviness_score`, which `RidesService.avg_curviness` averages
 * and the community `min_curviness` filter compares against). Derived from the
 * route's turning-per-km, first resampling to ~50 m legs so 1 s GPS heading
 * jitter doesn't inflate it. ~55°/km maps to ~1; capped at 5.
 */
function curvinessScore(pts) {
  if (pts.length < 3) return 0;
  const resampled = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += haversineKm(pts[i - 1], pts[i]);
    if (acc >= 0.05) {
      resampled.push(pts[i]);
      acc = 0;
    }
  }
  if (resampled.length < 3) return 0;
  let turn = 0;
  for (let i = 2; i < resampled.length; i++) {
    let d = Math.abs(
      bearingDeg(resampled[i - 1], resampled[i]) -
        bearingDeg(resampled[i - 2], resampled[i - 1]),
    );
    if (d > 180) d = 360 - d;
    turn += d;
  }
  const km = totalKm(resampled);
  if (km < 0.1) return 0;
  return round(Math.min(5, turn / km / 55), 2);
}

/** Downsample to <= max points, always keeping first + last. */
function downsample(pts, max) {
  if (pts.length <= max) return pts;
  const out = [];
  const step = (pts.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(pts[Math.round(i * step)]);
  out[out.length - 1] = pts[pts.length - 1];
  return out;
}

/** Elevation gain/loss with a small hysteresis so 1 s GPS jitter isn't counted. */
function elevation(pts) {
  const eles = pts.map((p) => p.ele).filter((e) => e != null);
  if (eles.length < 2) return { gain: 0, loss: 0 };
  let gain = 0;
  let loss = 0;
  let ref = eles[0];
  for (const e of eles) {
    const d = e - ref;
    if (d >= ELE_THRESHOLD_M) {
      gain += d;
      ref = e;
    } else if (d <= -ELE_THRESHOLD_M) {
      loss += -d;
      ref = e;
    }
  }
  return { gain: Math.round(gain), loss: Math.round(loss) };
}

const coords = (pts) =>
  pts.map((p) => [round(p.lng, COORD_DP), round(p.lat, COORD_DP)]);

function rideTypeFor(km) {
  // Recorded rides are `commute` when short + local, else a plain `free` ride.
  // Deliberately avoid `trip` (that ride_type implies a linked Trip entity).
  return km < 15 ? 'commute' : 'free';
}

// ---- completed rides --------------------------------------------------------

function buildRides() {
  const dir = join(srcDir, 'completed');
  const files = readdirSync(dir).filter((f) =>
    f.toLowerCase().endsWith('.gpx'),
  );
  const rides = [];
  for (const file of files.sort()) {
    const xml = readFileSync(join(dir, file), 'utf8');
    const pts = parseTrackPoints(xml);
    if (pts.length < 2) continue;
    const withTime = pts.filter((p) => p.time);
    const startedAt = withTime[0]?.time ?? null;
    const endedAt = withTime[withTime.length - 1]?.time ?? null;
    if (!startedAt || !endedAt) continue;
    const durationSec = Math.max(
      1,
      Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000),
    );
    const distanceKm = round(totalKm(pts), 2);
    const { gain, loss } = elevation(pts);
    rides.push({
      name: firstName(xml) || basename(file, '.gpx'),
      startedAt,
      endedAt,
      distanceKm,
      durationSec,
      elevationGain: gain,
      elevationLoss: loss,
      curviness: curvinessScore(pts),
      rideType: rideTypeFor(distanceKm),
      points: coords(downsample(pts, MAX_RIDE_POINTS)),
    });
  }
  return rides;
}

// ---- planned trips ----------------------------------------------------------

/** Cap intermediate stops: keep start + end + evenly-sampled vias. */
function capVias(wpts, max) {
  if (wpts.length <= max + 2) return wpts;
  const first = wpts[0];
  const last = wpts[wpts.length - 1];
  const mids = wpts.slice(1, -1);
  const step = (mids.length - 1) / (max - 1);
  const picked = [];
  for (let i = 0; i < max; i++) picked.push(mids[Math.round(i * step)]);
  return [first, ...picked, last];
}

function buildTripDay(xml, file) {
  const route = parseRoutePoints(xml);
  const stops = parseWaypoints(xml);
  const rawTitle = firstName(xml) || basename(file, '.gpx');
  // "Den 1:Krčmaň to Jičín" → "Krčmaň → Jičín"; "A → B" stays.
  const title = rawTitle
    .replace(/^Den\s*\d+\s*[:_]\s*/i, '')
    .replace(/\s+to\s+/i, ' → ')
    .trim();
  return {
    title,
    distanceKm: round(totalKm(route), 2),
    curviness: curvinessScore(route),
    points: coords(downsample(route, MAX_TRIP_POINTS)),
    waypoints: coords(capVias(stops, MAX_TRIP_VIAS)).map(([lng, lat]) => ({
      lng,
      lat,
    })),
  };
}

function endpointName(title, which) {
  const parts = title.split(/→|to/i).map((s) => s.trim());
  return which === 'start' ? parts[0] : parts[parts.length - 1];
}

function buildTrips() {
  const dir = join(srcDir, 'planned');
  const files = readdirSync(dir).filter((f) =>
    f.toLowerCase().endsWith('.gpx'),
  );
  const trips = [];
  const denFiles = files
    .filter((f) => /^Den\s*\d+/i.test(f))
    .sort((a, b) => {
      const na = Number(/^Den\s*(\d+)/i.exec(a)[1]);
      const nb = Number(/^Den\s*(\d+)/i.exec(b)[1]);
      return na - nb;
    });
  const singleFiles = files.filter((f) => !/^Den\s*\d+/i.test(f)).sort();

  // Multi-day trip from the `Den N_*` files.
  if (denFiles.length) {
    const days = denFiles.map((file, i) => {
      const day = buildTripDay(readFileSync(join(dir, file), 'utf8'), file);
      return { dayNumber: i + 1, ...day };
    });
    const from = endpointName(days[0].title, 'start');
    const to = endpointName(days[days.length - 1].title, 'end');
    trips.push({
      title: `${from} → ${to} (${days.length} days)`,
      region: 'Vysočina, CZ',
      days,
    });
  }

  // Single-day planned routes.
  for (const file of singleFiles) {
    const day = buildTripDay(readFileSync(join(dir, file), 'utf8'), file);
    trips.push({
      title: day.title,
      region: 'Brno, CZ',
      days: [{ dayNumber: 1, ...day }],
    });
  }
  return trips;
}

// ---- emit -------------------------------------------------------------------

const rides = buildRides();
const trips = buildTrips();

const banner = `// GENERATED by generate-real-demo-rides.mjs — do not edit by hand.
// Source: the Brno rider's Calimoto GPX exports (raw files not committed).
// Regenerate with: node apps/backend/src/scripts/demo-seed/generate-real-demo-rides.mjs [srcDir]
`;

const types = `
/** One recorded ride: real geometry + real start/end + real elevation. */
export interface RealDemoRide {
  name: string;
  startedAt: string; // ISO 8601 (real ride time; the seeder rebases to recent)
  endedAt: string;
  distanceKm: number;
  durationSec: number;
  elevationGain: number;
  elevationLoss: number;
  curviness: number; // 0–5, matching road_segments.curviness_score
  rideType: "free" | "commute" | "trip" | "tracked";
  points: [number, number][]; // [lng, lat]
}

export interface RealDemoTripDay {
  dayNumber: number;
  title: string;
  distanceKm: number;
  curviness: number; // 0–5
  points: [number, number][]; // [lng, lat] route geometry
  waypoints: { lng: number; lat: number }[];
}

export interface RealDemoTrip {
  title: string;
  region: string;
  days: RealDemoTripDay[];
}
`;

const body =
  banner +
  types +
  `\nexport const REAL_DEMO_RIDES: RealDemoRide[] = ${JSON.stringify(rides)};\n` +
  `\nexport const REAL_DEMO_TRIPS: RealDemoTrip[] = ${JSON.stringify(trips)};\n`;

writeFileSync(outFile, body);

const bytes = Buffer.byteLength(body);
console.log(
  `Wrote ${outFile}\n  ${rides.length} rides, ${trips.length} trips, ${(bytes / 1024).toFixed(0)} KB`,
);
const totalPts =
  rides.reduce((s, r) => s + r.points.length, 0) +
  trips.reduce(
    (s, t) => s + t.days.reduce((d, x) => d + x.points.length, 0),
    0,
  );
console.log(`  ${totalPts} geometry points total`);
