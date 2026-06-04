"use client";

import { useEffect } from "react";
import { usePreferencesStore } from "@/stores/preferences";

/**
 * Hydrates the unit preference (km/mi) from localStorage once on mount.
 * Mounted in the authenticated app shell so every dashboard page reflects the
 * rider's saved units — previously only pages that called `hydrate()` directly
 * (Road map, Profile) did, so landing straight on e.g. `/rides` fell back to
 * the metric default even for imperial riders. Headless: renders nothing.
 */
export function PreferencesSync() {
  const hydrate = usePreferencesStore((s) => s.hydrate);
  useEffect(() => {
    hydrate();
  }, [hydrate]);
  return null;
}
