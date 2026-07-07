import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  poiApi,
  roadsApi,
  routingApi,
  usersApi,
  type RouteResponse,
} from "@/lib/api";
import { fetchFunZonesInBbox } from "@/lib/discover";
import {
  createPlannerApi,
  deriveFlaggedSections,
  surfaceMixToPercents,
} from "../api";
import type { RouteSegment } from "../types";

vi.mock("@/lib/api", () => ({
  routingApi: { route: vi.fn() },
  roadsApi: { getRouteQuality: vi.fn() },
  poiApi: { getAlongRoute: vi.fn(), getAccommodations: vi.fn() },
  usersApi: { getMe: vi.fn(), updateMe: vi.fn() },
}));
vi.mock("@/lib/discover", () => ({ fetchFunZonesInBbox: vi.fn() }));

const routeMock = vi.mocked(routingApi.route);
const routeQualityMock = vi.mocked(roadsApi.getRouteQuality);
const alongRouteMock = vi.mocked(poiApi.getAlongRoute);
const accommodationsMock = vi.mocked(poiApi.getAccommodations);
const getMeMock = vi.mocked(usersApi.getMe);
const updateMeMock = vi.mocked(usersApi.updateMe);

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

  it("routes for real and applies the geometry-only no_data baseline", async () => {
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
    // Real per-segment quality is fetched separately (getRouteQuality); the
    // generateRoute baseline carries none — every segment is no_data.
    expect(result.segments.every((s) => s.band === "no_data")).toBe(true);
    expect(result.segments.every((s) => s.score === null)).toBe(true);
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

describe("plannerApi.getRouteQuality (#862)", () => {
  const points = [
    { lat: 49, lng: 16 },
    { lat: 49.1, lng: 16.1 },
  ];

  beforeEach(() => {
    routeQualityMock.mockReset();
  });

  it("requests quality for the polyline and maps the spans onto it", async () => {
    routeQualityMock.mockResolvedValue({
      data: {
        segments: [
          {
            osm_way_id: "1",
            segment_index: 0,
            quality_score: 4.2,
            curviness_score: 2,
            surface_type: "asphalt",
            reading_count: 12,
            start_fraction: 0,
            end_fraction: 1,
          },
        ],
      },
    });

    const segments = await createPlannerApi().getRouteQuality(points, 2);

    expect(routeQualityMock).toHaveBeenCalledWith({ geometry: points }, {});
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      band: "good",
      surface: "asphalt",
      score: 4.2,
      passes: 12,
      dayNumber: 2,
    });
  });

  it("threads an abort signal through to the client", async () => {
    routeQualityMock.mockResolvedValue({ data: { segments: [] } });
    const controller = new AbortController();

    await createPlannerApi().getRouteQuality(points, 1, {
      signal: controller.signal,
    });

    expect(routeQualityMock).toHaveBeenCalledWith(expect.anything(), {
      signal: controller.signal,
    });
  });

  it("returns a single no_data segment when the route isn't covered", async () => {
    routeQualityMock.mockResolvedValue({ data: { segments: [] } });

    const segments = await createPlannerApi().getRouteQuality(points, 1);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      band: "no_data",
      surface: "unknown",
      score: null,
    });
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
            opening_hours: null,
            address_street: null,
            address_city: null,
            address_postcode: null,
            address_country: null,
            cuisine: null,
            brand: null,
            osm_url: null,
            maps_url: "https://www.google.com/maps/search/?api=1&query=x",
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
            opening_hours: null,
            address_street: null,
            address_city: null,
            address_postcode: null,
            address_country: null,
            osm_url: null,
            maps_url: "https://www.google.com/maps/search/?api=1&query=x",
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

describe("plannerApi.draftRoundtrip (revision 3 §E)", () => {
  const zonesMock = vi.mocked(fetchFunZonesInBbox);
  const start = { lat: 49, lng: 15 };

  beforeEach(() => {
    routeMock.mockReset();
    zonesMock.mockReset();
  });

  function mockLoopDistances(kmPerCall: number[]) {
    let call = 0;
    routeMock.mockImplementation((body) => {
      const waypoints = (
        body as { waypoints: Array<{ lat: number; lng: number }> }
      ).waypoints;
      const km = kmPerCall[Math.min(call, kmPerCall.length - 1)]!;
      call += 1;
      return Promise.resolve({
        data: {
          geometry: waypoints,
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

  it("loops out and back to the start with a turnaround via", async () => {
    mockLoopDistances([250]);
    zonesMock.mockResolvedValue([] as never);

    const result = await createPlannerApi().draftRoundtrip(start, {
      distanceKm: 250,
      direction: "E",
      preference: "efficient_loop",
    });

    const request = routeMock.mock.calls[0]![0] as {
      waypoints: Array<{ lat: number; lng: number }>;
      options?: { preference?: string };
    };
    // start → turnaround → start; the loop mode costs like 'direct'.
    expect(request.waypoints[0]).toEqual(start);
    expect(request.waypoints.at(-1)).toEqual(start);
    expect(request.waypoints).toHaveLength(3);
    expect(request.options?.preference).toBe("direct");
    // Heading E: the turnaround sits east of the start at ~equal latitude.
    const turn = request.waypoints[1]!;
    expect(turn.lng).toBeGreaterThan(start.lng);
    expect(Math.abs(turn.lat - start.lat)).toBeLessThan(0.05);
    expect(result.reachedTargetKm).toBe(true);
    expect(result.vias.at(-1)).toMatchObject({ name: "Turnaround" });
  });

  it("measures the loop under the sidebar avoids, dialog preference winning", async () => {
    // Without the avoids the sizing/vias would come from roads the rider
    // disabled, and the post-draft live reroute (which applies them)
    // would diverge from the confirmed loop.
    mockLoopDistances([250]);
    zonesMock.mockResolvedValue([] as never);

    await createPlannerApi().draftRoundtrip(start, {
      distanceKm: 250,
      direction: "E",
      preference: "maximum_twisty",
      prefs: {
        avoid_highways: true,
        avoid_tolls: true,
        avoid_unpaved: false,
        preference: "direct",
      },
    });

    const request = routeMock.mock.calls[0]![0] as {
      options?: {
        avoid_highways?: boolean;
        avoid_tolls?: boolean;
        avoid_unpaved?: boolean;
        preference?: string;
      };
    };
    expect(request.options).toMatchObject({
      avoid_highways: true,
      avoid_tolls: true,
      avoid_unpaved: false,
      // The dialog's choice overrides the trip-wide preference in prefs.
      preference: "maximum_twisty",
    });
  });

  it("re-scales the loop once when the first measure lands far from target", async () => {
    mockLoopDistances([120, 240]);
    zonesMock.mockResolvedValue([] as never);

    const result = await createPlannerApi().draftRoundtrip(start, {
      distanceKm: 250,
      direction: "N",
      preference: "balanced",
    });

    expect(routeMock).toHaveBeenCalledTimes(2);
    expect(result.summary.distanceKm).toBe(240);
    expect(result.reachedTargetKm).toBe(true);
  });

  it("reports honestly when the loop stays short of the soft target", async () => {
    mockLoopDistances([120, 150]);
    zonesMock.mockResolvedValue([] as never);

    const result = await createPlannerApi().draftRoundtrip(start, {
      distanceKm: 400,
      direction: "S",
      preference: "direct",
    });

    expect(result.reachedTargetKm).toBe(false);
  });

  it("threads lobe Fun Zones and searches the drawn region when given", async () => {
    mockLoopDistances([260]);
    zonesMock.mockResolvedValue([
      {
        id: "z1",
        name: "Zone z1",
        composite_score: 90,
        boundary: [{ lat: 49.2, lng: 15.4 }],
      },
    ] as never);

    const result = await createPlannerApi().draftRoundtrip(start, {
      distanceKm: 250,
      direction: "E",
      preference: "maximum_twisty",
      region: [14, 48, 16, 50],
    });

    expect(zonesMock).toHaveBeenCalledWith([14, 48, 16, 50], undefined);
    expect(result.vias.map((v) => v.name)).toEqual(["Zone z1", "Turnaround"]);
    // Zone vias anchor the shape — no re-scaling second call.
    expect(routeMock).toHaveBeenCalledTimes(1);
  });
});

describe("plannerApi user route prefs (revision 3 §F)", () => {
  beforeEach(() => {
    getMeMock.mockReset();
    updateMeMock.mockReset();
  });

  const wire = {
    road_preference: "maximum_twisty",
    avoid_highways: true,
    avoid_tolls: false,
    avoid_unpaved: true,
    surfaces: ["asphalt", "gravel", "lava"],
    min_quality: "excellent_only",
  };

  it("reads saved defaults from users.preferences, dropping unknown surfaces", async () => {
    getMeMock.mockResolvedValue({
      data: { preferences: { route_prefs: wire } },
    } as never);

    const prefs = await createPlannerApi().getUserRoutePrefs();

    expect(prefs).toEqual({
      roadPreference: "maximum_twisty",
      avoidHighways: true,
      avoidTolls: false,
      avoidUnpaved: true,
      surfaces: ["asphalt", "gravel"],
      minQuality: "excellent_only",
    });
  });

  it("returns null when the rider never saved prefs", async () => {
    getMeMock.mockResolvedValue({ data: { preferences: {} } } as never);
    expect(await createPlannerApi().getUserRoutePrefs()).toBeNull();
  });

  it("persists prefs via the profile preferences merge", async () => {
    updateMeMock.mockResolvedValue({ data: {} } as never);
    await createPlannerApi().saveUserRoutePrefs({
      roadPreference: "scenic_balance",
      avoidHighways: false,
      avoidTolls: true,
      avoidUnpaved: false,
      surfaces: ["concrete"],
      minQuality: "any",
    });
    expect(updateMeMock).toHaveBeenCalledWith({
      preferences: {
        route_prefs: {
          road_preference: "scenic_balance",
          avoid_highways: false,
          avoid_tolls: true,
          avoid_unpaved: false,
          surfaces: ["concrete"],
          min_quality: "any",
        },
      },
    });
  });
});
