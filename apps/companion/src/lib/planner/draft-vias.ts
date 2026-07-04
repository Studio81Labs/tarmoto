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
