import { describe, expect, it, vi, beforeEach } from "vitest";
import { poiApi, routingApi, type RouteResponse } from "@/lib/api";
import { fetchFunZonesInBbox } from "@/lib/discover";
import {
  createPlannerApi,
  deriveFlaggedSections,
  surfaceMixToPercents,
} from "../api";
import type { RouteSegment } from "../types";

vi.mock("@/lib/api", () => ({
  routingApi: { route: vi.fn() },
  poiApi: { getAlongRoute: vi.fn(), getAccommodations: vi.fn() },
}));
vi.mock("@/lib/discover", () => ({ fetchFunZonesInBbox: vi.fn() }));

const routeMock = vi.mocked(routingApi.route);
const alongRouteMock = vi.mocked(poiApi.getAlongRoute);
const accommodationsMock = vi.mocked(poiApi.getAccommodations);

function segment(overrides: Partial<RouteSegment>): RouteSegment {
  return {
    id: "d1-s0",
    geometry: {
      type: "LineString",
      coordinates: [
        [15, 49],
        [15, 49.1],
      ],
    },
    band: "good",
    surface: "asphalt",
    score: 4.2,
    passes: 20,
    lengthKm: 11.1,
    dayNumber: 1,
    ...overrides,
  };
}

describe("surfaceMixToPercents", () => {
  it("converts metres to whole percentages, largest first", () => {
    expect(
      surfaceMixToPercents({
        asphalt: 71_000,
        concrete: 18_000,
        gravel: 8_000,
        unknown: 3_000,
      }),
    ).toEqual([
      { surface: "asphalt", pct: 71 },
      { surface: "concrete", pct: 18 },
      { surface: "gravel", pct: 8 },
      { surface: "unknown", pct: 3 },
    ]);
  });

  it("folds unrecognised surface keys into unknown", () => {
    expect(
      surfaceMixToPercents({ asphalt: 500, paving_stones: 250, sett: 250 }),
    ).toEqual([
      { surface: "asphalt", pct: 50 },
      { surface: "unknown", pct: 50 },
    ]);
  });

  it("ignores non-positive entries and handles an empty mix", () => {
    expect(surfaceMixToPercents({})).toEqual([]);
    expect(surfaceMixToPercents({ asphalt: 0, gravel: -5 })).toEqual([]);
  });
});

describe("deriveFlaggedSections", () => {
  it("flags rough and no_data segments with rounded lengths", () => {
    const segments = [
      segment({ id: "d1-s0", band: "good" }),
      segment({
        id: "d1-s1",
        band: "rough",
        surface: "gravel",
        lengthKm: 4.234,
      }),
      segment({
        id: "d1-s2",
        band: "no_data",
        surface: "unknown",
        score: null,
        passes: 0,
        lengthKm: 3.06,
      }),
    ];
    expect(deriveFlaggedSections(segments)).toEqual([
      {
        segmentId: "d1-s1",
        kind: "rough",
        lengthKm: 4.2,
        label: "Rough · gravel, 4.2 km",
      },
      {
        segmentId: "d1-s2",
        kind: "no_data",
        lengthKm: 3.1,
        label: "No data yet · 3.1 km",
      },
    ]);
  });

  it("returns nothing for a clean route", () => {
    expect(deriveFlaggedSections([segment({})])).toEqual([]);
  });
});

describe("plannerApi.generateRoute", () => {
  beforeEach(() => {
    routeMock.mockReset();
  });

  const rawResponse: RouteResponse = {
    geometry: Array.from({ length: 12 }, (_, i) => ({
      lat: 49 + i * 0.1,
      lng: 15,
    })),
    distance_km: 122.1,
    duration_min: 96,
    avg_quality: 3.8,
    curviness_score: 41,
    elevation_gain_m: 800,
    surface_mix: { asphalt: 100_000, gravel: 22_100 },
  };

  it("routes for real, then joins mock per-segment quality", async () => {
    routeMock.mockResolvedValue({ data: rawResponse });
    const api = createPlannerApi();

    const result = await api.generateRoute(
      [
        { lat: 49, lng: 15 },
        { lat: 50.1, lng: 15 },
      ],
      { avoid_highways: true },
      { dayNumber: 2 },
    );

    expect(routeMock).toHaveBeenCalledWith(
      {
        waypoints: [
          { lat: 49, lng: 15 },
          { lat: 50.1, lng: 15 },
        ],
        options: { avoid_highways: true },
      },
      {},
    );
    expect(result.raw).toBe(rawResponse);
    expect(result.segments.length).toBeGreaterThanOrEqual(2);
    expect(result.segments.every((s) => s.dayNumber === 2)).toBe(true);
    expect(result.summary.distanceKm).toBe(122.1);
    expect(result.summary.timeMin).toBe(96);
    expect(result.summary.score).toBe(3.8);
    expect(result.summary.surfaceMix).toEqual([
      { surface: "asphalt", pct: 82 },
      { surface: "gravel", pct: 18 },
    ]);
    // Flagged sections reference real segment ids.
    const ids = new Set(result.segments.map((s) => s.id));
    for (const flag of result.summary.flagged) {
      expect(ids.has(flag.segmentId)).toBe(true);
    }
  });

  it("omits options from the request body when undefined", async () => {
    routeMock.mockResolvedValue({ data: rawResponse });
    await createPlannerApi().generateRoute(
      [
        { lat: 49, lng: 15 },
        { lat: 50.1, lng: 15 },
      ],
      undefined,
    );
    expect(routeMock).toHaveBeenCalledWith(
      {
        waypoints: [
          { lat: 49, lng: 15 },
          { lat: 50.1, lng: 15 },
        ],
      },
      {},
    );
  });

  it("forwards the abort signal to the routing call", async () => {
    routeMock.mockResolvedValue({ data: rawResponse });
    const controller = new AbortController();
    await createPlannerApi().generateRoute(
      [
        { lat: 49, lng: 15 },
        { lat: 50.1, lng: 15 },
      ],
      undefined,
      { signal: controller.signal },
    );
    expect(routeMock).toHaveBeenCalledWith(expect.anything(), {
      signal: controller.signal,
    });
  });

  it("propagates routing failures unchanged", async () => {
    routeMock.mockRejectedValue(new Error("routing down"));
    await expect(
      createPlannerApi().generateRoute(
        [
          { lat: 49, lng: 15 },
          { lat: 50.1, lng: 15 },
        ],
        undefined,
      ),
    ).rejects.toThrow("routing down");
  });
});

