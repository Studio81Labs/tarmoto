import { create } from 'zustand';

interface MapState {
  center: { lng: number; lat: number };
  zoom: number;

  // Overlay toggles
  showQualityOverlay: boolean;
  showHazardOverlay: boolean;
  showSurfaceOverlay: boolean;

  // Filters
  qualityFilter: Set<string>; // 'excellent' | 'good' | 'fair' | 'poor' | 'very-poor'
  surfaceFilter: Set<string>; // 'asphalt' | 'concrete' | 'cobblestone' | 'gravel' | 'dirt'
  curvinessRange: [number, number]; // 0-100

  // Actions
  setCenter: (center: { lng: number; lat: number }) => void;
  setZoom: (zoom: number) => void;
  toggleQuality: () => void;
  toggleHazards: () => void;
  toggleSurface: () => void;
  setQualityFilter: (filter: Set<string>) => void;
  setSurfaceFilter: (filter: Set<string>) => void;
  setCurvinessRange: (range: [number, number]) => void;
}

export const useMapStore = create<MapState>((set) => ({
  center: { lng: 18.26, lat: 49.82 }, // Ostrava default
  zoom: 10,

  showQualityOverlay: true,
  showHazardOverlay: true,
  showSurfaceOverlay: false,

  qualityFilter: new Set(['excellent', 'good', 'fair', 'poor', 'very-poor']),
  surfaceFilter: new Set(['asphalt', 'concrete', 'cobblestone', 'gravel', 'dirt']),
  curvinessRange: [0, 100],

  setCenter: (center) => set({ center }),
  setZoom: (zoom) => set({ zoom }),
  toggleQuality: () => set((s) => ({ showQualityOverlay: !s.showQualityOverlay })),
  toggleHazards: () => set((s) => ({ showHazardOverlay: !s.showHazardOverlay })),
  toggleSurface: () => set((s) => ({ showSurfaceOverlay: !s.showSurfaceOverlay })),
  setQualityFilter: (qualityFilter) => set({ qualityFilter }),
  setSurfaceFilter: (surfaceFilter) => set({ surfaceFilter }),
  setCurvinessRange: (curvinessRange) => set({ curvinessRange }),
}));
