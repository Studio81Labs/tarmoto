import type { HazardType, SurfaceType } from "@tarmoto/shared";
import { QUALITY_TIERS, HAZARD_TYPES_UI } from "@/lib/utils";

export type QualityTier = "excellent" | "good" | "fair" | "poor" | "very-poor";

export type FilterableSurface = Exclude<SurfaceType, "unknown">;

export { QUALITY_TIERS, HAZARD_TYPES_UI };

export const FILTERABLE_SURFACES: readonly FilterableSurface[] = [
  "asphalt",
  "concrete",
  "cobblestone",
  "gravel",
  "dirt",
] as const;

export interface MapFilters {
  quality: Set<QualityTier>;
  surface: Set<FilterableSurface>;
  hazardTypes: Set<HazardType>;
  minCurviness: number;
}

export const DEFAULT_MAP_FILTERS: MapFilters = {
  quality: new Set(QUALITY_TIERS),
  surface: new Set(FILTERABLE_SURFACES),
  hazardTypes: new Set(HAZARD_TYPES_UI),
  minCurviness: 0,
};

const QUALITY_PARAM = "q";
const SURFACE_PARAM = "s";
const HAZARD_PARAM = "h";
const CURVINESS_PARAM = "c";

// Sentinel emitted when the user has explicitly cleared every option in a set
// filter. Needed to distinguish "nothing selected" from "param absent" (which
// falls back to defaults on parse) and from "garbage URL" (also defaults).
const EMPTY_SENTINEL = "none";

export function isQualityTier(value: string): value is QualityTier {
  return (QUALITY_TIERS as readonly string[]).includes(value);
}

export function isFilterableSurface(value: string): value is FilterableSurface {
  return (FILTERABLE_SURFACES as readonly string[]).includes(value);
}

export function isHazardType(value: string): value is HazardType {
  return (HAZARD_TYPES_UI as readonly string[]).includes(value);
}

export function filtersToSearchParams(
  filters: MapFilters,
  base?: URLSearchParams,
): URLSearchParams {
  const params = new URLSearchParams(base);
  params.delete(QUALITY_PARAM);
  params.delete(SURFACE_PARAM);
  params.delete(HAZARD_PARAM);
  params.delete(CURVINESS_PARAM);

  const allQuality = QUALITY_TIERS.every((t) => filters.quality.has(t));
  if (filters.quality.size === 0) {
    params.set(QUALITY_PARAM, EMPTY_SENTINEL);
  } else if (!allQuality) {
    const ordered = QUALITY_TIERS.filter((t) => filters.quality.has(t));
    params.set(QUALITY_PARAM, ordered.join(","));
  }

  const allSurface = FILTERABLE_SURFACES.every((s) => filters.surface.has(s));
  if (filters.surface.size === 0) {
    params.set(SURFACE_PARAM, EMPTY_SENTINEL);
  } else if (!allSurface) {
    const ordered = FILTERABLE_SURFACES.filter((s) => filters.surface.has(s));
    params.set(SURFACE_PARAM, ordered.join(","));
  }

  const allHazards = HAZARD_TYPES_UI.every((h) => filters.hazardTypes.has(h));
  if (filters.hazardTypes.size === 0) {
    params.set(HAZARD_PARAM, EMPTY_SENTINEL);
  } else if (!allHazards) {
    const ordered = HAZARD_TYPES_UI.filter((h) => filters.hazardTypes.has(h));
    params.set(HAZARD_PARAM, ordered.join(","));
  }

  if (filters.minCurviness > 0) {
    params.set(CURVINESS_PARAM, String(clampCurviness(filters.minCurviness)));
  }

  return params;
}

export function filtersFromSearchParams(
  params: URLSearchParams | null | undefined,
): MapFilters {
  if (!params) return cloneFilters(DEFAULT_MAP_FILTERS);

  const quality = parseCsvSet(
    params.get(QUALITY_PARAM),
    QUALITY_TIERS,
    isQualityTier,
  );
  const surface = parseCsvSet(
    params.get(SURFACE_PARAM),
    FILTERABLE_SURFACES,
    isFilterableSurface,
  );
  const hazardTypes = parseCsvSet(
    params.get(HAZARD_PARAM),
    HAZARD_TYPES_UI,
    isHazardType,
  );

  const rawCurviness = params.get(CURVINESS_PARAM);
  const minCurviness =
    rawCurviness === null
      ? 0
      : clampCurviness(Number.parseInt(rawCurviness, 10));

  return { quality, surface, hazardTypes, minCurviness };
}

export interface FilterableSegment {
  quality: QualityTier;
  surface: FilterableSurface | "unknown";
  curviness: number;
}

export function matchesFilters(
  segment: FilterableSegment,
  filters: MapFilters,
): boolean {
  if (!filters.quality.has(segment.quality)) return false;
  if (segment.surface !== "unknown" && !filters.surface.has(segment.surface)) {
    return false;
  }
  if (segment.curviness < filters.minCurviness) return false;
  return true;
}

export function filtersEqual(a: MapFilters, b: MapFilters): boolean {
  if (a.minCurviness !== b.minCurviness) return false;
  if (!setsEqual(a.quality, b.quality)) return false;
  if (!setsEqual(a.surface, b.surface)) return false;
  if (!setsEqual(a.hazardTypes, b.hazardTypes)) return false;
  return true;
}

export function cloneFilters(filters: MapFilters): MapFilters {
  return {
    quality: new Set(filters.quality),
    surface: new Set(filters.surface),
    hazardTypes: new Set(filters.hazardTypes),
    minCurviness: filters.minCurviness,
  };
}

function parseCsvSet<T extends string>(
  raw: string | null,
  all: readonly T[],
  guard: (value: string) => value is T,
): Set<T> {
  if (raw === null) return new Set(all);
  if (raw.trim() === EMPTY_SENTINEL) return new Set<T>();
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const valid = parts.filter(guard);
  if (valid.length === 0) return new Set(all);
  return new Set(valid);
}

export function clampCurviness(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