describe("plannerApi.getRoadPreview", () => {
  it("resolves a preview for the given segment", async () => {
    const preview = await createPlannerApi().getRoadPreview(segment({}));
    expect(preview.segmentId).toBe("d1-s0");
    expect(preview.hasData).toBe(true);
  });
});

describe("plannerApi.getPois", () => {
  beforeEach(() => {
    alongRouteMock.mockReset();
    accommodationsMock.mockReset();
  });

  const route = [
    { lat: 49, lng: 15 },
    { lat: 49.5, lng: 15.2 },
  ];

  it("maps planner types onto the real POI endpoints and merges results", async () => {
    alongRouteMock.mockResolvedValue({
      data: {
        pois: [
          {
            external_id: "n123",
            name: "Devět skal vista",
            kind: "viewpoint",
            lat: 49.2,
            lng: 15.1,
            distance_along_route_km: 41,
            distance_from_route_km: 0.4,
            website: null,
            phone: null,
            hint: null,
          },
        ],
        buffer_km: 2,
        kinds: ["viewpoint", "fuel_station"],
        route_length_km: 62.4,
      },
    });
    accommodationsMock.mockResolvedValue({
      data: {
        accommodations: [
          {
            external_id: "w456",
            name: "Penzion U Lesa",
            kind: "guest_house",
            lat: 49.51,
            lng: 15.21,
            distance_km: 2.1,
            website: null,
            phone: null,
            stars: null,
          },
        ],
        radius_km: 10,
        kinds: ["guest_house"],
      },
    });

    const pois = await createPlannerApi().getPois(route, [
      "viewpoint",
      "fuel",
      "stay",
    ]);

    expect(alongRouteMock).toHaveBeenCalledWith(
      { route, kinds: ["viewpoint", "fuel_station"] },
      undefined,
    );
    expect(accommodationsMock).toHaveBeenCalledWith(
      { lat: 49.5, lng: 15.2 },
      undefined,
    );
    expect(pois).toEqual([
      {
        id: "n123",
        type: "viewpoint",
        name: "Devět skal vista",
        lat: 49.2,
        lng: 15.1,
        distanceFromRouteKm: 0.4,
        kmAlongRoute: 41,
      },
      {
        id: "w456",
        type: "stay",
        name: "Penzion U Lesa",
        lat: 49.51,
        lng: 15.21,
        distanceFromRouteKm: 2.1,
      },
    ]);
  });

  it("skips the along-route call when only stays are requested", async () => {
    accommodationsMock.mockResolvedValue({
      data: { accommodations: [], radius_km: 10, kinds: [] },
    });
    await createPlannerApi().getPois(route, ["stay"]);
    expect(alongRouteMock).not.toHaveBeenCalled();
    expect(accommodationsMock).toHaveBeenCalledOnce();
  });

  it("returns nothing for an empty route or empty type list", async () => {
    expect(await createPlannerApi().getPois([], ["fuel"])).toEqual([]);
    expect(await createPlannerApi().getPois(route, [])).toEqual([]);
    expect(alongRouteMock).not.toHaveBeenCalled();
    expect(accommodationsMock).not.toHaveBeenCalled();
  });
});

