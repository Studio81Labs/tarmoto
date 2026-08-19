import type { SurfaceType, TripParameters } from "@/lib/types";
import type { EnglishMessageKey, Translate } from "@/i18n";

/** All rider-selectable surfaces (companion vocabulary — no "unknown"). */
export const SURFACE_VALUES: readonly SurfaceType[] = [
  "asphalt",
  "concrete",
  "cobblestone",
  "gravel",
  "dirt",
];

/**
 * Road preference vocabulary (revision 3 §A). 'direct' is the default —
 * trip-wide AND for every new per-leg filter. 'efficient_loop' is the
 * roundtrip mode (start-only drafts); the other four are point-to-point
 * road characters. Avoids are independent hard constraints layered on
 * top of ANY preference — never folded into this type.
 */
export type RoadPreference =
  | "direct"
  | "balanced"
  | "scenic_balance"
  | "maximum_twisty"
  | "efficient_loop";

export const DEFAULT_ROAD_PREFERENCE: RoadPreference = "direct";

export const ROAD_PREFERENCE_LABELS: Record<RoadPreference, EnglishMessageKey> =
  {
    direct: "Direct",
    balanced: "Balanced",
    scenic_balance: "Scenic balance",
    maximum_twisty: "Maximum twisty",
    efficient_loop: "Efficient loop",
  };

/** Point-to-point characters offered trip-wide and per leg (§A). */
export const POINT_TO_POINT_PREFERENCES: readonly RoadPreference[] = [
  "direct",
  "balanced",
  "scenic_balance",
  "maximum_twisty",
];

/**
 * Map the planner vocabulary onto the persisted TripParameters/backed
 * trip-generation vocabulary (curvy/scenic/mixed/direct). The loop mode
 * routes like 'direct' — its loop shape comes from the drafting flow,
 * not road costing.
 */
export function toTripRoadPreference(
  preference: RoadPreference,
): TripParameters["roadPreference"] {
  switch (preference) {
    case "maximum_twisty":
      return "curvy";
    case "scenic_balance":
      return "scenic";
    case "balanced":
      return "mixed";
    case "direct":
    case "efficient_loop":
      return "direct";
  }
}

export function fromTripRoadPreference(
  preference: TripParameters["roadPreference"],
): RoadPreference {
  switch (preference) {
    case "curvy":
      return "maximum_twisty";
    case "scenic":
      return "scenic_balance";
    case "mixed":
      return "balanced";
    case "direct":
      return "direct";
  }
}

// ── Per-leg road filters (§C) ────────────────────────────────────────

/**
 * A leg = an ordered pair of consecutive ROUTING waypoints (start/via/
 * end). Overrides are keyed by waypoint identity so an unrelated
 * waypoint edit never disturbs them.
 */
export interface LegPref {
  fromWaypointId: string;
  toWaypointId: string;
  /** 'inherit' = use the trip-wide preference. */
  preference: RoadPreference | "inherit";
}

export function legId(fromWaypointId: string, toWaypointId: string): string {
  return `${fromWaypointId}->${toWaypointId}`;
}

/**
 * Rebuild the leg list for the current ordered routing-waypoint ids,
 * keeping every override whose from→to pair still exists consecutively
 * and re-inheriting pairs that broke (§C reconciliation rule).
 */
export function reconcileLegPrefs(
  existing: readonly LegPref[],
  orderedWaypointIds: readonly string[],
): LegPref[] {
  const byPair = new Map(
    existing.map((leg) => [legId(leg.fromWaypointId, leg.toWaypointId), leg]),
  );
  const legs: LegPref[] = [];
  for (let i = 0; i < orderedWaypointIds.length - 1; i += 1) {
    const from = orderedWaypointIds[i]!;
    const to = orderedWaypointIds[i + 1]!;
    const kept = byPair.get(legId(from, to));
    legs.push(
      kept ?? { fromWaypointId: from, toWaypointId: to, preference: "inherit" },
    );
  }
  return legs;
}

