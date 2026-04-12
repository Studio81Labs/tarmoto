export const ROAD_QUALITY = {
  EXCELLENT: 5,
  GOOD: 4,
  FAIR: 3,
  POOR: 2,
  VERY_POOR: 1,
} as const;

export const SURFACE_TYPES = [
  'asphalt',
  'concrete',
  'cobblestone',
  'gravel',
  'dirt',
  'unknown',
] as const;

export type SurfaceType = (typeof SURFACE_TYPES)[number];

export const HAZARD_TYPES = [
  'pothole',
  'gravel',
  'oil_spill',
  'roadworks',
  'animals',
  'police',
  'flooding',
  'ice',
  'other',
] as const;

export type HazardType = (typeof HAZARD_TYPES)[number];

export const HAZARD_SEVERITY = ['low', 'medium', 'high'] as const;

export type HazardSeverity = (typeof HAZARD_SEVERITY)[number];

export const RIDE_TYPES = ['free', 'commute', 'trip', 'tracked'] as const;

export type RideType = (typeof RIDE_TYPES)[number];

export const WAYPOINT_TYPES = [
  'start',
  'via',
  'fuel',
  'food',
  'coffee',
  'hotel',
  'photo',
  'end',
] as const;

export type WaypointType = (typeof WAYPOINT_TYPES)[number];
