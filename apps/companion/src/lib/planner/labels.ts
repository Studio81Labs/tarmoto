import type { EnglishMessageKey, Translate } from "@/i18n";
import type { Poi } from "@/lib/planner/types";
import type { Waypoint } from "@/lib/types";

/**
 * English labels written by planner versions before generated waypoint roles
 * became semantic. Keep this only as a read/migration path for existing drafts;
 * new waypoints never persist translated role copy in `name`.
 */
const LEGACY_GENERATED_WAYPOINT_NAME_RE =
  /^(Start|Finish|End|Via \d+|Reroute via)$/;

const WAYPOINT_TYPE_LABELS = {
  start: "Start",
  via: "Via",
  end: "Finish",
  fuel: "Fuel",
  rest: "Rest",
  photo: "Photo",
  accommodation: "Accommodation",
} satisfies Record<Waypoint["type"], EnglishMessageKey>;

export function isLegacyGeneratedWaypointName(
  name: string | null | undefined,
): boolean {
  return (
    typeof name === "string" && LEGACY_GENERATED_WAYPOINT_NAME_RE.test(name)
  );
}

export function hasCustomWaypointName(
  name: string | null | undefined,
): name is string {
  return Boolean(name?.trim()) && !isLegacyGeneratedWaypointName(name);
}

/** Translate a semantic waypoint role while preserving rider/place names. */
export function waypointDisplayName(
  waypoint: Pick<Waypoint, "name" | "type">,
  t: Translate,
): string {
  const label = WAYPOINT_TYPE_LABELS[waypoint.type] ?? "Waypoint";
  return hasCustomWaypointName(waypoint.name) ? waypoint.name : t(label);
}

/** Translate source-owned POI fallbacks; real venue/place names stay data. */
export function poiDisplayName(
  poi: Pick<Poi, "category" | "name">,
  t: Translate,
): string {
  if (poi.name.trim()) return poi.name;
  return poi.category === "twisty_highlight"
    ? t("Twisty highlight")
    : t("Unnamed");
}
