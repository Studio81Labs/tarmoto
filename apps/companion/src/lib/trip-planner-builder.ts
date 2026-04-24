import type * as GeoJSON from "geojson";
import { pointsDistanceKm } from "./gpx-kml-import";
import type {
  RoutePreviewSegment,
  SurfaceType,
  Trip,
  TripDay,
  TripParameters,
  Waypoint,
} from "./types";
import { filterRoutingWaypoints } from "./trip-routing";
import { scoreToTier } from "./utils";

const DEFAULT_PARAMETERS: TripParameters = {
  days: 1,
  dailyKmTarget: 250,
  roadPreference: "mixed",
  surfacePreference: ["asphalt"],
  avoidHighways: true,
  avoidTolls: false,
  avoidUnpaved: true,
  minQuality: 3,
};

const MAX_PREVIEW_SEGMENTS = 10;

export function createPlannerDraftTrip(nowIso: string): Trip {
  return {
    id: `planner-${slugFromIso(nowIso)}`,
    name: "New Trip",
    status: "draft",
    createdAt: nowIso,
    updatedAt: nowIso,
    parameters: { ...DEFAULT_PARAMETERS },
    collaborators: [{ userId: "u-owner", displayName: "You", role: "owner" }],
    days: [createEmptyPlannerDay(1)],
  };
}

function createEmptyPlannerDay(dayNumber: number): TripDay {
  return {
    dayNumber,
    title: `Day ${dayNumber}`,
    waypoints: [],
    distanceKm: 0,
    durationMinutes: 0,
    elevationGain: 0,
    avgQuality: 0,
    segments: [],
  };
}

export function appendPlannerWaypointToDay(
  day: TripDay,
  location: { lng: number; lat: number },
): TripDay {
  const nextWaypoint = createPlannerWaypoint(day, location);
  const waypoints = [...day.waypoints];
  const endIndex = waypoints.findIndex((waypoint) => waypoint.type === "end");

  if (waypoints.length === 0) {
    waypoints.push({ ...nextWaypoint, type: "start", name: "Start" });
  } else if (endIndex === -1) {
    waypoints.push({ ...nextWaypoint, type: "end", name: "Finish" });
  } else {
    waypoints.splice(endIndex, 0, {
      ...nextWaypoint,
      type: "via",
      name: `Via ${countRouteStops(waypoints)}`,
    });
  }

  return {
    ...day,
    waypoints,
  };
}

export function rebuildPlannerDay(
  day: TripDay,
  parameters: TripParameters,
): TripDay {
  const routeWaypoints = filterRoutingWaypoints(day.waypoints);
  if (routeWaypoints.length < 2) {
    return {
      ...day,
      routeGeometry: undefined,
      distanceKm: 0,
      durationMinutes: 0,
      elevationGain: 0,
      avgQuality: 0,
      segments: [],
    };
  }

  const routePoints = buildRoutePoints(routeWaypoints, parameters);
  if (routePoints.length < 2) {
    return {
      ...day,
      routeGeometry: undefined,
      distanceKm: 0,
      durationMinutes: 0,
      elevationGain: 0,
      avgQuality: 0,
      segments: [],
    };
  }
  const routeGeometry: GeoJSON.LineString = {
    type: "LineString",
    coordinates: routePoints,
  };
  const distanceKm = round1(pointsDistanceKm(routePoints));
  const segments = buildPreviewSegments(routePoints, day.dayNumber, parameters);
  const avgQuality =
    segments.length > 0
      ? round2(
          segments.reduce((sum, segment) => sum + segment.qualityScore, 0) /
            segments.length,
        )
      : 0;

  return {
    ...day,
    routeGeometry,
    distanceKm,
    durationMinutes: Math.max(
      10,
      Math.round((distanceKm / estimateCruisingSpeed(parameters)) * 60),
    ),
    elevationGain: estimateElevationGain(routePoints, parameters),
    avgQuality,
    segments,
  };
}

export function ensurePlannerDays(
  days: TripDay[],
  requiredCount: number,
): TripDay[] {
  if (days.length >= requiredCount) return [...days];
  const next = [...days];
  for (let index = days.length; index < requiredCount; index++) {
    next.push(createEmptyPlannerDay(index + 1));
  }
  return next;
}

