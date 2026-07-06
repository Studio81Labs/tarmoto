import { describe, expect, it } from "vitest";
import {
  concatLegRouteResponses,
  type PlannerRoutingLeg,
} from "../leg-routing";
import type { RouteResponse } from "@/lib/api";

function leg(id: string): PlannerRoutingLeg {
  return {
    legId: id,
    from: { lat: 49, lng: 15 },
    to: { lat: 50, lng: 15 },
    options: undefined,
  };
}

function resp(
  km: number,
  points: number,
  overrides: Partial<RouteResponse> = {},
): RouteResponse {
  return {
    geometry: Array.from({ length: points }, (_, i) => ({
      lat: 49 + i * 0.1,
      lng: 15,
    })),
    distance_km: km,
    duration_min: km * 1.2,
    elevation_gain_m: 100,
    avg_quality: 4,
    curviness_score: 40,
    surface_mix: { asphalt: km * 1000 },
    ...overrides,
  };
}

describe("concatLegRouteResponses (revision 3 §C)", () => {
  it("concatenates geometry, dropping each shared boundary vertex", () => {
    const { merged, legBreaks } = concatLegRouteResponses(
      [leg("a->b"), leg("b->c"), leg("c->d")],
      [resp(10, 3), resp(20, 4), resp(30, 2)],
    );
    // 3 + (4-1) + (2-1) = 7 vertices.
    expect(merged.geometry).toHaveLength(7);
    expect(legBreaks).toEqual([
      { legId: "a->b", startVertex: 0 },
      { legId: "b->c", startVertex: 2 },
      { legId: "c->d", startVertex: 5 },
    ]);
  });

  it("sums additive metrics and merges the surface mix", () => {
    const { merged } = concatLegRouteResponses(
      [leg("a->b"), leg("b->c")],
      [
        resp(10, 2, { surface_mix: { asphalt: 8000, gravel: 2000 } }),
        resp(30, 2, { surface_mix: { asphalt: 30000 } }),
      ],
    );
    expect(merged.distance_km).toBe(40);
    expect(merged.duration_min).toBeCloseTo(48);
    expect(merged.elevation_gain_m).toBe(200);
    expect(merged.surface_mix).toEqual({ asphalt: 38000, gravel: 2000 });
  });

  it("distance-weights quality and curviness, ignoring null legs", () => {
    const { merged } = concatLegRouteResponses(
      [leg("a->b"), leg("b->c")],
      [
        resp(10, 2, { avg_quality: 5, curviness_score: null }),
        resp(30, 2, { avg_quality: 3, curviness_score: 60 }),
      ],
    );
    // (5×10 + 3×30) / 40 = 3.5
    expect(merged.avg_quality).toBeCloseTo(3.5);
    // Only the 30 km leg has curviness — its value carries.
    expect(merged.curviness_score).toBeCloseTo(60);
  });

  it("returns null quality when no leg has a value", () => {
    const { merged } = concatLegRouteResponses(
      [leg("a->b")],
      [resp(10, 2, { avg_quality: null, curviness_score: null })],
    );
    expect(merged.avg_quality).toBeNull();
    expect(merged.curviness_score).toBeNull();
  });

  it("throws on a leg/response count mismatch", () => {
    expect(() =>
      concatLegRouteResponses([leg("a->b")], [resp(1, 2), resp(2, 2)]),
    ).toThrow(/mismatch/);
  });
});
