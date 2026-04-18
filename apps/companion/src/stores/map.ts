import { create } from "zustand";
import {
  DEFAULT_MAP_FILTERS,
  filtersEqual,
  type FilterableSurface,
  type MapFilters,
  type QualityTier,
} from "@/lib/map-filters";

interface MapState {
  center: { lng: number; lat: number };
  zoom: number;

  // Overlay toggles
  showQualityOverlay: boolean;
  showHazardOverlay: boolean;
  showSurfaceOverlay: boolean;

  // Filters
  filters: MapFilters;

  // Actions
  setCenter: (center: { lng: number; lat: number }) => void;
  setZoom: (zoom: number) => void;
  toggleQuality: () => void;
  toggleHazards: () => void;
  toggleSurface: () => void;
  toggleQualityTier: (tier: QualityTier) => void;
  toggleSurfaceType: (surface: FilterableSurface) => void;
  setMinCurviness: (value: number) => void;
  setFilters: (filters: MapFilters) => void;
  resetFilters: () => void;
}

function cloneFilters(filters: MapFilters): MapFilters {
  return {
    quality: new Set(filters.quality),
    surface: new Set(filters.surface),
    minCurviness: filters.minCurviness,
  };
}

export const useMapStore = create<MapState>((set) => ({
  center: { lng: 18.26, lat: 49.82 }, // Ostrava default
  zoom: 10,

  showQualityOverlay: true,
  showHazardOverlay: true,
  showSurfaceOverlay: false,

  filters: cloneFilters(DEFAULT_MAP_FILTERS),

  setCenter: (center) => set({ center }),
  setZoom: (zoom) => set({ zoom }),
  toggleQuality: () =>
    set((s) => ({ showQualityOverlay: !s.showQualityOverlay })),
  toggleHazards: () =>
    set((s) => ({ showHazardOverlay: !s.showHazardOverlay })),
  toggleSurface: () =>
    set((s) => ({ showSurfaceOverlay: !s.showSurfaceOverlay })),
  toggleQualityTier: (tier) =>
    set((s) => {
      const next = new Set(s.filters.quality);
      if (next.has(tier)) next.delete(tier);
      else next.add(tier);
      return { filters: { ...s.filters, quality: next } };
    }),
  toggleSurfaceType: (surface) =>
    set((s) => {
      const next = new Set(s.filters.surface);
      if (next.has(surface)) next.delete(surface);
      else next.add(surface);
      return { filters: { ...s.filters, surface: next } };
    }),
  setMinCurviness: (value) =>
    set((s) => ({
      filters: { ...s.filters, minCurviness: clamp(value) },
    })),
  setFilters: (filters) =>
    set((s) =>
      filtersEqual(s.filters, filters)
        ? {}
        : { filters: cloneFilters(filters) },
    ),
  resetFilters: () => set({ filters: cloneFilters(DEFAULT_MAP_FILTERS) }),
}));

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}
