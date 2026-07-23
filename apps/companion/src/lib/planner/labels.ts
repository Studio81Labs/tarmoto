import type { EnglishMessageKey, Translate } from "@/i18n";
import type { Poi, PoiCategory } from "@/lib/planner/types";
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

const POI_CATEGORY_LABELS = {
  fuel: "Fuel",
  food: "Food & drinks",
  cafe: "Cafe",
  viewpoint: "Viewpoint",
  campground: "Campground",
  biker_hotel: "Biker hotel",
  mountain_pass: "Mountain pass",
  twisty_highlight: "Twisty highlight",
} satisfies Record<PoiCategory, EnglishMessageKey>;

export function poiCategoryDisplayName(
  category: PoiCategory,
  t: Translate,
): string {
  return t(POI_CATEGORY_LABELS[category]);
}

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
  waypoint: Pick<Waypoint, "name" | "type" | "poiCategory">,
  t: Translate,
): string {
  const label = WAYPOINT_TYPE_LABELS[waypoint.type] ?? "Waypoint";
  if (hasCustomWaypointName(waypoint.name)) return waypoint.name;
  return waypoint.poiCategory
    ? poiCategoryDisplayName(waypoint.poiCategory, t)
    : t(label);
}

/** Translate source-owned POI fallbacks; real venue/place names stay data. */
export function poiDisplayName(
  poi: Pick<Poi, "category" | "name">,
  t: Translate,
): string {
  if (poi.name.trim()) return poi.name;
  return poiCategoryDisplayName(poi.category, t);
}
