import { useTripStore } from "./trip";
import type { RouteResponse } from "@/lib/api";
import type { TripParameters } from "@/lib/types";

describe("useTripStore planner editing", () => {
  beforeEach(() => {
    useTripStore.setState(useTripStore.getInitialState());
  });

  it("creates a draft trip from map clicks and accumulates waypoints in the correct order", () => {
    const store = useTripStore.getState();

    store.appendPlannerWaypoint(0, { lng: 14.41, lat: 50.08 });
    store.appendPlannerWaypoint(0, { lng: 14.61, lat: 50.19 });

    const firstDay = useTripStore.getState().activeTrip?.days[0];
    expect(firstDay?.waypoints.map((waypoint) => waypoint.type)).toEqual([
      "start",
      "end",
    ]);
    // Geometry is now driven exclusively by applyRouteResult (live routing
    // hook). appendPlannerWaypoint no longer synthesises geometry.
    expect(firstDay?.routeGeometry).toBeUndefined();
    expect(firstDay?.distanceKm).toBe(0);

    useTripStore
      .getState()
      .appendPlannerWaypoint(0, { lng: 14.52, lat: 50.24 });

    const updatedDay = useTripStore.getState().activeTrip?.days[0];
    expect(updatedDay?.waypoints.map((waypoint) => waypoint.type)).toEqual([
      "start",
      "via",
      "end",
    ]);
    // Still no geometry until the live routing hook calls applyRouteResult.
    expect(updatedDay?.routeGeometry).toBeUndefined();
  });

  it("lets riders undo the very first draft-creation click sequence", () => {
    const store = useTripStore.getState();

    store.appendPlannerWaypoint(0, { lng: 14.41, lat: 50.08 });
    expect(useTripStore.getState().activeTrip).not.toBeNull();
    expect(useTripStore.getState().canUndo).toBe(true);

    useTripStore.getState().undo();
    expect(useTripStore.getState().activeTrip).toBeNull();
    expect(useTripStore.getState().canRedo).toBe(true);

    useTripStore.getState().redo();
    expect(useTripStore.getState().activeTrip?.days[0]?.waypoints).toHaveLength(
      1,
    );
  });

  it("uses the current planner parameters when map clicks create and extend a draft", () => {
    const store = useTripStore.getState();
    const parameters: TripParameters = {
      days: 2,
      dailyKmTarget: 180,
      roadPreference: "direct",
      surfacePreference: ["gravel"],
      avoidHighways: false,
      avoidTolls: true,
      avoidUnpaved: false,
      minQuality: 4,
    };

    store.appendPlannerWaypoint(0, { lng: 14.41, lat: 50.08 }, parameters);
    store.appendPlannerWaypoint(0, { lng: 14.61, lat: 50.19 }, parameters);

    const activeTrip = useTripStore.getState().activeTrip;
    expect(activeTrip?.parameters).toEqual(parameters);
    // Geometry is driven by applyRouteResult (live routing hook) — not
    // synthesised by appendPlannerWaypoint regardless of roadPreference.
    expect(activeTrip?.days[0]?.routeGeometry).toBeUndefined();
    // Waypoints were appended in the correct start/end order.
    expect(activeTrip?.days[0]?.waypoints.map((w) => w.type)).toEqual([
      "start",
      "end",
    ]);
  });

  it("reorders intermediate waypoints and supports undo/redo", () => {
    const store = useTripStore.getState();

    store.appendPlannerWaypoint(0, { lng: 14.41, lat: 50.08 });
    store.appendPlannerWaypoint(0, { lng: 14.81, lat: 50.28 });
    store.appendPlannerWaypoint(0, { lng: 14.53, lat: 50.16 });
    store.appendPlannerWaypoint(0, { lng: 14.65, lat: 50.22 });

    expect(
      useTripStore
        .getState()
        .activeTrip?.days[0]?.waypoints.map((waypoint) => ({
          type: waypoint.type,
          lng: waypoint.location.lng,
        })),
    ).toEqual([
      { type: "start", lng: 14.41 },
      { type: "via", lng: 14.53 },
      { type: "via", lng: 14.65 },
      { type: "end", lng: 14.81 },
    ]);

    useTripStore.getState().reorderWaypoints(0, 2, 1);

    expect(useTripStore.getState().canUndo).toBe(true);
    expect(
      useTripStore
        .getState()
        .activeTrip?.days[0]?.waypoints.map((waypoint) => ({
          type: waypoint.type,
          lng: waypoint.location.lng,
        })),
    ).toEqual([
      { type: "start", lng: 14.41 },
      { type: "via", lng: 14.65 },
      { type: "via", lng: 14.53 },
      { type: "end", lng: 14.81 },
    ]);

    useTripStore.getState().undo();
    expect(useTripStore.getState().canRedo).toBe(true);
    expect(
      useTripStore
        .getState()
        .activeTrip?.days[0]?.waypoints.map((waypoint) => ({
          type: waypoint.type,
          lng: waypoint.location.lng,
        })),
    ).toEqual([
      { type: "start", lng: 14.41 },
      { type: "via", lng: 14.53 },
      { type: "via", lng: 14.65 },
      { type: "end", lng: 14.81 },
    ]);

    useTripStore.getState().redo();
    expect(
      useTripStore
        .getState()
        .activeTrip?.days[0]?.waypoints.map((waypoint) => ({
          type: waypoint.type,
          lng: waypoint.location.lng,
        })),
    ).toEqual([
      { type: "start", lng: 14.41 },
      { type: "via", lng: 14.65 },
      { type: "via", lng: 14.53 },
      { type: "end", lng: 14.81 },
    ]);
  });

  it("clears focused and hovered segments when undoing or redoing", () => {
    const store = useTripStore.getState();

    store.appendPlannerWaypoint(0, { lng: 14.41, lat: 50.08 });
    store.appendPlannerWaypoint(0, { lng: 14.61, lat: 50.19 });

    useTripStore.setState({
      focusedSegmentId: "seg-1",
      hoveredSegmentId: "seg-2",
    });

    useTripStore.getState().undo();
    expect(useTripStore.getState().focusedSegmentId).toBeNull();
    expect(useTripStore.getState().hoveredSegmentId).toBeNull();

    useTripStore.setState({
      focusedSegmentId: "seg-3",
      hoveredSegmentId: "seg-4",
    });

    useTripStore.getState().redo();
    expect(useTripStore.getState().focusedSegmentId).toBeNull();
    expect(useTripStore.getState().hoveredSegmentId).toBeNull();
  });

  it("moves an existing routing waypoint and updates its position without re-synthesising geometry", () => {
    const store = useTripStore.getState();

    store.appendPlannerWaypoint(0, { lng: 14.41, lat: 50.08 });
    store.appendPlannerWaypoint(0, { lng: 14.61, lat: 50.19 });

    const beforeMove = useTripStore.getState().activeTrip?.days[0];
    const startWaypoint = beforeMove?.waypoints[0];
    expect(startWaypoint?.type).toBe("start");
    expect(startWaypoint?.id).toBeDefined();
    // No synthetic geometry; it starts undefined and only applyRouteResult
    // sets it.
    expect(beforeMove?.routeGeometry).toBeUndefined();

    useTripStore
      .getState()
      .moveWaypoint(0, startWaypoint!.id, { lng: 14.5, lat: 50.12 });

    const afterMove = useTripStore.getState().activeTrip?.days[0];
    // The waypoint position was updated.
    expect(afterMove?.waypoints[0]?.location).toEqual({
      lng: 14.5,
      lat: 50.12,
    });
    expect(afterMove?.waypoints[0]?.id).toBe(startWaypoint!.id);
    // Geometry is left untouched (still undefined) — the live routing hook
    // will call applyRouteResult once the server responds.
    expect(afterMove?.routeGeometry).toBeUndefined();
    expect(useTripStore.getState().canUndo).toBe(true);

    useTripStore.getState().undo();
    const restored = useTripStore.getState().activeTrip?.days[0];
    expect(restored?.waypoints[0]?.location).toEqual({
      lng: 14.41,
      lat: 50.08,
    });
  });

  it("ignores moveWaypoint calls that do not match an existing waypoint or change location", () => {
    const store = useTripStore.getState();

    store.appendPlannerWaypoint(0, { lng: 14.41, lat: 50.08 });
    store.appendPlannerWaypoint(0, { lng: 14.61, lat: 50.19 });

    const tripBefore = useTripStore.getState().activeTrip;
    const undoBefore = useTripStore.getState().undoStack.length;

    useTripStore
      .getState()
      .moveWaypoint(0, "missing-id", { lng: 14.5, lat: 50.12 });
    expect(useTripStore.getState().activeTrip).toBe(tripBefore);
    expect(useTripStore.getState().undoStack).toHaveLength(undoBefore);

    const startWaypoint = tripBefore?.days[0]?.waypoints[0];
    useTripStore
      .getState()
      .moveWaypoint(0, startWaypoint!.id, startWaypoint!.location);
    expect(useTripStore.getState().activeTrip).toBe(tripBefore);
    expect(useTripStore.getState().undoStack).toHaveLength(undoBefore);
  });

  it("rebuilds the moved waypoint's day with the supplied planner parameters", () => {
    const store = useTripStore.getState();

    // Seed the trip with one set of parameters so we can prove the
    // rebuild uses the *fresh* params passed alongside the move, not
    // the trip's persisted ones.
    const initialParameters: TripParameters = {
      days: 1,
      dailyKmTarget: 200,
      roadPreference: "direct",
      surfacePreference: ["asphalt"],
      avoidHighways: true,
      avoidTolls: false,
      avoidUnpaved: true,
      minQuality: 3,
    };
    store.appendPlannerWaypoint(
      0,
      { lng: 14.41, lat: 50.08 },
      initialParameters,
    );
    store.appendPlannerWaypoint(
      0,
      { lng: 14.61, lat: 50.19 },
      initialParameters,
    );

    const startWaypoint =
      useTripStore.getState().activeTrip?.days[0]?.waypoints[0];
    expect(startWaypoint).toBeDefined();

    const updatedParameters: TripParameters = {
      ...initialParameters,
      roadPreference: "curvy",
      minQuality: 4,
      dailyKmTarget: 320,
    };

    useTripStore
      .getState()
      .moveWaypoint(
        0,
        startWaypoint!.id,
        { lng: 14.5, lat: 50.12 },
        updatedParameters,
      );

    const after = useTripStore.getState().activeTrip;
    expect(after?.parameters).toEqual({ ...updatedParameters, days: 1 });
    expect(after?.days[0]?.waypoints[0]?.location).toEqual({
      lng: 14.5,
      lat: 50.12,
    });
  });

  it("preserves existing route geometry when adding stop suggestions", () => {
    useTripStore.setState({
      activeTrip: {
        id: "trip-1",
        name: "Imported trip",
        status: "draft",
        num_days: 1,
        createdAt: "2026-04-01T09:00:00Z",
        updatedAt: "2026-04-14T09:00:00Z",
        parameters: {
          days: 1,
          dailyKmTarget: 240,
          roadPreference: "curvy",
          surfacePreference: ["asphalt"],
          avoidHighways: true,
          avoidTolls: false,
          avoidUnpaved: true,
          minQuality: 3,
        },
        collaborators: [],
        days: [
          {
            dayNumber: 1,
            title: "Imported day",
            distanceKm: 248,
            durationMinutes: 360,
            elevationGain: 2640,
            avgQuality: 4.1,
            routeGeometry: {
              type: "LineString",
              coordinates: [
                [10.37, 46.47],
                [10.42, 46.5],
                [10.57, 46.61],
              ],
            },
            segments: [
              {
                id: "seg-1",
                dayNumber: 1,
                orderInDay: 1,
                distanceKm: 12,
                qualityScore: 4.2,
                qualityTier: "good",
                surfaceType: "asphalt",
                curvinessScore: 78,
                elevationProfile: [],
                photos: [],
                activeHazards: [],
              },
            ],
            waypoints: [
              {
                id: "start",
                name: "Bormio",
                location: { lat: 46.47, lng: 10.37 },
                type: "start",
              },
              {
                id: "end",
                name: "Prato allo Stelvio",
                location: { lat: 46.61, lng: 10.57 },
                type: "end",
              },
            ],
          },
        ],
      },
    });

    const originalDay = useTripStore.getState().activeTrip?.days[0];

    useTripStore.getState().addWaypoint(0, {
      id: "stay-1",
      name: "Hotel Stelvio",
      location: { lat: 46.62, lng: 10.58 },
      type: "accommodation",
    });

    useTripStore.getState().insertWaypointBeforeEnd(0, {
      id: "fuel-1",
      name: "Fuel stop",
      location: { lat: 46.53, lng: 10.45 },
      type: "fuel",
    });
    useTripStore.getState().removeWaypoint(0, "stay-1");

    const updatedDay = useTripStore.getState().activeTrip?.days[0];
    expect(updatedDay?.routeGeometry).toEqual(originalDay?.routeGeometry);
    expect(updatedDay?.distanceKm).toBe(originalDay?.distanceKm);
    expect(updatedDay?.durationMinutes).toBe(originalDay?.durationMinutes);
    expect(updatedDay?.segments).toEqual(originalDay?.segments);
    expect(updatedDay?.waypoints.map((waypoint) => waypoint.id)).toEqual([
      "start",
      "fuel-1",
      "end",
    ]);
  });

  it("caps undo history so long edit sessions do not grow unbounded", () => {
    const store = useTripStore.getState();

    for (let index = 0; index < 60; index++) {
      store.appendPlannerWaypoint(0, {
        lng: 14.41 + index * 0.001,
        lat: 50.08 + index * 0.001,
      });
    }

    expect(useTripStore.getState().undoStack).toHaveLength(50);
    expect(useTripStore.getState().canUndo).toBe(true);
  });
});

