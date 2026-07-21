import { describe, expect, it } from "vitest";
import {
  rawBreakTargetKms,
  routePointsWithKm,
  snapWindowKm,
  splitIntoDays,
} from "../day-splitter";
import type { PlannerPoi, RouteSegment } from "../types";
import type { Translate } from "@/i18n";

/** ~1 degree of latitude in km for the haversine radius used repo-wide. */
const KM_PER_DEG_LAT = 111.194926;
const degPerKm = 1 / KM_PER_DEG_LAT;

/**
 * Straight meridian route of `totalKm`, chopped into ~`segmentKm` display
 * segments with vertices every ~1 km. Bands alternate so day quality
 * aggregation has variety.
 */
function makeSegments(totalKm: number, segmentKm = 20): RouteSegment[] {
  const segments: RouteSegment[] = [];
  let index = 0;
  for (let startKm = 0; startKm < totalKm; startKm += segmentKm) {
    const endKm = Math.min(startKm + segmentKm, totalKm);
    const coordinates: [number, number][] = [];
    for (let km = startKm; km <= endKm; km += 1) {
      coordinates.push([15, 45 + km * degPerKm]);
    }
    const last = coordinates[coordinates.length - 1];
    if (!last || last[1] !== 45 + endKm * degPerKm) {
      coordinates.push([15, 45 + endKm * degPerKm]);
    }
    segments.push({
      id: `d1-s${index}`,
      geometry: { type: "LineString", coordinates },
      band: index % 4 === 3 ? "rough" : "good",
      surface: index % 4 === 3 ? "gravel" : "asphalt",
      score: index % 4 === 3 ? 2.0 : 4.2,
      passes: 12,
      lengthKm: endKm - startKm,
      dayNumber: 1,
    });
    index += 1;
  }
  return segments;
}

function town(id: string, name: string, alongKm: number): PlannerPoi {
  return {
    id,
    type: "stay",
    name,
    lat: 45 + alongKm * degPerKm,
    lng: 15,
    kmAlongRoute: alongKm,
    distanceFromRouteKm: 1,
  };
}

