import { DEMO_TRIP } from "@/lib/demo-trip";
import type {
  POI,
  RoutePreviewSegment,
  Trip,
  TripDay,
  TripParameters,
  Waypoint,
} from "@/lib/types";
import { scoreToTier } from "@/lib/utils";

export interface GeneratedTripOption {
  id: string;
  label: string;
  summary: string;
  trip: Trip;
}

type OptionPreset = {
  id: string;
  label: string;
  summary: string;
  distanceMultiplier: number;
  qualityDelta: number;
  elevationMultiplier: number;
  templateShift: number;
};

type RouteCoordinate = [number, number];

const OPTION_PRESETS: readonly OptionPreset[] = [
  {
    id: "best-fit",
    label: "Best fit",
    summary: "Balanced route that stays closest to your trip settings.",
    distanceMultiplier: 1,
    qualityDelta: 0.15,
    elevationMultiplier: 1,
    templateShift: 0,
  },
  {
    id: "scenic",
    label: "Scenic sweep",
    summary: "Longer mountain days with more climbing and viewpoints.",
    distanceMultiplier: 1.12,
    qualityDelta: 0.25,
    elevationMultiplier: 1.14,
    templateShift: 1,
  },
  {
    id: "fastest",
    label: "Fastest line",
    summary: "Shorter transfer days that still preserve good riding roads.",
    distanceMultiplier: 0.88,
    qualityDelta: -0.1,
    elevationMultiplier: 0.86,
    templateShift: 2,
  },
] as const;

const DEFAULT_SURFACES = ["asphalt"] as const;
const UNPAVED_SURFACES = new Set(["gravel", "dirt"]);

export function generateTripOptions(
  params: TripParameters,
): GeneratedTripOption[] {
  const normalizedParams = normalizeParams(params);

  return OPTION_PRESETS.map((preset, optionIndex) => {
    const days = Array.from({ length: normalizedParams.days }, (_, dayIndex) =>
      buildGeneratedDay({
        dayNumber: dayIndex + 1,
        params: normalizedParams,
        optionIndex,
        preset,
        template:
          DEMO_TRIP.days[
            (dayIndex + preset.templateShift) % DEMO_TRIP.days.length
          ]!,
      }),
    );

    const now = new Date().toISOString();
    return {
      id: preset.id,
      label: preset.label,
      summary: preset.summary,
      trip: {
        id: `generated-${preset.id}`,
        name: buildTripName(normalizedParams, preset),
        description: preset.summary,
        status: "draft",
        createdAt: now,
        updatedAt: now,
        parameters: cloneTripParameters(normalizedParams),
        collaborators: [],
        days,
      },
    };
  });
}

export function regenerateTripDay(trip: Trip, dayNumber: number): Trip {
  const normalizedParams = normalizeParams(trip.parameters);
  const dayIndex = trip.days.findIndex((day) => day.dayNumber === dayNumber);
  if (dayIndex < 0) return cloneTrip(trip);

  const currentDay = trip.days[dayIndex]!;
  const optionIndex = resolvePresetIndexForTrip(trip);
  const preset = OPTION_PRESETS[optionIndex]!;
  const templateIndex =
    (hashString(currentDay.title ?? `day-${dayNumber}`) + dayNumber) %
    DEMO_TRIP.days.length;
  const template = DEMO_TRIP.days[templateIndex]!;
  const regeneratedDay = buildGeneratedDay({
    dayNumber,
    params: normalizedParams,
    optionIndex,
    preset,
    template,
    existingDay: currentDay,
  });

  const days = trip.days.map((day, index) =>
    index === dayIndex ? regeneratedDay : cloneDay(day),
  );

  return {
    ...trip,
    updatedAt: new Date().toISOString(),
    parameters: cloneTripParameters(trip.parameters),
    collaborators: trip.collaborators.map((collaborator) => ({
      ...collaborator,
    })),
    days,
  };
}

