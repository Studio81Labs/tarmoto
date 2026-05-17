import { create } from "zustand";
import {
  DEFAULT_MAP_FILTERS,
  cloneFilters,
  filtersEqual,
  type FilterableSurface,
  type MapFilters,
  type QualityTier,
} from "@/lib/map-filters";
import type { HazardType } from "@tarmoto/shared";

interface MapState {
  center: { lng: number; lat: number };
  zoom: number;

  // Overlay toggles — paint expressions on the map itself.
  showQualityOverlay: boolean;
  showHazardOverlay: boolean;
  showSurfaceOverlay: boolean;

  // Info-layer toggles — open a docked side panel with structured
  // closure / pass data for the current viewport. Live in the same
  // store as the paint overlays so the explore page can expose them
  // as siblings in the top action row.
  showClosuresLayer: boolean;
  showPassesLayer: boolean;

  // Filters
  filters: MapFilters;

  // Actions
  setCenter: (center: { lng: number; lat: number }) => void;
  setZoom: (zoom: number) => void;
  toggleQuality: () => void;
  toggleHazards: () => void;
  toggleSurface: () => void;
  toggleClosuresLayer: () => void;
  togglePassesLayer: () => void;
  toggleQualityTier: (tier: QualityTier) => void;
  toggleSurfaceType: (surface: FilterableSurface) => void;
  toggleHazardType: (type: HazardType) => void;
  setFilters: (filters: MapFilters) => void;
  resetFilters: () => void;
}

export const useMapStore = create<MapState>((set) => ({
  center: { lng: 18.26, lat: 49.82 }, // Ostrava default
  zoom: 10,

  showQualityOverlay: true,
  showHazardOverlay: true,
  showSurfaceOverlay: false,
  showClosuresLayer: false,
  showPassesLayer: false,

  filters: cloneFilters(DEFAULT_MAP_FILTERS),

  setCenter: (center) => set({ center }),
  setZoom: (zoom) => set({ zoom }),
  toggleQuality: () =>
    set((s) => ({ showQualityOverlay: !s.showQualityOverlay })),
  toggleHazards: () =>
    set((s) => ({ showHazardOverlay: !s.showHazardOverlay })),
  toggleSurface: () =>
    set((s) => ({ showSurfaceOverlay: !s.showSurfaceOverlay })),
  toggleClosuresLayer: () =>
    set((s) => ({ showClosuresLayer: !s.showClosuresLayer })),
  togglePassesLayer: () =>
    set((s) => ({ showPassesLayer: !s.showPassesLayer })),
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
  toggleHazardType: (type) =>
    set((s) => {
      const next = new Set(s.filters.hazardTypes);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return { filters: { ...s.filters, hazardTypes: next } };
    }),
  setFilters: (filters) =>
    set((s) =>
      filtersEqual(s.filters, filters)
        ? {}
        : { filters: cloneFilters(filters) },
    ),
  resetFilters: () => set({ filters: cloneFilters(DEFAULT_MAP_FILTERS) }),
}));
