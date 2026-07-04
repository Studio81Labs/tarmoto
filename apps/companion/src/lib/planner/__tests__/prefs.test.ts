import { describe, expect, it } from "vitest";
import {
  buildPrefsSummary,
  effectiveLegPreference,
  fromTripRoadPreference,
  legId,
  minQualityFromLevel,
  minQualityToLevel,
  reconcileLegPrefs,
  sameUserRoutePrefs,
  toTripRoadPreference,
  DEFAULT_ROAD_PREFERENCE,
  FALLBACK_USER_ROUTE_PREFS,
  type LegPref,
} from "../prefs";

describe("road preference vocabulary (revision 3 §A)", () => {
  it("defaults to direct — not balanced", () => {
    expect(DEFAULT_ROAD_PREFERENCE).toBe("direct");
    expect(FALLBACK_USER_ROUTE_PREFS.roadPreference).toBe("direct");
  });

  it("maps round-trip onto the persisted TripParameters vocabulary", () => {
    expect(toTripRoadPreference("maximum_twisty")).toBe("curvy");
    expect(toTripRoadPreference("scenic_balance")).toBe("scenic");
    expect(toTripRoadPreference("balanced")).toBe("mixed");
    expect(toTripRoadPreference("direct")).toBe("direct");
    // The loop mode routes like direct at the costing level.
    expect(toTripRoadPreference("efficient_loop")).toBe("direct");

    expect(fromTripRoadPreference("curvy")).toBe("maximum_twisty");
    expect(fromTripRoadPreference("scenic")).toBe("scenic_balance");
    expect(fromTripRoadPreference("mixed")).toBe("balanced");
    expect(fromTripRoadPreference("direct")).toBe("direct");
  });

  it("maps the numeric min-quality state onto the level vocabulary", () => {
    expect(minQualityToLevel(1)).toBe("any");
    expect(minQualityToLevel(2)).toBe("fair_or_better");
    expect(minQualityToLevel(3)).toBe("good_or_better");
    expect(minQualityToLevel(4)).toBe("excellent_only");
    for (const level of [
      "any",
      "fair_or_better",
      "good_or_better",
      "excellent_only",
    ] as const) {
      expect(minQualityToLevel(minQualityFromLevel(level))).toBe(level);
    }
  });
});

describe("reconcileLegPrefs (revision 3 §C)", () => {
  const override = (from: string, to: string): LegPref => ({
    fromWaypointId: from,
    toWaypointId: to,
    preference: "maximum_twisty",
  });

  it("builds N-1 inherit legs for a fresh spine", () => {
    const legs = reconcileLegPrefs([], ["a", "b", "c"]);
    expect(legs).toEqual([
      { fromWaypointId: "a", toWaypointId: "b", preference: "inherit" },
      { fromWaypointId: "b", toWaypointId: "c", preference: "inherit" },
    ]);
  });

  it("keeps an override when an UNRELATED waypoint is added", () => {
    const legs = reconcileLegPrefs(
      [override("a", "b")],
      ["a", "b", "x", "c"], // x inserted after the a→b pair
    );
    expect(legs[0]).toEqual(override("a", "b"));
    expect(legs[1]!.preference).toBe("inherit");
    expect(legs[2]!.preference).toBe("inherit");
  });

  it("re-inherits a leg whose pairing broke (via inserted inside it)", () => {
    const legs = reconcileLegPrefs(
      [override("a", "b")],
      ["a", "x", "b"], // x split the a→b leg
    );
    expect(legs.every((leg) => leg.preference === "inherit")).toBe(true);
  });

  it("drops overrides for removed waypoints, keeps survivors", () => {
    const legs = reconcileLegPrefs(
      [override("a", "b"), override("b", "c")],
      ["b", "c"], // a removed
    );
    expect(legs).toEqual([override("b", "c")]);
  });

  it("keeps a reversed pair distinct from the original", () => {
    const legs = reconcileLegPrefs([override("a", "b")], ["b", "a"]);
    // b→a is a DIFFERENT leg from a→b — no override carry-over.
    expect(legs).toEqual([
      { fromWaypointId: "b", toWaypointId: "a", preference: "inherit" },
    ]);
  });

  it("effective preference resolves inherit to the trip-wide value", () => {
    expect(
      effectiveLegPreference({ preference: "inherit" }, "scenic_balance"),
    ).toBe("scenic_balance");
    expect(
      effectiveLegPreference({ preference: "direct" }, "scenic_balance"),
    ).toBe("direct");
    expect(legId("a", "b")).toBe("a->b");
  });
});

describe("buildPrefsSummary (revision 3 §B)", () => {
  it("derives the collapsed row from the current values", () => {
    expect(
      buildPrefsSummary({
        roadPreference: "maximum_twisty",
        avoidHighways: true,
        avoidTolls: true,
        avoidUnpaved: true,
        surfaces: ["asphalt"],
        minQuality: "excellent_only",
      }),
    ).toBe("Maximum twisty · asphalt · Excellent only · avoid highways +2");
  });

  it("summarizes multi-surface and no-avoid combinations", () => {
    expect(
      buildPrefsSummary({
        roadPreference: "direct",
        avoidHighways: false,
        avoidTolls: false,
        avoidUnpaved: false,
        surfaces: ["asphalt", "concrete", "gravel"],
        minQuality: "any",
      }),
    ).toBe("Direct · asphalt +2 · Any quality");
  });

  it("compares pref bundles order-sensitively but value-exactly", () => {
    expect(
      sameUserRoutePrefs(FALLBACK_USER_ROUTE_PREFS, {
        ...FALLBACK_USER_ROUTE_PREFS,
        surfaces: [...FALLBACK_USER_ROUTE_PREFS.surfaces],
      }),
    ).toBe(true);
    expect(
      sameUserRoutePrefs(FALLBACK_USER_ROUTE_PREFS, {
        ...FALLBACK_USER_ROUTE_PREFS,
        avoidTolls: true,
      }),
    ).toBe(false);
  });
});