function buildGeneratedDay({
  dayNumber,
  params,
  optionIndex,
  preset,
  template,
  existingDay,
}: {
  dayNumber: number;
  params: TripParameters;
  optionIndex: number;
  preset: OptionPreset;
  template: TripDay;
  existingDay?: TripDay;
}): TripDay {
  const routingConstraints = routeConstraintProfile(params);
  const coordinates = existingDay
    ? buildAnchoredRoute(
        existingDay,
        dayNumber,
        optionIndex,
        routingConstraints,
      )
    : buildShiftedRoute(template, dayNumber, optionIndex, routingConstraints);
  const start = existingDay?.waypoints[0]
    ? cloneWaypoint(existingDay.waypoints[0]!)
    : buildWaypointFromCoordinate({
        id: `day-${dayNumber}-start`,
        name: template.waypoints[0]?.name ?? `Day ${dayNumber} start`,
        type: "start",
        coordinate: coordinates[0]!,
      });
  const end = existingDay?.waypoints.at(-1)
    ? cloneWaypoint(existingDay.waypoints.at(-1)!)
    : buildWaypointFromCoordinate({
        id: `day-${dayNumber}-end`,
        name: template.waypoints.at(-1)?.name ?? `Day ${dayNumber} finish`,
        type: "end",
        coordinate: coordinates.at(-1)!,
      });
  const viaWaypoint = buildWaypointFromCoordinate({
    id: `day-${dayNumber}-via`,
    name: `${buildTitle(template, preset, dayNumber)} midpoint`,
    type: "via",
    coordinate: coordinates[Math.floor(coordinates.length / 2)]!,
  });

  const distanceKm = clamp(
    Math.round(
      params.dailyKmTarget *
        preset.distanceMultiplier *
        routingConstraints.distanceMultiplier +
        dailyDistanceSkew(dayNumber, params.roadPreference),
    ),
    100,
    500,
  );
  const avgQuality = clampNumber(
    Math.max(
      params.minQuality,
      template.avgQuality +
        preset.qualityDelta +
        routingConstraints.qualityDelta,
    ),
    1,
    5,
  );
  const elevationGain = Math.round(
    template.elevationGain *
      preset.elevationMultiplier *
      elevationPreferenceFactor(params.roadPreference) *
      routingConstraints.elevationMultiplier,
  );
  const durationMinutes = Math.max(
    120,
    Math.round(
      (distanceKm / speedForPreference(params.roadPreference, params)) * 60,
    ),
  );
  const segments = buildSegments(
    template.segments ?? [],
    params,
    dayNumber,
    optionIndex,
    avgQuality,
  );

  return {
    dayNumber,
    title: buildTitle(template, preset, dayNumber),
    distanceKm,
    durationMinutes,
    elevationGain,
    avgQuality,
    overnightStop: buildOvernightStop(end, dayNumber),
    routeGeometry: {
      type: "LineString",
      coordinates,
    },
    waypoints: [start, viaWaypoint, end],
    segments,
  };
}

function buildSegments(
  segments: RoutePreviewSegment[],
  params: TripParameters,
  dayNumber: number,
  optionIndex: number,
  avgQuality: number,
): RoutePreviewSegment[] {
  const allowedSurfaces = params.surfacePreference;
  const sourceSegments =
    segments.length > 0 ? segments : (DEMO_TRIP.days[0]?.segments ?? []);

  return sourceSegments.slice(0, 3).map((segment, index) => {
    const qualityScore = clampNumber(
      Math.max(params.minQuality, avgQuality + (index - 1) * 0.15),
      1,
      5,
    );
    const surfaceType =
      allowedSurfaces[
        (dayNumber + optionIndex + index) % allowedSurfaces.length
      ]!;
    return {
      ...segment,
      id: `${segment.id}-day-${dayNumber}-${optionIndex}-${index}`,
      dayNumber,
      orderInDay: index,
      distanceKm: Math.max(8, Math.round(segment.distanceKm * 10) / 10),
      qualityScore,
      qualityTier: scoreToTier(qualityScore),
      surfaceType,
      curvinessScore: clamp(Math.round(segment.curvinessScore), 35, 98),
      elevationProfile: [...segment.elevationProfile],
      photos: [...segment.photos],
      activeHazards: [...segment.activeHazards],
      qualityHistory: segment.qualityHistory
        ? segment.qualityHistory.map((entry) => ({ ...entry }))
        : undefined,
      regionalQualityHistory: segment.regionalQualityHistory
        ? segment.regionalQualityHistory.map((entry) => ({ ...entry }))
        : undefined,
      bounds: segment.bounds
        ? [
            [...segment.bounds[0]] as [number, number],
            [...segment.bounds[1]] as [number, number],
          ]
        : undefined,
    };
  });
}

