"use client";

import type { MapColorScheme } from "@/lib/map-style";

// The companion currently ships a light-only theme, so the basemap must
// stay on its light palette regardless of the OS preference. The hook
// keeps its previous return-shape so consumers don't have to change.
export function useMapColorScheme(): MapColorScheme {
  return "light";
}
