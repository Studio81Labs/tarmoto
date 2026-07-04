/**
 * Start+finish drafting (rider feedback): when BOTH endpoints exist, a
 * "Draft route" doesn't need the backend loop generator — the route is
 * already live A→B. What drafting adds is Fun-Zone vias: pick the best
 * zones inside the drawn region and thread them between start and finish
 * in travel order, letting live routing redraw through them.
 */

export interface DraftZone {
  id: string;
  name: string | null;
  composite_score: number;
  boundary: unknown[];
}

export interface DraftVia {
  lat: number;
  lng: number;
  name: string;
}

/** Highest-scoring zones worth threading into a single draft. */
export const MAX_DRAFT_VIAS = 3;

/** Mean of a zone's boundary ring; null when the ring is unusable. */
export function funZoneCentroid(
  zone: Pick<DraftZone, "boundary">,
): { lat: number; lng: number } | null {
  let latSum = 0;
  let lngSum = 0;
  let count = 0;
  for (const point of zone.boundary) {
    const { lat, lng } = (point ?? {}) as { lat?: unknown; lng?: unknown };
    if (typeof lat === "number" && typeof lng === "number") {
      latSum += lat;
      lngSum += lng;
      count += 1;
    }
  }
  if (count === 0) return null;
  return { lat: latSum / count, lng: lngSum / count };
}

/**
 * Search bbox ([west, south, east, north]) around both endpoints when no
 * region was drawn — "nearby good roads" for revision 2 §E inflation.
 * ~0.35° ≈ 25–40 km at central-European latitudes.
 */
export const CORRIDOR_BBOX_PAD_DEG = 0.35;

export function corridorBbox(
  start: { lat: number; lng: number },
  finish: { lat: number; lng: number },
  padDeg: number = CORRIDOR_BBOX_PAD_DEG,
): [number, number, number, number] {
  return [
    Math.min(start.lng, finish.lng) - padDeg,
    Math.min(start.lat, finish.lat) - padDeg,
    Math.max(start.lng, finish.lng) + padDeg,
    Math.max(start.lat, finish.lat) + padDeg,
  ];
}

const KM_PER_DEG_LAT = 111.32;

/**
 * Approximate distance (km) from a point to the start→finish great-line,
 * good enough at corridor scale: equirectangular projection around the
 * segment's latitude, then plain point-to-segment distance.
 */
export function kmFromCorridor(
  point: { lat: number; lng: number },
  start: { lat: number; lng: number },
  finish: { lat: number; lng: number },
): number {
  const cosLat = Math.cos(((start.lat + finish.lat) / 2) * (Math.PI / 180));
  const ax = start.lng * cosLat;
  const ay = start.lat;
  const bx = finish.lng * cosLat;
  const by = finish.lat;
  const px = point.lng * cosLat;
  const py = point.lat;
  const abx = bx - ax;
  const aby = by - ay;
  const lengthSq = abx * abx + aby * aby;
  const tRaw =
    lengthSq === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby) / lengthSq;
  const t = Math.max(0, Math.min(1, tRaw));
  const dx = px - (ax + abx * t);
  const dy = py - (ay + aby * t);
  return Math.sqrt(dx * dx + dy * dy) * KM_PER_DEG_LAT;
}

/**
 * Zones close enough to the direct line to count as "light flavor" on a
 * full-day route (revision 2 §E case 3) — never length padding.
 */
export function zonesNearCorridor(
  zones: DraftZone[],
  start: { lat: number; lng: number },
  finish: { lat: number; lng: number },
  maxKm: number,
): DraftZone[] {
  return zones.filter((zone) => {
    const centroid = funZoneCentroid(zone);
    return (
      centroid !== null && kmFromCorridor(centroid, start, finish) <= maxKm
    );
  });
}

/**
 * Top zones as vias, ordered by their projection onto the start→finish
 * axis so the drafted route flows toward the finish instead of
 * zig-zagging between zones.
 */
export function draftViasThroughZones(
  zones: DraftZone[],
  start: { lat: number; lng: number },
  finish: { lat: number; lng: number },
  maxVias: number = MAX_DRAFT_VIAS,
): DraftVia[] {
  const axisLng = finish.lng - start.lng;
  const axisLat = finish.lat - start.lat;

  return zones
    .slice()
    .sort((a, b) => b.composite_score - a.composite_score)
    .slice(0, maxVias)
    .flatMap((zone) => {
      const centroid = funZoneCentroid(zone);
      return centroid
        ? [
            {
              ...centroid,
              name: zone.name ?? "Fun Zone",
              alongAxis:
                (centroid.lng - start.lng) * axisLng +
                (centroid.lat - start.lat) * axisLat,
            },
          ]
        : [];
    })
    .sort((a, b) => a.alongAxis - b.alongAxis)
    .map(({ lat, lng, name }) => ({ lat, lng, name }));
}
