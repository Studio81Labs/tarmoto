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

  setCenter: (center: { lng: number; lat: number }) => void;
  setZoom: (zoom: number) => void;
  setViewportBbox: (bbox: DiscoverBbox | null) => void;
  setDrawnBbox: (bbox: DiscoverBbox) => void;
  clearDrawnBbox: () => void;
  setSelectedZoneId: (id: string | null) => void;
}

function bboxEqual(a: DiscoverBbox | null, b: DiscoverBbox | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

// Setters short-circuit when the incoming value equals the current one.
// Without this, the URL-sync effect in page.tsx would round-trip through
// hydrate → setCenter → re-render → re-sync each moveend, even though
// nothing actually changed.
export const useDiscoverStore = create<DiscoverState>((set) => ({
  // Ostrava — same default as /explore so riders in CZ/Moravia see content.
  center: { lng: 18.26, lat: 49.82 },
  zoom: 10,
  viewportBbox: null,
  drawnBbox: null,
  selectedZoneId: null,

  setCenter: (center) =>
    set((s) =>
      s.center.lng === center.lng && s.center.lat === center.lat
        ? s
        : { center },
    ),
  setZoom: (zoom) => set((s) => (s.zoom === zoom ? s : { zoom })),
  setViewportBbox: (bbox) =>
    set((s) => (bboxEqual(s.viewportBbox, bbox) ? s : { viewportBbox: bbox })),
  setDrawnBbox: (bbox) =>
    set((s) => (bboxEqual(s.drawnBbox, bbox) ? s : { drawnBbox: bbox })),
  clearDrawnBbox: () =>
    set((s) => (s.drawnBbox === null ? s : { drawnBbox: null })),
  setSelectedZoneId: (id) =>
    set((s) => (s.selectedZoneId === id ? s : { selectedZoneId: id })),
}));