export function effectiveLegPreference(
  leg: Pick<LegPref, "preference">,
  tripWide: RoadPreference,
): RoadPreference {
  return leg.preference === "inherit" ? tripWide : leg.preference;
}

// ── Minimum road quality (§C contract vocabulary) ───────────────────

export type MinQualityLevel =
  "any" | "fair_or_better" | "good_or_better" | "excellent_only";

export const MIN_QUALITY_LABELS: Record<MinQualityLevel, EnglishMessageKey> = {
  any: "Any quality",
  fair_or_better: "Fair or better",
  good_or_better: "Good or better",
  excellent_only: "Excellent only",
};

/** The planner keeps the legacy 1–4 numeric state; map at the seams. */
export function minQualityToLevel(value: number): MinQualityLevel {
  if (value >= 4) return "excellent_only";
  if (value >= 3) return "good_or_better";
  if (value >= 2) return "fair_or_better";
  return "any";
}

export function minQualityFromLevel(level: MinQualityLevel): number {
  switch (level) {
    case "excellent_only":
      return 4;
    case "good_or_better":
      return 3;
    case "fair_or_better":
      return 2;
    case "any":
      return 1;
  }
}

// ── Trip-wide prefs bundle + summary (§B) ────────────────────────────

/** Trip-wide subset that persists as the rider's defaults (§F). */
export interface UserRoutePrefs {
  roadPreference: RoadPreference;
  avoidHighways: boolean;
  avoidTolls: boolean;
  avoidUnpaved: boolean;
  surfaces: SurfaceType[];
  minQuality: MinQualityLevel;
}

export const FALLBACK_USER_ROUTE_PREFS: UserRoutePrefs = {
  roadPreference: DEFAULT_ROAD_PREFERENCE,
  avoidHighways: true,
  avoidTolls: false,
  avoidUnpaved: true,
  surfaces: ["asphalt"],
  minQuality: "good_or_better",
};

const SURFACE_SUMMARY_LABELS: Partial<Record<SurfaceType, EnglishMessageKey>> =
  {
    asphalt: "asphalt",
    concrete: "concrete",
    cobblestone: "cobbles",
    gravel: "gravel",
    dirt: "dirt",
  };

/**
 * Pure derivation of the §02 collapsed summary row, e.g.
 * "Maximum twisty · asphalt · Excellent only · avoid motorways +2".
 */
export function buildPrefsSummary(
  prefs: UserRoutePrefs,
  translate: Translate,
): string {
  const parts: string[] = [
    translate(ROAD_PREFERENCE_LABELS[prefs.roadPreference]),
  ];

  if (prefs.surfaces.length === 0) {
    parts.push(translate("any surface"));
  } else {
    const first = SURFACE_SUMMARY_LABELS[prefs.surfaces[0]!] ?? "other surface";
    parts.push(
      prefs.surfaces.length === 1
        ? translate(first)
        : translate("{label} +{count}", {
            label: translate(first),
            count: prefs.surfaces.length - 1,
          }),
    );
  }

  parts.push(translate(MIN_QUALITY_LABELS[prefs.minQuality]));

  const avoids: string[] = [];
  if (prefs.avoidHighways) avoids.push(translate("avoid motorways"));
  if (prefs.avoidTolls) avoids.push(translate("avoid tolls"));
  if (prefs.avoidUnpaved) avoids.push(translate("avoid unpaved"));
  if (avoids.length === 1) parts.push(avoids[0]!);
  else if (avoids.length > 1)
    parts.push(
      translate("{label} +{count}", {
        label: avoids[0]!,
        count: avoids.length - 1,
      }),
    );

  return parts.join(" · ");
}

export function sameUserRoutePrefs(
  a: UserRoutePrefs,
  b: UserRoutePrefs,
): boolean {
  return (
    a.roadPreference === b.roadPreference &&
    a.avoidHighways === b.avoidHighways &&
    a.avoidTolls === b.avoidTolls &&
    a.avoidUnpaved === b.avoidUnpaved &&
    a.minQuality === b.minQuality &&
    a.surfaces.length === b.surfaces.length &&
    a.surfaces.every((surface, index) => surface === b.surfaces[index])
  );
}