describe("plannerApi.draftRoute (revision 2 §E cases 2/3)", () => {
  const zonesMock = vi.mocked(fetchFunZonesInBbox);

  beforeEach(() => {
    routeMock.mockReset();
    zonesMock.mockReset();
  });

  const start = { lat: 49, lng: 15 };
  const finish = { lat: 50, lng: 15 };

  function zone(
    id: string,
    score: number,
    lat: number,
    lng: number,
  ): {
    id: string;
    name: string;
    composite_score: number;
    boundary: unknown[];
  } {
    return {
      id,
      name: `Zone ${id}`,
      composite_score: score,
      boundary: [{ lat, lng }],
    };
  }

  /** Route responses keyed by waypoint count + which via lats are present. */
  function mockRouteDistances(
    resolve: (waypoints: Array<{ lat: number; lng: number }>) => number,
  ) {
    routeMock.mockImplementation((body) => {
      const waypoints = (
        body as { waypoints: Array<{ lat: number; lng: number }> }
      ).waypoints;
      const km = resolve(waypoints);
      return Promise.resolve({
        data: {
          geometry: waypoints.flatMap((w, i) =>
            i === 0
              ? [w]
              : [{ lat: (waypoints[i - 1]!.lat + w.lat) / 2, lng: w.lng }, w],
          ),
          distance_km: km,
          duration_min: km,
          avg_quality: 4,
          curviness_score: 30,
          elevation_gain_m: 100,
          surface_mix: { asphalt: km * 1000 },
        },
      } as never);
    });
  }

  it("case 3: a full-day direct route stays natural — corridor zones only, never inflation", async () => {
    mockRouteDistances((wps) => (wps.length === 2 ? 300 : 320));
    zonesMock.mockResolvedValue([
      zone("on-corridor", 80, 49.5, 15.05),
      zone("far-away", 95, 49.5, 16.5),
    ] as never);

    const result = await createPlannerApi().draftRoute(start, finish, {
      region: null,
      prefs: undefined,
      dailyKmForSizing: 250,
    });

    expect(result.inflated).toBe(false);
    expect(result.reachedTargetKm).toBe(true);
    // Only the zone near the direct line is threaded as flavor.
    expect(result.vias.map((v) => v.name)).toEqual(["Zone on-corridor"]);
    expect(result.summary.distanceKm).toBe(320);
  });

  it("case 2: inflates a short hop through the best zones until the target is met", async () => {
    // Direct 120 km; threading the best zone stretches to 260 ≥ 250.
    mockRouteDistances((wps) => (wps.length === 2 ? 120 : 260));
    zonesMock.mockResolvedValue([
      zone("best", 90, 49.5, 15.4),
      zone("second", 70, 49.4, 14.6),
    ] as never);

    const result = await createPlannerApi().draftRoute(start, finish, {
      region: [14, 48.5, 16, 50.5],
      prefs: undefined,
      dailyKmForSizing: 250,
    });

    expect(zonesMock).toHaveBeenCalledWith([14, 48.5, 16, 50.5], undefined);
    expect(result.inflated).toBe(true);
    expect(result.reachedTargetKm).toBe(true);
    expect(result.vias.map((v) => v.name)).toEqual(["Zone best"]);
    expect(result.summary.distanceKm).toBe(260);
    // Stopped at the target — no wasteful extra measuring calls.
    expect(routeMock).toHaveBeenCalledTimes(2);
  });

  it("case 2: reports honestly when good roads run out short of the target", async () => {
    // Only one zone; even with it the ride is 180 < 0.9 × 250.
    mockRouteDistances((wps) => (wps.length === 2 ? 120 : 180));
    zonesMock.mockResolvedValue([zone("only", 60, 49.5, 15.3)] as never);

    const result = await createPlannerApi().draftRoute(start, finish, {
      region: null,
      prefs: undefined,
      dailyKmForSizing: 250,
    });

    expect(result.inflated).toBe(true);
    expect(result.reachedTargetKm).toBe(false);
    expect(result.summary.distanceKm).toBe(180);
  });

  it("case 2: skips a detour that balloons past the overshoot ceiling", async () => {
    // Zone "huge" (best score) balloons the day to 600 km; zone "sane"
    // lands at 260. The draft must pick "sane".
    mockRouteDistances((wps) => {
      if (wps.length === 2) return 120;
      return wps.some((w) => Math.abs(w.lat - 49.8) < 0.01) ? 600 : 260;
    });
    zonesMock.mockResolvedValue([
      zone("huge", 95, 49.8, 15.9),
      zone("sane", 80, 49.5, 15.3),
    ] as never);

    const result = await createPlannerApi().draftRoute(start, finish, {
      region: null,
      prefs: undefined,
      dailyKmForSizing: 250,
    });

    expect(result.vias.map((v) => v.name)).toEqual(["Zone sane"]);
    expect(result.summary.distanceKm).toBe(260);
    expect(result.reachedTargetKm).toBe(true);
  });

  it("returns the plain direct route when the zone lookup fails", async () => {
    mockRouteDistances(() => 120);
    zonesMock.mockRejectedValue(new Error("fun zones down"));

    const result = await createPlannerApi().draftRoute(start, finish, {
      region: null,
      prefs: undefined,
      dailyKmForSizing: 250,
    });

    expect(result.inflated).toBe(false);
    expect(result.reachedTargetKm).toBe(false);
    expect(result.vias).toEqual([]);
    expect(result.summary.distanceKm).toBe(120);
    expect(routeMock).toHaveBeenCalledTimes(1);
  });
});
