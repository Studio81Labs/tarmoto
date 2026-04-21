import { create } from "zustand";

export type DiscoverBbox = [number, number, number, number];

interface DiscoverState {
  center: { lng: number; lat: number };
  zoom: number;
  /** Last known viewport bbox from MapCanvas.onViewChange (west,south,east,north). */
  viewportBbox: DiscoverBbox | null;
  /** Bbox of the user-drawn rectangle; null when not drawn / cleared. */
  drawnBbox: DiscoverBbox | null;
  selectedZoneId: string | null;
  hoveredZoneId: string | null;
  showQuality: boolean;

  setCenter: (center: { lng: number; lat: number }) => void;
  setZoom: (zoom: number) => void;
  setViewportBbox: (bbox: DiscoverBbox | null) => void;
  setDrawnBbox: (bbox: DiscoverBbox) => void;
  clearDrawnBbox: () => void;
  setSelectedZoneId: (id: string | null) => void;
  setHoveredZoneId: (id: string | null) => void;
  toggleQuality: () => void;
}

export const useDiscoverStore = create<DiscoverState>((set) => ({
  // Ostrava — same default as /explore so riders in CZ/Moravia see content.
  center: { lng: 18.26, lat: 49.82 },
  zoom: 10,
  viewportBbox: null,
  drawnBbox: null,
  selectedZoneId: null,
  hoveredZoneId: null,
  showQuality: true,

  setCenter: (center) => set({ center }),
  setZoom: (zoom) => set({ zoom }),
  setViewportBbox: (bbox) => set({ viewportBbox: bbox }),
  setDrawnBbox: (bbox) => set({ drawnBbox: bbox }),
  clearDrawnBbox: () => set({ drawnBbox: null }),
  setSelectedZoneId: (id) => set({ selectedZoneId: id }),
  setHoveredZoneId: (id) => set({ hoveredZoneId: id }),
  toggleQuality: () => set((s) => ({ showQuality: !s.showQuality })),
}));