function buildShiftedRoute(
  template: TripDay,
  dayNumber: number,
  optionIndex: number,
  routingConstraints: ReturnType<typeof routeConstraintProfile>,
): RouteCoordinate[] {
  const baseCoordinates =
    template.routeGeometry?.coordinates.length &&
    template.routeGeometry.coordinates
      ? template.routeGeometry.coordinates
      : template.waypoints.map((waypoint) => [
          waypoint.location.lng,
          waypoint.location.lat,
        ]);

  const lngOffset =
    0.18 * (dayNumber - 1) + 0.04 * optionIndex + routingConstraints.lngOffset;
  const latOffset =
    0.08 * (dayNumber - 1) + 0.03 * optionIndex + routingConstraints.latOffset;

  return baseCoordinates.map(([lng, lat], index) => [
    roundCoord(lng + lngOffset + index * 0.01),
    roundCoord(lat + latOffset + index * 0.005),
  ]);
}

function buildAnchoredRoute(
  existingDay: TripDay,
  dayNumber: number,
  optionIndex: number,
  routingConstraints: ReturnType<typeof routeConstraintProfile>,
): RouteCoordinate[] {
  const start = existingDay.waypoints[0]!;
  const end = existingDay.waypoints.at(-1)!;
  const midLng =
    (start.location.lng + end.location.lng) / 2 +
    0.06 +
    optionIndex * 0.01 +
    routingConstraints.lngOffset;
  const midLat =
    (start.location.lat + end.location.lat) / 2 +
    0.04 +
    dayNumber * 0.005 +
    routingConstraints.latOffset;

  return [
    [start.location.lng, start.location.lat],
    [roundCoord(midLng), roundCoord(midLat)],
    [end.location.lng, end.location.lat],
  ];
}

function buildWaypointFromCoordinate({
  id,
  name,
  type,
  coordinate,
}: {
  id: string;
  name: string;
  type: Waypoint["type"];
  coordinate: [number, number];
}): Waypoint {
  return {
    id,
    name,
    type,
    location: {
      lng: coordinate[0],
      lat: coordinate[1],
    },
  };
}

function buildOvernightStop(end: Waypoint, dayNumber: number): POI {
  return {
    id: `overnight-${dayNumber}`,
    name: `${end.name ?? "Day end"} Lodge`,
    type: "accommodation",
    location: {
      lng: end.location.lng,
      lat: end.location.lat,
    },
    rating: 4.4,
    priceLevel: 2,
  };
}

function buildTripName(params: TripParameters, preset: OptionPreset): string {
  return `${params.days}-day ${params.roadPreference} ${preset.label.toLowerCase()}`;
}

function resolvePresetIndexForTrip(trip: Trip): number {
  const presetIndexFromId = OPTION_PRESETS.findIndex(
    (preset) => trip.id === `generated-${preset.id}`,
  );
  if (presetIndexFromId >= 0) return presetIndexFromId;

  const normalizedName = trip.name.toLowerCase();
  const presetIndexFromName = OPTION_PRESETS.findIndex((preset) =>
    normalizedName.includes(preset.label.toLowerCase()),
  );
  return presetIndexFromName >= 0 ? presetIndexFromName : 0;
}

function buildTitle(
  template: TripDay,
  preset: OptionPreset,
  dayNumber: number,
): string {
  const base = template.title ?? `Day ${dayNumber}`;
  if (preset.id === "best-fit") return base;
  return `${base} · ${preset.label}`;
}

function surfacePool(params: TripParameters) {
  const requested =
    params.surfacePreference.length > 0
      ? params.surfacePreference
      : [...DEFAULT_SURFACES];
  return requested.filter((surface) =>
    params.avoidUnpaved ? !UNPAVED_SURFACES.has(surface) : true,
  );
}