describe("useTripStore server-driven route geometry (Task 9)", () => {
  beforeEach(() => useTripStore.getState().resetForTest?.());

  it("places start then end then via in routing order", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 3, lng: 3 }, "set-end");
    s.placeWaypoint({ lat: 2, lng: 2 }, "add-via");
    expect(useTripStore.getState().routingWaypoints()).toEqual([
      { lat: 1, lng: 1 },
      { lat: 2, lng: 2 },
      { lat: 3, lng: 3 },
    ]);
  });

  it("applyRouteResult writes geometry + distance to the active day", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 2, lng: 2 }, "set-end");
    s.applyRouteResult({
      geometry: [
        { lat: 1, lng: 1 },
        { lat: 2, lng: 2 },
      ],
      distance_km: 12.3,
      duration_min: 20,
      avg_quality: 4,
      curviness_score: 5,
      elevation_gain_m: 100,
      surface_mix: {},
    } as never as RouteResponse);
    const day = useTripStore.getState().activeTrip!.days[0];
    expect(day!.distanceKm).toBe(12.3);
    expect(day!.routeGeometry?.coordinates.length).toBe(2);
  });

  it("set-new-start replaces the existing start, never duplicates it", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 3, lng: 3 }, "set-end");

    // Replace start with a new location
    s.placeWaypoint({ lat: 9, lng: 9 }, "set-new-start");

    const waypoints = useTripStore.getState().activeTrip!.days[0]!.waypoints;
    const starts = waypoints.filter((w) => w.type === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.location).toEqual({ lat: 9, lng: 9 });

    // routingWaypoints() reflects the updated start
    expect(useTripStore.getState().routingWaypoints()).toEqual([
      { lat: 9, lng: 9 },
      { lat: 3, lng: 3 },
    ]);
  });

  it("set-new-end replaces the existing end, never duplicates it", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 3, lng: 3 }, "set-end");

    // Replace end with a new location
    s.placeWaypoint({ lat: 9, lng: 9 }, "set-new-end");

    const waypoints = useTripStore.getState().activeTrip!.days[0]!.waypoints;
    const ends = waypoints.filter((w) => w.type === "end");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.location).toEqual({ lat: 9, lng: 9 });

    // routingWaypoints() reflects the updated end
    expect(useTripStore.getState().routingWaypoints()).toEqual([
      { lat: 1, lng: 1 },
      { lat: 9, lng: 9 },
    ]);
  });

  it("saveWaypoints returns ordered {lat,lng,name?,type} for ALL waypoints including stops", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 3, lng: 3 }, "set-end");
    s.placeWaypoint({ lat: 2, lng: 2 }, "add-via");
    // Insert a fuel stop before end — non-routing stop must appear in save payload.
    useTripStore.getState().insertWaypointBeforeEnd(0, {
      id: "fuel-1",
      type: "fuel",
      name: "Gas station",
      location: { lat: 2.5, lng: 2.5 },
    });

    const saved = useTripStore.getState().saveWaypoints();
    expect(saved).toHaveLength(4);

    // Correct ordering: start → via → fuel → end
    expect(saved[0]!.type).toBe("start");
    expect(saved[0]!.lat).toBe(1);
    expect(saved[0]!.lng).toBe(1);

    expect(saved[1]!.type).toBe("via");
    expect(saved[1]!.lat).toBe(2);
    expect(saved[1]!.lng).toBe(2);

    expect(saved[2]!.type).toBe("fuel");
    expect(saved[2]!.lat).toBe(2.5);
    expect(saved[2]!.lng).toBe(2.5);
    expect(saved[2]!.name).toBe("Gas station");

    expect(saved[3]!.type).toBe("end");
    expect(saved[3]!.lat).toBe(3);
    expect(saved[3]!.lng).toBe(3);

    // name field is present on each entry (may be undefined for via)
    expect("name" in saved[0]!).toBe(true);
    expect("name" in saved[1]!).toBe(true);
    expect("name" in saved[2]!).toBe(true);
    expect("name" in saved[3]!).toBe(true);
  });

  it("saveWaypoints maps local rest→food and accommodation→hotel to canonical backend types", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 5, lng: 5 }, "set-end");

    // Insert a rest stop (local type) — should serialize as "food"
    useTripStore.getState().insertWaypointBeforeEnd(0, {
      id: "rest-1",
      type: "rest",
      name: "Cafe",
      location: { lat: 2, lng: 2 },
    });
    // Insert an accommodation stop (local type) — should serialize as "hotel"
    useTripStore.getState().insertWaypointBeforeEnd(0, {
      id: "hotel-1",
      type: "accommodation",
      name: "Overnight hotel",
      location: { lat: 3, lng: 3 },
    });

    const saved = useTripStore.getState().saveWaypoints();
    // Ordering: start → rest → accommodation → end
    expect(saved).toHaveLength(4);
    expect(saved[0]!.type).toBe("start");
    // Local "rest" maps to canonical "food"
    expect(saved[1]!.type).toBe("food");
    expect(saved[1]!.name).toBe("Cafe");
    // Local "accommodation" maps to canonical "hotel"
    expect(saved[2]!.type).toBe("hotel");
    expect(saved[2]!.name).toBe("Overnight hotel");
    expect(saved[3]!.type).toBe("end");
  });

  it("removeWaypointById removes a via and leaves start and end intact", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 3, lng: 3 }, "set-end");
    s.placeWaypoint({ lat: 2, lng: 2 }, "add-via");

    const waypoints = useTripStore.getState().activeTrip!.days[0]!.waypoints;
    const via = waypoints.find((w) => w.type === "via")!;
    expect(via).toBeDefined();

    useTripStore.getState().removeWaypointById(via.id);

    const after = useTripStore.getState().activeTrip!.days[0]!.waypoints;
    expect(after.find((w) => w.id === via.id)).toBeUndefined();
    expect(after.filter((w) => w.type === "start")).toHaveLength(1);
    expect(after.filter((w) => w.type === "end")).toHaveLength(1);

    // routingWaypoints is now just start → end
    expect(useTripStore.getState().routingWaypoints()).toEqual([
      { lat: 1, lng: 1 },
      { lat: 3, lng: 3 },
    ]);
  });

  it("setWaypointType changes the type of a waypoint on day 0", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 3, lng: 3 }, "set-end");
    s.placeWaypoint({ lat: 2, lng: 2 }, "add-via");

    const waypoints = useTripStore.getState().activeTrip!.days[0]!.waypoints;
    const via = waypoints.find((w) => w.type === "via")!;
    expect(via).toBeDefined();

    useTripStore.getState().setWaypointType(via.id, "accommodation");

    const after = useTripStore.getState().activeTrip!.days[0]!.waypoints;
    const updated = after.find((w) => w.id === via.id)!;
    expect(updated.type).toBe("accommodation");

    // start and end types must be unchanged
    expect(after.find((w) => w.type === "start")).toBeDefined();
    expect(after.find((w) => w.type === "end")).toBeDefined();
  });
});