describe("splitIntoDays", () => {
  it("returns exactly one day for a short trip within the daily budget", () => {
    const plans = splitIntoDays(makeSegments(80), {
      dailyKmTarget: 250,
      forcedDays: null,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.dayNumber).toBe(1);
    expect(plans[0]!.distanceKm).toBeCloseTo(80, 0);
    expect(plans[0]!.startTown).toBe("Start");
    expect(plans[0]!.endTown).toBe("Finish");
    expect(plans[0]!.segmentIds.length).toBeGreaterThan(0);
  });

  it("translates generated endpoint labels", () => {
    const translate = ((key: string) =>
      key === "Start"
        ? "Začátek"
        : key === "Finish"
          ? "Cíl"
          : key) as Translate;
    const plans = splitIntoDays(
      makeSegments(80),
      { dailyKmTarget: 250, forcedDays: null },
      [],
      [],
      undefined,
      translate,
    );

    expect(plans[0]!.startTown).toBe("Začátek");
    expect(plans[0]!.endTown).toBe("Cíl");
  });

  it("splits by daily km and snaps breaks to overnight towns in the window", () => {
    const towns = [town("t1", "Brno", 240), town("t2", "Zagreb", 505)];
    const plans = splitIntoDays(
      makeSegments(700),
      { dailyKmTarget: 250, forcedDays: null, totalTimeMin: 700 },
      towns,
    );

    expect(plans).toHaveLength(3);
    expect(plans[0]!.endTown).toBe("Brno");
    expect(plans[0]!.endKm).toBeCloseTo(240, 0);
    expect(plans[0]!.noTownNearby).toBeUndefined();
    expect(plans[1]!.endTown).toBe("Zagreb");
    expect(plans[2]!.endTown).toBe("Finish");
    // Time distributes by distance share.
    const totalTime = plans.reduce((sum, plan) => sum + plan.timeMin, 0);
    expect(totalTime).toBeGreaterThan(680);
    expect(totalTime).toBeLessThan(720);
    // Snapped town leads the day's suggested stays.
    expect(plans[0]!.suggestedStays[0]!.name).toBe("Brno");
  });

  it("breaks at the raw distance and flags noTownNearby when no town is close", () => {
    const plans = splitIntoDays(makeSegments(600), {
      dailyKmTarget: 250,
      forcedDays: null,
    });
    expect(plans).toHaveLength(3);
    expect(plans[0]!.noTownNearby).toBe(true);
    expect(plans[0]!.endKm).toBeCloseTo(250, 0);
    expect(plans[0]!.endTown).toBe("250 km");
    // The final day never carries the flag — it ends at the finish.
    expect(plans[2]!.noTownNearby).toBeUndefined();
  });

  it("honours forcedDays and back-solves even day boundaries", () => {
    const plans = splitIntoDays(makeSegments(600), {
      dailyKmTarget: 250,
      forcedDays: 2,
    });
    expect(plans).toHaveLength(2);
    expect(plans[0]!.endKm).toBeCloseTo(300, 0);
  });

  it("honours forcedDays on a route much shorter than the daily target", () => {
    // Forcing 2 days on 115 km @ 250/day: the equal 57.5 km shares ARE the
    // intended day length — the runt rebalance must not judge them against
    // the 250 km target and collapse the split back to 1 day.
    const plans = splitIntoDays(makeSegments(115), {
      dailyKmTarget: 250,
      forcedDays: 2,
    });
    expect(plans).toHaveLength(2);
    expect(plans[0]!.endKm).toBeCloseTo(57.5, 0);
  });

  it("merges a runt final day into its predecessor", () => {
    // 520 km @ 250/day → raw breaks at 250 and 500 leave a 20 km last day
    // (< 40% of 250) — the 500 break is dropped.
    const plans = splitIntoDays(makeSegments(520), {
      dailyKmTarget: 250,
      forcedDays: null,
    });
    expect(plans).toHaveLength(2);
    expect(plans[1]!.distanceKm).toBeCloseTo(270, 0);
  });

  it("keeps pinned breaks fixed and splits the regions around them", () => {
    const plans = splitIntoDays(
      makeSegments(600),
      { dailyKmTarget: 250, forcedDays: null },
      [],
      [200],
    );
    expect(plans[0]!.endKm).toBeCloseTo(200, 0);
    expect(plans[0]!.breakPinned).toBe(true);
    // Remaining 400 km region splits once at +250.
    expect(plans).toHaveLength(3);
    expect(plans[1]!.endKm).toBeCloseTo(450, 0);
  });

  it("projects towns without kmAlongRoute onto the route, excluding far-off ones", () => {
    const nearTown: PlannerPoi = {
      id: "near",
      type: "stay",
      name: "Along Town",
      lat: 45 + 245 * degPerKm,
      lng: 15.01, // ~0.8 km off-route
    };
    const farTown: PlannerPoi = {
      id: "far",
      type: "stay",
      name: "Far Town",
      lat: 45 + 250 * degPerKm,
      lng: 15.5, // ~39 km off-route — excluded
    };
    const plans = splitIntoDays(
      makeSegments(600),
      { dailyKmTarget: 250, forcedDays: null },
      [nearTown, farTown],
    );
    expect(plans[0]!.endTown).toBe("Along Town");
    expect(
      plans.flatMap((plan) => plan.suggestedStays.map((stay) => stay.id)),
    ).not.toContain("far");
  });

  it("aggregates per-day quality from the day's segments", () => {
    const plans = splitIntoDays(makeSegments(600), {
      dailyKmTarget: 250,
      forcedDays: null,
    });
    for (const plan of plans) {
      expect(plan.quality.distanceKm).toBeCloseTo(plan.distanceKm, 0);
      expect(plan.quality.score).toBeGreaterThan(0);
      expect(
        plan.quality.surfaceMix.reduce((sum, mix) => sum + mix.pct, 0),
      ).toBeGreaterThan(95);
      // Every flagged section belongs to this day's segments. Flagged cards
      // reference coalesced runs (id `run:<first>:<last>`), so match on the
      // first segment of the range.
      for (const flag of plan.quality.flagged) {
        expect(plan.segmentIds).toContain(
          flag.segmentId.replace(/^run:/, "").split(":")[0],
        );
      }
    }
    // Segment assignment covers the whole route exactly once.
    const allIds = plans.flatMap((plan) => plan.segmentIds);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds.length).toBe(makeSegments(600).length);
  });

  it("treats a loop (finish at the start coordinate) as a normal route", () => {
    // Out-and-back: 300 km north then 300 km back south — the finish
    // coordinate equals the start. lat(km) folds at the turnaround.
    const latAtKm = (km: number) => 45 + (km <= 300 ? km : 600 - km) * degPerKm;
    const segments: RouteSegment[] = [];
    for (let startKm = 0; startKm < 600; startKm += 20) {
      const coordinates: [number, number][] = [];
      for (let km = startKm; km <= startKm + 20; km += 1) {
        coordinates.push([15, latAtKm(km)]);
      }
      segments.push({
        id: `d1-loop${startKm}`,
        geometry: { type: "LineString", coordinates },
        band: "good",
        surface: "asphalt",
        score: 4.0,
        passes: 10,
        lengthKm: 20,
        dayNumber: 1,
      });
    }
    const first = segments[0]!.geometry.coordinates[0];
    const lastSegment = segments[segments.length - 1]!;
    const last =
      lastSegment.geometry.coordinates[
        lastSegment.geometry.coordinates.length - 1
      ];
    expect(last).toEqual(first); // it really is a loop

    const plans = splitIntoDays(segments, {
      dailyKmTarget: 250,
      forcedDays: null,
    });
    const total = plans.reduce((sum, plan) => sum + plan.distanceKm, 0);
    expect(total).toBeCloseTo(600, 0);
    expect(plans.length).toBeGreaterThanOrEqual(2);
  });

  it("is deterministic for identical inputs", () => {
    const towns = [town("t1", "Brno", 240)];
    const a = splitIntoDays(
      makeSegments(700),
      { dailyKmTarget: 250, forcedDays: null },
      towns,
      [100],
    );
    const b = splitIntoDays(
      makeSegments(700),
      { dailyKmTarget: 250, forcedDays: null },
      towns,
      [100],
    );
    expect(a).toEqual(b);
  });

  it("returns nothing for an empty route", () => {
    expect(splitIntoDays([], { dailyKmTarget: 250, forcedDays: null })).toEqual(
      [],
    );
  });
});

