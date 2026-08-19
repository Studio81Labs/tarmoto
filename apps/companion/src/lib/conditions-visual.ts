/**
 * Shared visual vocabulary for map "condition" points (closures + passes):
 * the marker kind, its badge colour, and its lucide icon. Used by the map
 * marker layer, the map legend, and the unified point popover so a closure or
 * pass reads the same everywhere.
 */

import {
  Ban,
  Construction,
  MountainSnow,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

export type ConditionKind =
  "closure-full" | "closure-partial" | "roadworks" | "pass";

export const CONDITION_COLORS: Record<ConditionKind, string> = {
  "closure-full": "#C23B22",
  "closure-partial": "#D19A2E",
  roadworks: "#C77D2E",
  pass: "#3F6DB0",
};

/**
 * Marker kind for a closure: full closures lead, roadworks get their own badge,
 * and any other partial/advisory reason reads as a partial closure.
 */
export function closureConditionKind(closure: {
  severity: string;
  reason: string;
}): ConditionKind {
  if (closure.severity === "full") return "closure-full";
  if (closure.reason === "roadworks") return "roadworks";
  return "closure-partial";
}

/** The lucide icon for a condition kind (used in popovers + legends). */
export function conditionKindIcon(kind: ConditionKind): LucideIcon {
  switch (kind) {
    case "closure-full":
      return Ban;
    case "roadworks":
      return Construction;
    case "pass":
      return MountainSnow;
    default:
      return TriangleAlert;
  }
}
