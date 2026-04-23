type RoadLineString = {
  type: "LineString";
  coordinates: number[][];
};

type RoadMultiLineString = {
  type: "MultiLineString";
  coordinates: number[][][];
};

export interface RoadSnapFeature {
  geometry?: RoadLineString | RoadMultiLineString | null;
  properties?: {
    quality_score?: number | string | null;
  } | null;
}

export function snapWaypointToRoadFeatures(
  point: { lng: number; lat: number },
  features: readonly RoadSnapFeature[],
): { lng: number; lat: number } | null {
  let best: {
    lng: number;
    lat: number;
    distanceSquared: number;
    qualityScore: number;
  } | null = null;

  for (const feature of features) {
    const candidates =
      feature.geometry?.type === "LineString"
        ? [feature.geometry.coordinates]
        : feature.geometry?.type === "MultiLineString"
          ? feature.geometry.coordinates
          : [];
    const qualityScore = normalizeQualityScore(
      feature.properties?.quality_score,
    );

    for (const coordinates of candidates) {
      for (let index = 1; index < coordinates.length; index++) {
        const snapped = projectPointToSegment(
          point,
          coordinates[index - 1]!,
          coordinates[index]!,
        );
        if (!snapped) continue;
        const candidateDistanceSquared = distanceSquared(
          [point.lng, point.lat],
          [snapped.lng, snapped.lat],
        );

        if (
          !best ||
          candidateDistanceSquared + SNAP_DISTANCE_EPSILON <
            best.distanceSquared ||
          (Math.abs(candidateDistanceSquared - best.distanceSquared) <=
            SNAP_DISTANCE_EPSILON &&
            qualityScore > best.qualityScore)
        ) {
          best = {
            lng: snapped.lng,
            lat: snapped.lat,
            distanceSquared: candidateDistanceSquared,
            qualityScore,
          };
        }
      }
    }
  }

  if (!best) return null;
  return { lng: round6(best.lng), lat: round6(best.lat) };
}

function normalizeQualityScore(
  raw: number | string | null | undefined,
): number {
  const parsed =
    typeof raw === "string"
      ? Number.parseFloat(raw)
      : typeof raw === "number"
        ? raw
        : Number.NaN;
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

function projectPointToSegment(
  point: { lng: number; lat: number },
  start: number[],
  end: number[],
): { lng: number; lat: number } | null {
  if (start.length < 2 || end.length < 2) return null;
  const dx = end[0]! - start[0]!;
  const dy = end[1]! - start[1]!;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return { lng: start[0]!, lat: start[1]! };
  }

  const t =
    ((point.lng - start[0]!) * dx + (point.lat - start[1]!) * dy) /
    lengthSquared;
  const clamped = Math.min(1, Math.max(0, t));
  return {
    lng: start[0]! + dx * clamped,
    lat: start[1]! + dy * clamped,
  };
}

function distanceSquared(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

// Treat quality as a tiebreaker only when the candidates are effectively
// equally close in map-coordinate space, so click placement still feels
// anchored to the nearest visible road.
const SNAP_DISTANCE_EPSILON = 1e-6;

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