describe("splitIntoDays pinned-region snapping", () => {
  it("never lets a town across a pin steal the snap from an in-region town", () => {
    // 300 km route, pin at 210. Region 1 targets: 100, 200 (daily 100,
    // window 20). Two towns near target 200: km 212 sits ACROSS the pin
    // (delta 12) and km 185 inside the region (delta 15). Snapping to
    // 212 would be discarded as out-of-region and the break silently
    // lost — the in-region town must win instead.
    const plans = splitIntoDays(
      makeSegments(300),
      { dailyKmTarget: 100, forcedDays: null, totalTimeMin: 360 },
      [town("out", "Across the pin", 212), town("in", "Mikulov", 185)],
      [210],
    );

    const breakKms = plans.slice(0, -1).map((plan) => plan.endKm);
    expect(breakKms).toContain(185);
    expect(breakKms).not.toContain(212);
    // Every break stays inside its pinned region (the pin itself is one).
    expect(breakKms).toContain(210);
    const mikulovDay = plans.find((plan) => plan.endKm === 185)!;
    expect(mikulovDay.endTown).toBe("Mikulov");
  });

  it("falls back to the raw target when the only nearby town is across the pin", () => {
    // Same shape but WITHOUT the in-region town: the region must keep a
    // break at the raw km-200 target instead of losing it entirely (an
    // overlong 110 km day despite the 100 km daily target).
    const plans = splitIntoDays(
      makeSegments(300),
      { dailyKmTarget: 100, forcedDays: null, totalTimeMin: 360 },
      [town("out", "Across the pin", 212)],
      [210],
    );

    const breakKms = plans.slice(0, -1).map((plan) => plan.endKm);
    expect(breakKms).toContain(200);
    expect(breakKms).not.toContain(212);
  });
});

describe("rawBreakTargetKms", () => {
  it("without pins, targets sit at daily-km multiples", () => {
    expect(rawBreakTargetKms(600, 200, null)).toEqual([200, 400]);
  });

  it("with pins, targets come from each pinned region — matching the splitter", () => {
    // Pin at 250 on a 600 km route with a 200 km target: the second
    // region's break sits at 450 km. Prefetching towns at the
    // whole-route targets (200/400) would never load a stay near 450.
    expect(rawBreakTargetKms(600, 200, null, [250])).toEqual([200, 450]);
  });

  it("forcedDays applies only when there are no pins", () => {
    expect(rawBreakTargetKms(600, 200, 3)).toEqual([200, 400]);
    // With a pin, forcedDays is ambiguous across regions → daily target.
    expect(rawBreakTargetKms(600, 200, 3, [250])).toEqual([200, 450]);
  });
});

describe("routePointsWithKm / snapWindowKm", () => {
  it("accumulates km across segment boundaries without double-counting", () => {
    const points = routePointsWithKm(makeSegments(100));
    expect(points[0]!.km).toBe(0);
    expect(points[points.length - 1]!.km).toBeCloseTo(100, 0);
    // Monotonic.
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]!.km).toBeGreaterThanOrEqual(points[i - 1]!.km);
    }
  });

  it("caps the snap window at 25 km", () => {
    expect(snapWindowKm(100)).toBe(20);
    expect(snapWindowKm(250)).toBe(25);
    expect(snapWindowKm(400)).toBe(25);
  });
});