function createPlannerWaypoint(
  day: TripDay,
  location: { lng: number; lat: number },
): Waypoint {
  return {
    id: `planner-${day.dayNumber}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: undefined,
    location,
    type: "via",
  };
}

function countRouteStops(waypoints: Waypoint[]): number {
  return (
    waypoints.filter(
      (waypoint) =>
        waypoint.type === "via" ||
        waypoint.type === "fuel" ||
        waypoint.type === "rest" ||
        waypoint.type === "photo" ||
        waypoint.type === "accommodation",
    ).length + 1
  );
}

function buildRoutePoints(
  waypoints: Waypoint[],
  parameters: TripParameters,
): Array<[number, number]> {
  const points: Array<[number, number]> = [];

  for (let index = 1; index < waypoints.length; index++) {
    const start: [number, number] = [
      waypoints[index - 1]!.location.lng,
      waypoints[index - 1]!.location.lat,
    ];
    const end: [number, number] = [
      waypoints[index]!.location.lng,
      waypoints[index]!.location.lat,
    ];
    const legPoints = buildLegPoints(start, end, index - 1, parameters);
    if (points.length === 0) {
      points.push(...legPoints);
    } else {
      points.push(...legPoints.slice(1));
    }
  }

  return dedupeSequentialPoints(points);
}

function buildLegPoints(
  start: [number, number],
  end: [number, number],
  legIndex: number,
  parameters: TripParameters,
): Array<[number, number]> {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const magnitude = Math.hypot(dx, dy);
  if (magnitude < 1e-9) return [start, end];
  if (parameters.roadPreference === "direct") {
    return [start, end];
  }

  const scenicFactor =
    {
      direct: 0.08,
      mixed: 0.16,
      scenic: 0.24,
      curvy: 0.3,
    }[parameters.roadPreference] +
    Math.max(0, parameters.minQuality - 2) * 0.02;
  const amplitude = Math.min(0.11, magnitude * scenicFactor * 0.22);
  const offsetLng = (-dy / magnitude) * amplitude;
  const offsetLat = (dx / magnitude) * amplitude;
  const sign =
    (hashNumber(legIndex + start[0] * 100 + end[1] * 100) & 1) === 0 ? 1 : -1;

  const p1 = interpolatePoint(start, end, 0.28, sign, offsetLng, offsetLat);
  const p2 = interpolatePoint(
    start,
    end,
    0.52,
    sign,
    offsetLng * 0.55,
    offsetLat * 0.55,
  );
  const p3 = interpolatePoint(
    start,
    end,
    0.76,
    -sign,
    offsetLng * 0.7,
    offsetLat * 0.7,
  );

  return [start, p1, p2, p3, end];
}

function interpolatePoint(
  start: [number, number],
  end: [number, number],
  factor: number,
  sign: number,
  offsetLng: number,
  offsetLat: number,
): [number, number] {
  return [
    start[0] + (end[0] - start[0]) * factor + offsetLng * sign,
    start[1] + (end[1] - start[1]) * factor + offsetLat * sign,
  ];
}

function dedupeSequentialPoints(
  points: Array<[number, number]>,
): Array<[number, number]> {
  return points.filter((point, index) => {
    if (index === 0) return true;
    const previous = points[index - 1]!;
    return (
      Math.abs(previous[0] - point[0]) > 1e-6 ||
      Math.abs(previous[1] - point[1]) > 1e-6
    );
  });
}

function estimateCruisingSpeed(parameters: TripParameters): number {
  const base =
    {
      curvy: 48,
      scenic: 54,
      mixed: 60,
      direct: 72,
    }[parameters.roadPreference] -
    Math.max(0, parameters.minQuality - 3) * 2;

  if (parameters.avoidHighways) return Math.max(38, base - 4);
  return Math.max(40, base);
}

function estimateElevationGain(
  points: Array<[number, number]>,
  parameters: TripParameters,
): number {
  const distanceKm = pointsDistanceKm(points);
  const multiplier =
    parameters.roadPreference === "curvy"
      ? 11
      : parameters.roadPreference === "scenic"
        ? 9
        : 6;
  return Math.round(distanceKm * multiplier);
}

function buildPreviewSegments(
  points: Array<[number, number]>,
  dayNumber: number,
  parameters: TripParameters,
): RoutePreviewSegment[] {
  const totalDistanceKm = pointsDistanceKm(points);
  if (totalDistanceKm <= 0 || points.length < 2) return [];

  const targetSegments = Math.min(
    MAX_PREVIEW_SEGMENTS,
    Math.max(1, Math.round(totalDistanceKm / 22)),
  );
  const targetChunkKm = totalDistanceKm / targetSegments;
  const segments: RoutePreviewSegment[] = [];
  let chunkPoints: Array<[number, number]> = [points[0]!];
  let chunkDistanceKm = 0;

  for (let index = 1; index < points.length; index++) {
    const stepDistanceKm = pointsDistanceKm([
      points[index - 1]!,
      points[index]!,
    ]);
    chunkDistanceKm += stepDistanceKm;
    chunkPoints.push(points[index]!);

    const isLastPoint = index === points.length - 1;
    if (chunkDistanceKm >= targetChunkKm || isLastPoint) {
      const segmentIndex = segments.length;
      segments.push(
        buildPreviewSegment(
          chunkPoints,
          chunkDistanceKm,
          segmentIndex,
          dayNumber,
          parameters,
        ),
      );
      chunkPoints = [points[index]!];
      chunkDistanceKm = 0;
    }
  }

  return segments;
}

function buildPreviewSegment(
  points: Array<[number, number]>,
  distanceKm: number,
  index: number,
  dayNumber: number,
  parameters: TripParameters,
): RoutePreviewSegment {
  const seed = hashPoints(points) + hashNumber(index * 19 + dayNumber * 31);
  const baseScore =
    parameters.minQuality -
    0.25 +
    {
      direct: 0.1,
      mixed: 0.2,
      scenic: 0.35,
      curvy: 0.45,
    }[parameters.roadPreference];
  const variance = (positiveModulo(seed, 80) - 40) / 100;
  const qualityScore = clamp(round1(baseScore + variance), 1.8, 4.9);

  return {
    id: `planner-seg-${dayNumber}-${index + 1}`,
    name: `Segment ${index + 1}`,
    dayNumber,
    orderInDay: index,
    distanceKm: round1(distanceKm),
    qualityScore,
    qualityTier: scoreToTier(qualityScore),
    surfaceType: selectSurfaceType(seed, parameters),
    curvinessScore: clampInteger(
      42 +
        ((seed >>> 3) % 40) +
        (parameters.roadPreference === "curvy" ? 18 : 0) +
        (parameters.roadPreference === "scenic" ? 8 : 0),
      30,
      98,
    ),
    elevationProfile: buildElevationProfile(seed, distanceKm),
    photos: [],
    activeHazards: [],
    bounds: computeBounds(points),
  };
}

function selectSurfaceType(
  seed: number,
  parameters: TripParameters,
): SurfaceType {
  const preferred = parameters.surfacePreference[0];
  if (preferred) return preferred;
  if (parameters.avoidUnpaved) return "asphalt";
  return (["asphalt", "concrete", "gravel"] as SurfaceType[])[
    positiveModulo(seed, 3)
  ]!;
}

function buildElevationProfile(seed: number, distanceKm: number): number[] {
  const points = Math.min(8, Math.max(4, Math.round(distanceKm / 6)));
  const profile: number[] = [];
  let current = 280 + positiveModulo(seed, 320);
  for (let index = 0; index < points; index++) {
    current += ((seed >>> (index % 8)) % 35) - 10;
    profile.push(Math.max(120, current));
  }
  return profile;
}

function computeBounds(
  points: Array<[number, number]>,
): [[number, number], [number, number]] | undefined {
  if (points.length === 0) return undefined;
  let minLng = points[0]![0];
  let minLat = points[0]![1];
  let maxLng = minLng;
  let maxLat = minLat;
  for (const [lng, lat] of points) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

function hashPoints(points: Array<[number, number]>): number {
  let hash = 0x811c9dc5;
  for (const [lng, lat] of points) {
    const key = `${lng.toFixed(3)},${lat.toFixed(3)};`;
    for (let index = 0; index < key.length; index++) {
      hash ^= key.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}

function hashNumber(value: number): number {
  const normalized = Math.round(value * 1000);
  return (((normalized * 2654435761) >>> 0) ^ 0x9e3779b9) >>> 0;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function slugFromIso(iso: string): string {
  return iso.replace(/[^0-9]/g, "").slice(0, 14);
}
