/**
 * Hazard type metadata shared across the mobile UI.
 *
 * The canonical type union lives in `@tarmoto/shared` (and is
 * re-exported via `@/types`); this file only owns the rendering bits
 * — order and human-readable labels — so screens and components don't
 * drift on those when a new hazard is added.
 *
 * Whenever a hazard type is added/renamed in `@tarmoto/shared`,
 * `HAZARD_TYPE_LABELS` and `HAZARD_TYPE_ORDER` must be updated here
 * once; every consumer (HazardReportScreen, HazardReportFab) picks it
 * up automatically.
 */

import type { HazardType } from "@/types";
import type { EnglishMessageKey } from "@/i18n";

export const HAZARD_TYPE_LABELS: Record<HazardType, EnglishMessageKey> = {
  pothole: "Pothole",
  gravel: "Gravel",
  oil_spill: "Oil spill",
  roadworks: "Roadworks",
  animals: "Animals",
  police: "Police",
  flooding: "Flooding",
  ice: "Ice",
  other: "Other",
};

/**
 * Display order for tile grids and quick-pick menus. Frequency-based:
 * the hazards riders are most likely to report sit in the top row so
 * one-tap reporting is fastest for the common case.
 */
export const HAZARD_TYPE_ORDER: HazardType[] = [
  "pothole",
  "gravel",
  "oil_spill",
  "roadworks",
  "animals",
  "police",
  "flooding",
  "ice",
  "other",
];