function normalizeParams(params: TripParameters): TripParameters {
  const safeSurfaces = surfacePool({
    ...params,
    surfacePreference:
      params.surfacePreference.length > 0
        ? [...params.surfacePreference]
        : [...DEFAULT_SURFACES],
  });

  return {
    ...params,
    days: clamp(Math.round(params.days), 1, 14),
    dailyKmTarget: clamp(Math.round(params.dailyKmTarget), 100, 500),
    minQuality: clamp(params.minQuality, 1, 5),
    surfacePreference:
      safeSurfaces.length > 0 ? safeSurfaces : [...DEFAULT_SURFACES],
  };
}

function cloneTripParameters(params: TripParameters): TripParameters {
  return {
    ...params,
    surfacePreference: [...params.surfacePreference],
  };
}

function cloneTrip(trip: Trip): Trip {
  return {
    ...trip,
    parameters: cloneTripParameters(trip.parameters),
    collaborators: trip.collaborators.map((collaborator) => ({
      ...collaborator,
    })),
    days: trip.days.map(cloneDay),
  };
}

function cloneDay(day: TripDay): TripDay {
  return {
    ...day,
    overnightStop: day.overnightStop
      ? {
          ...day.overnightStop,
          location: { ...day.overnightStop.location },
        }
      : undefined,
    routeGeometry: day.routeGeometry
      ? {
          type: "LineString",
          coordinates: day.routeGeometry.coordinates.map(([lng, lat]) => [
            lng,
            lat,
          ]),
        }
      : undefined,
    waypoints: day.waypoints.map(cloneWaypoint),
    segments: day.segments?.map((segment) => ({
      ...segment,
      elevationProfile: [...segment.elevationProfile],
      photos: [...segment.photos],
      activeHazards: [...segment.activeHazards],
      qualityHistory: segment.qualityHistory
        ? segment.qualityHistory.map((entry) => ({ ...entry }))
        : undefined,
      regionalQualityHistory: segment.regionalQualityHistory
        ? segment.regionalQualityHistory.map((entry) => ({ ...entry }))
        : undefined,
      bounds: segment.bounds
        ? [
            [...segment.bounds[0]] as [number, number],
            [...segment.bounds[1]] as [number, number],
          ]
        : undefined,
    })),
  };
}

function cloneWaypoint(waypoint: Waypoint): Waypoint {
  return {
    ...waypoint,
    location: { ...waypoint.location },
  };
}

function dailyDistanceSkew(
  dayNumber: number,
  roadPreference: TripParameters["roadPreference"],
) {
  const base = (dayNumber % 2 === 0 ? -16 : 22) + dayNumber * 3;
  if (roadPreference === "direct") return base + 24;
  if (roadPreference === "scenic") return base - 8;
  if (roadPreference === "curvy") return base - 18;
  return base;
}

function elevationPreferenceFactor(
  roadPreference: TripParameters["roadPreference"],
) {
  if (roadPreference === "scenic") return 1.12;
  if (roadPreference === "curvy") return 1.08;
  if (roadPreference === "direct") return 0.82;
  return 1;
}

function speedForPreference(
  roadPreference: TripParameters["roadPreference"],
  params: Pick<TripParameters, "avoidHighways" | "avoidTolls">,
) {
  let speed = 62;
  if (roadPreference === "curvy") speed = 52;
  else if (roadPreference === "scenic") speed = 56;
  else if (roadPreference === "direct") speed = 72;

  if (params.avoidHighways) speed -= 8;
  if (params.avoidTolls) speed -= 3;

  return Math.max(38, speed);
}

function routeConstraintProfile(
  params: Pick<TripParameters, "avoidHighways" | "avoidTolls">,
) {
  return {
    distanceMultiplier:
      1 + (params.avoidHighways ? 0.08 : 0) + (params.avoidTolls ? 0.03 : 0),
    elevationMultiplier:
      1 + (params.avoidHighways ? 0.05 : 0) + (params.avoidTolls ? 0.02 : 0),
    qualityDelta: params.avoidHighways ? 0.1 : 0,
    lngOffset:
      (params.avoidTolls ? 0.015 : 0) + (params.avoidHighways ? 0.01 : 0),
    latOffset:
      (params.avoidHighways ? 0.012 : 0) + (params.avoidTolls ? 0.008 : 0),
  };
}

function roundCoord(value: number) {
  return Math.round(value * 10000) / 10000;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number(value.toFixed(2))));
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 2_147_483_647;
  }
  return hash;
}
