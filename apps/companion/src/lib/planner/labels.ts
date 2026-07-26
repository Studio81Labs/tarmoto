import type { EnglishMessageKey, Translate } from "@/i18n";
import type { Poi, PoiCategory, PoiSource } from "@/lib/planner/types";
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

const POI_SOURCE_LABELS = {
  osm: "OpenStreetMap",
  fsq: "Foursquare",
  passes: "Mountain passes",
  tarmoto: "Tarmoto",
} satisfies Record<PoiSource, EnglishMessageKey>;

export function poiCategoryDisplayName(
  category: PoiCategory,
  t: Translate,
): string {
  return t(POI_CATEGORY_LABELS[category]);
}

export function poiSourceDisplayName(source: PoiSource, t: Translate): string {
  return t(POI_SOURCE_LABELS[source]);
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
  preserveLegacyLikeName = false,
): name is string {
  return (
    Boolean(name?.trim()) &&
    (preserveLegacyLikeName || !isLegacyGeneratedWaypointName(name))
  );
}

/** Translate a semantic waypoint role while preserving rider/place names. */
export function waypointDisplayName(
  waypoint: Pick<Waypoint, "name" | "nameIsSource" | "type" | "poiCategory">,
  t: Translate,
): string {
  const label = WAYPOINT_TYPE_LABELS[waypoint.type] ?? "Waypoint";
  if (
    hasCustomWaypointName(
      waypoint.name,
      waypoint.nameIsSource || Boolean(waypoint.poiCategory),
    )
  ) {
    return waypoint.name;
  }
  return waypoint.poiCategory
    ? poiCategoryDisplayName(waypoint.poiCategory, t)
    : t(label);
}

/** Render a day-plan boundary without turning display-only copy into data. */
export function dayPlanBoundaryDisplayName(
  name: string,
  nameIsSource: boolean | undefined,
  poiCategory: PoiCategory | undefined,
  type: "start" | "end",
  t: Translate,
): string {
  return waypointDisplayName(
    {
      type,
      ...(name ? { name } : {}),
      ...(nameIsSource ? { nameIsSource: true } : {}),
      ...(poiCategory ? { poiCategory } : {}),
    },
    t,
  );
}

/** Translate source-owned POI fallbacks; real venue/place names stay data. */
export function poiDisplayName(
  poi: Pick<Poi, "category" | "name">,
  t: Translate,
): string {
  if (poi.name.trim()) return poi.name;
  return poiCategoryDisplayName(poi.category, t);
}
