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
    s.applyRouteResult(1, {
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

  it("saveDays drops empty days, renumbers, and maps waypoint types", () => {
    const s = useTripStore.getState();
    // Build a 3-day trip: day 1 has waypoints, day 2 is empty, day 3 has waypoints.
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 2, lng: 2 }, "set-end");
    s.addDay(); // day 2 linked from day 1 end → has a seeded start waypoint (non-empty)
    // Clear day 2 waypoints to make it empty
    const tripWithEmptyDay2 = useTripStore.getState().activeTrip!;
    useTripStore.setState({
      activeTrip: {
        ...tripWithEmptyDay2,
        days: [
          tripWithEmptyDay2.days[0]!, // day 1: has start + end
          { ...tripWithEmptyDay2.days[1]!, waypoints: [] }, // day 2: empty
          {
            dayNumber: 3,
            title: "Day 3",
            waypoints: [
              {
                id: "d3-start",
                name: "Lausanne",
                type: "start",
                location: { lat: 46.52, lng: 6.63 },
              },
              {
                id: "d3-end",
                name: "Geneva",
                type: "end",
                location: { lat: 46.2, lng: 6.15 },
              },
            ],
            distanceKm: 0,
            durationMinutes: 0,
            elevationGain: 0,
            avgQuality: 0,
            segments: [],
            startLinked: true,
          },
        ],
      },
    });

    const result = useTripStore.getState().saveDays();

    // Only 2 days should be returned (empty day 2 dropped).
    expect(result).toHaveLength(2);

    // Day numbers renumbered contiguously 1..2.
    expect(result[0]!.dayNumber).toBe(1);
    expect(result[1]!.dayNumber).toBe(2);

    // startLinked is RECONCILED against the filtered predecessor: old day 3 was
    // linked to day 2, but day 2 was empty and dropped, so the link is cleared
    // (its seeded start no longer mirrors the new predecessor, day 1's end).
    expect(result[0]!.startLinked).toBe(false); // day 1: never linked
    expect(result[1]!.startLinked).toBe(false); // old day 3: predecessor dropped → cleared

    // Day 1 waypoints mapped correctly.
    expect(result[0]!.waypoints).toHaveLength(2);
    expect(result[0]!.waypoints[0]!.type).toBe("start");
    expect(result[0]!.waypoints[1]!.type).toBe("end");

    // Day 2 (old day 3) waypoints mapped correctly.
    expect(result[1]!.waypoints).toHaveLength(2);
    expect(result[1]!.waypoints[0]!.lat).toBe(46.52);
    expect(result[1]!.waypoints[1]!.lat).toBe(46.2);
  });

  it("saveDays keeps startLinked when the linked predecessor survives", () => {
    const s = useTripStore.getState();
    // 3 complete days, day 3 linked to the surviving day 2 — link must persist.
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 2, lng: 2 }, "set-end");
    s.addDay();
    useTripStore.setState({ selectedDayIndex: 1 });
    s.placeWaypoint({ lat: 20, lng: 20 }, "set-end"); // day 2 complete
    s.addDay();
    useTripStore.setState({ selectedDayIndex: 2 });
    s.placeWaypoint({ lat: 30, lng: 30 }, "set-end"); // day 3 complete, linked to day 2

    const result = useTripStore.getState().saveDays();
    expect(result).toHaveLength(3);
    expect(result[2]!.startLinked).toBe(true); // predecessor (day 2) survived
  });

  it("editing a Day 1 via does not re-stale a linked Day 2 (end unchanged)", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 2, lng: 2 }, "set-end"); // day 1 end (2,2)
    s.addDay(); // day 2 linked, start seeded from (2,2)
    useTripStore.setState({ selectedDayIndex: 1 });
    s.placeWaypoint({ lat: 20, lng: 20 }, "set-end"); // day 2 complete
    useTripStore.setState({ stalePreviewDays: [], selectedDayIndex: 0 });

    // Edit a via on day 1 — its END (2,2) does not move.
    s.placeWaypoint({ lat: 1.5, lng: 1.5 }, "add-via");

    const stale = useTripStore.getState().stalePreviewDays;
    expect(stale).toContain(1); // day 1 was edited
    expect(stale).not.toContain(2); // day 2's linked start still matches → not re-staled
  });

  it("undo restores stale flags only for routable days", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 2, lng: 2 }, "set-end"); // day 1 routable
    s.addDay(); // day 2: seeded start only — 1 routing wp, NOT routable
    useTripStore.setState({ selectedDayIndex: 0 });
    s.placeWaypoint({ lat: 1.5, lng: 1.5 }, "add-via"); // edit day 1 (snapshot)

    s.undo(); // restores { day 1: start+end, day 2: start-only }

    const stale = useTripStore.getState().stalePreviewDays;
    expect(stale).toContain(1); // day 1 routable
    expect(stale).not.toContain(2); // day 2 (start only) excluded
  });

  it("undo back to a clean loaded trip leaves no stale days", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 2, lng: 2 }, "set-end"); // day 1 routable
    // "Load" it as a clean saved trip: setActiveTrip resets routeDirty + stale
    // + the undo stack, so the next edit captures a CLEAN (dirty=false) snapshot.
    s.setActiveTrip(useTripStore.getState().activeTrip!);
    expect(useTripStore.getState().routeDirty).toBe(false);

    s.placeWaypoint({ lat: 1.5, lng: 1.5 }, "add-via");
    expect(useTripStore.getState().routeDirty).toBe(true);

    s.undo(); // back to the clean loaded route
    // routeDirty restored to false → the live hook won't run, so there must be
    // NO stale flags left to orphan the next edit's Save gate.
    expect(useTripStore.getState().routeDirty).toBe(false);
    expect(useTripStore.getState().stalePreviewDays).toEqual([]);
  });

  it("saveDays maps rest→food and accommodation→hotel types", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 5, lng: 5 }, "set-end");
    useTripStore.getState().insertWaypointBeforeEnd(0, {
      id: "rest-1",
      type: "rest",
      name: "Cafe",
      location: { lat: 2, lng: 2 },
    });
    useTripStore.getState().insertWaypointBeforeEnd(0, {
      id: "hotel-1",
      type: "accommodation",
      name: "Hotel",
      location: { lat: 3, lng: 3 },
    });

    const result = useTripStore.getState().saveDays();

    expect(result).toHaveLength(1);
    const wps = result[0]!.waypoints;
    const restWp = wps.find((w) => w.name === "Cafe");
    const hotelWp = wps.find((w) => w.name === "Hotel");
    expect(restWp!.type).toBe("food");
    expect(hotelWp!.type).toBe("hotel");
  });

  it("saveDays returns [] when activeTrip is null", () => {
    useTripStore.getState().setActiveTrip(null);
    expect(useTripStore.getState().saveDays()).toEqual([]);
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

describe("useTripStore selectedDayIndex + stalePreviewDays (Task 6)", () => {
  beforeEach(() => useTripStore.getState().resetForTest?.());

  it("tracks selectedDayIndex and resets it + stale days on setActiveTrip", () => {
    const s = useTripStore.getState();
    s.setSelectedDay(2);
    expect(useTripStore.getState().selectedDayIndex).toBe(2);

    // Seed a 1-day trip fixture and call setActiveTrip.
    const oneDay = {
      id: "trip-1",
      name: "One-day trip",
      status: "draft" as const,
      num_days: 1,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      parameters: {
        days: 1,
        dailyKmTarget: 200,
        roadPreference: "mixed" as const,
        surfacePreference: ["asphalt" as const],
        avoidHighways: true,
        avoidTolls: false,
        avoidUnpaved: true,
        minQuality: 3,
      },
      collaborators: [],
      days: [
        {
          dayNumber: 1,
          waypoints: [],
          distanceKm: 0,
          durationMinutes: 0,
          elevationGain: 0,
          avgQuality: 0,
        },
      ],
    };
    s.setActiveTrip(oneDay);
    expect(useTripStore.getState().selectedDayIndex).toBe(0);
    expect(useTripStore.getState().stalePreviewDays).toEqual([]);
  });

  it("markRouteDirty marks all active trip days stale", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 5, lng: 5 }, "set-end");
    // Reset stale list to test markRouteDirty specifically.
    useTripStore.setState({ stalePreviewDays: [] });
    s.markRouteDirty();
    // Day 1 should be marked stale (the only day in the draft).
    expect(useTripStore.getState().stalePreviewDays).toContain(1);
  });

  it("markRouteDirty skips unroutable days so an empty day can't wedge the save gate", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 2, lng: 2 }, "set-end"); // day 1: routable
    s.addDay(); // day 2: linked start only — 1 routing wp, NOT routable
    useTripStore.setState({ stalePreviewDays: [] });

    s.markRouteDirty();

    // Only day 1 (>=2 routing waypoints) is marked. Day 2 has a single start —
    // the live hook bails for <2 routing waypoints, so marking it would leave a
    // stale flag that never clears and keeps Save route disabled.
    expect(useTripStore.getState().stalePreviewDays).toEqual([1]);
  });

  it("places a waypoint on the selected day, not day 0", () => {
    const s = useTripStore.getState();

    // Seed a 2-day trip with day 1 and day 2 (dayNumbers 1 and 2).
    useTripStore.setState({
      activeTrip: {
        id: "trip-2day",
        name: "Two-day trip",
        status: "draft",
        num_days: 2,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        parameters: {
          days: 2,
          dailyKmTarget: 200,
          roadPreference: "mixed",
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
            title: "Day 1",
            waypoints: [],
            distanceKm: 0,
            durationMinutes: 0,
            elevationGain: 0,
            avgQuality: 0,
            segments: [],
          },
          {
            dayNumber: 2,
            title: "Day 2",
            waypoints: [],
            distanceKm: 0,
            durationMinutes: 0,
            elevationGain: 0,
            avgQuality: 0,
            segments: [],
          },
        ],
      },
      selectedDayIndex: 1,
      stalePreviewDays: [],
    });

    // Place a start waypoint — should land on day index 1 (dayNumber 2).
    s.placeWaypoint({ lat: 10, lng: 10 }, "set-start");

    const state = useTripStore.getState();
    const day0 = state.activeTrip!.days[0]!;
    const day1 = state.activeTrip!.days[1]!;

    // Day index 1 (dayNumber 2) should have the new waypoint.
    expect(day1.waypoints).toHaveLength(1);
    expect(day1.waypoints[0]!.type).toBe("start");
    expect(day1.waypoints[0]!.location).toEqual({ lat: 10, lng: 10 });

    // Day index 0 (dayNumber 1) must be untouched.
    expect(day0.waypoints).toHaveLength(0);

    // Day 2 (dayNumber 2) is now stale.
    expect(state.stalePreviewDays).toContain(2);
  });

  it("applyRouteResult(dayNumber, result) writes geometry to the targeted day and clears its staleness", () => {
    const s = useTripStore.getState();

    // Seed a 2-day trip with day 2 pre-marked stale.
    useTripStore.setState({
      activeTrip: {
        id: "trip-2day",
        name: "Two-day trip",
        status: "draft",
        num_days: 2,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        parameters: {
          days: 2,
          dailyKmTarget: 200,
          roadPreference: "mixed",
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
            title: "Day 1",
            waypoints: [
              {
                id: "w1",
                name: "Start",
                location: { lat: 1, lng: 1 },
                type: "start",
              },
              {
                id: "w2",
                name: "Finish",
                location: { lat: 2, lng: 2 },
                type: "end",
              },
            ],
            distanceKm: 10,
            durationMinutes: 20,
            elevationGain: 100,
            avgQuality: 4,
            segments: [],
          },
          {
            dayNumber: 2,
            title: "Day 2",
            waypoints: [
              {
                id: "w3",
                name: "Start",
                location: { lat: 5, lng: 5 },
                type: "start",
              },
              {
                id: "w4",
                name: "Finish",
                location: { lat: 6, lng: 6 },
                type: "end",
              },
            ],
            distanceKm: 0,
            durationMinutes: 0,
            elevationGain: 0,
            avgQuality: 0,
            segments: [],
          },
        ],
      },
      stalePreviewDays: [2],
      selectedDayIndex: 0,
    });

    // Apply a route result targeting day 2 by dayNumber.
    s.applyRouteResult(2, {
      geometry: [
        { lat: 5, lng: 5 },
        { lat: 6, lng: 6 },
      ],
      distance_km: 55,
      duration_min: 70,
      avg_quality: 4.2,
      curviness_score: 60,
      elevation_gain_m: 300,
      surface_mix: {},
    } as never as RouteResponse);

    const state = useTripStore.getState();
    const day1 = state.activeTrip!.days[0]!; // dayNumber 1
    const day2 = state.activeTrip!.days[1]!; // dayNumber 2

    // Day 2 should have the new geometry.
    expect(day2.routeGeometry).toBeDefined();
    expect(day2.routeGeometry?.coordinates.length).toBe(2);
    expect(day2.distanceKm).toBe(55);
    expect(day2.durationMinutes).toBe(70);

    // Day 1 must be unchanged.
    expect(day1.distanceKm).toBe(10);
    expect(day1.routeGeometry).toBeUndefined();

    // Day 2's staleness is cleared.
    expect(state.stalePreviewDays).not.toContain(2);
  });
});

describe("useTripStore routeDirty flag", () => {
  beforeEach(() => useTripStore.getState().resetForTest?.());

  it("starts as false and is reset to false by setActiveTrip", () => {
    expect(useTripStore.getState().routeDirty).toBe(false);

    // Set to true via a mutation, then reset via setActiveTrip
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    expect(useTripStore.getState().routeDirty).toBe(true);

    useTripStore.getState().setActiveTrip(null);
    expect(useTripStore.getState().routeDirty).toBe(false);
  });

  it("markRouteDirty sets routeDirty to true", () => {
    expect(useTripStore.getState().routeDirty).toBe(false);
    useTripStore.getState().markRouteDirty();
    expect(useTripStore.getState().routeDirty).toBe(true);
  });

  it("appendPlannerWaypoint sets routeDirty true", () => {
    useTripStore
      .getState()
      .appendPlannerWaypoint(0, { lng: 14.41, lat: 50.08 });
    expect(useTripStore.getState().routeDirty).toBe(true);
  });

  it("placeWaypoint sets routeDirty true", () => {
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    expect(useTripStore.getState().routeDirty).toBe(true);
  });

  it("removeWaypointById sets routeDirty true", () => {
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    useTripStore.getState().placeWaypoint({ lat: 3, lng: 3 }, "set-end");
    useTripStore.getState().placeWaypoint({ lat: 2, lng: 2 }, "add-via");
    // Reset dirty to test specifically the removeWaypointById action
    useTripStore.setState({ routeDirty: false });

    const via = useTripStore
      .getState()
      .activeTrip!.days[0]!.waypoints.find((w) => w.type === "via")!;
    useTripStore.getState().removeWaypointById(via.id);
    expect(useTripStore.getState().routeDirty).toBe(true);
  });

  it("reorderWaypoints sets routeDirty true", () => {
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    useTripStore.getState().placeWaypoint({ lat: 3, lng: 3 }, "set-end");
    useTripStore.getState().placeWaypoint({ lat: 2, lng: 2 }, "add-via");
    useTripStore.setState({ routeDirty: false });

    useTripStore.getState().reorderWaypoints(0, 1, 2);
    expect(useTripStore.getState().routeDirty).toBe(true);
  });

  it("setWaypointType sets routeDirty true", () => {
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    useTripStore.getState().placeWaypoint({ lat: 3, lng: 3 }, "set-end");
    useTripStore.getState().placeWaypoint({ lat: 2, lng: 2 }, "add-via");
    useTripStore.setState({ routeDirty: false });

    const via = useTripStore
      .getState()
      .activeTrip!.days[0]!.waypoints.find((w) => w.type === "via")!;
    useTripStore.getState().setWaypointType(via.id, "fuel");
    expect(useTripStore.getState().routeDirty).toBe(true);
  });

  it("moveWaypoint sets routeDirty true on an actual location change", () => {
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    useTripStore.getState().placeWaypoint({ lat: 3, lng: 3 }, "set-end");
    useTripStore.setState({ routeDirty: false });

    const start = useTripStore
      .getState()
      .activeTrip!.days[0]!.waypoints.find((w) => w.type === "start")!;
    useTripStore.getState().moveWaypoint(0, start.id, { lat: 1.5, lng: 1.5 });
    expect(useTripStore.getState().routeDirty).toBe(true);
  });

  it("moveWaypoint does NOT set routeDirty when location is unchanged (no-op)", () => {
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    useTripStore.getState().placeWaypoint({ lat: 3, lng: 3 }, "set-end");
    useTripStore.setState({ routeDirty: false });

    const start = useTripStore
      .getState()
      .activeTrip!.days[0]!.waypoints.find((w) => w.type === "start")!;
    // Same location — no-op
    useTripStore.getState().moveWaypoint(0, start.id, { lat: 1, lng: 1 });
    expect(useTripStore.getState().routeDirty).toBe(false);
  });

  it("setActiveTrip resets routeDirty to false even when called with a non-null trip", () => {
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    expect(useTripStore.getState().routeDirty).toBe(true);

    const fakeTrip = useTripStore.getState().activeTrip!;
    useTripStore.getState().setActiveTrip(fakeTrip);
    expect(useTripStore.getState().routeDirty).toBe(false);
  });

  it("undo back to the loaded route clears routeDirty", () => {
    // Build a route, then treat it as a freshly-loaded (clean) baseline.
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    useTripStore.getState().placeWaypoint({ lat: 5, lng: 5 }, "set-end");
    const loaded = useTripStore.getState().activeTrip!;
    useTripStore.getState().setActiveTrip(loaded);
    expect(useTripStore.getState().routeDirty).toBe(false);

    // Edit → dirty.
    useTripStore.getState().placeWaypoint({ lat: 9, lng: 9 }, "add-via");
    expect(useTripStore.getState().routeDirty).toBe(true);

    // Undo back to the loaded route → routeDirty restored to false.
    useTripStore.getState().undo();
    expect(useTripStore.getState().routeDirty).toBe(false);
  });

  it("insertWaypointBeforeEnd marks the draft dirty so POI stops can be saved", () => {
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    useTripStore.getState().placeWaypoint({ lat: 5, lng: 5 }, "set-end");
    useTripStore.setState({ routeDirty: false });

    useTripStore.getState().insertWaypointBeforeEnd(0, {
      id: "fuel-1",
      type: "fuel",
      name: "Gas",
      location: { lat: 2, lng: 2 },
    });
    expect(useTripStore.getState().routeDirty).toBe(true);
  });

  it("addWaypoint marks the draft dirty so suggested stays can be saved", () => {
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    useTripStore.getState().placeWaypoint({ lat: 5, lng: 5 }, "set-end");
    useTripStore.setState({ routeDirty: false });

    useTripStore.getState().addWaypoint(0, {
      id: "stay-1",
      type: "accommodation",
      name: "Mountain inn",
      location: { lat: 3, lng: 3 },
    });
    expect(useTripStore.getState().routeDirty).toBe(true);
  });

  it("placeWaypoint seeds a new draft with the passed planner parameters", () => {
    useTripStore.getState().resetForTest?.();
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-start", {
      days: 1,
      dailyKmTarget: 400,
      roadPreference: "scenic",
      surfacePreference: [],
      avoidHighways: false,
      avoidTolls: true,
      avoidUnpaved: false,
      minQuality: 3,
    });
    const params = useTripStore.getState().activeTrip!.parameters;
    // The rider's controls flow into the new draft instead of store defaults.
    expect(params.roadPreference).toBe("scenic");
    expect(params.avoidTolls).toBe(true);
    expect(params.dailyKmTarget).toBe(400);
  });

  it("clears stale route geometry when an edit drops below 2 routing waypoints", () => {
    useTripStore.getState().resetForTest?.();
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 5, lng: 5 }, "set-end");
    // Simulate the live hook writing a real route.
    s.applyRouteResult(1, {
      geometry: [
        { lat: 1, lng: 1 },
        { lat: 5, lng: 5 },
      ],
      distance_km: 12.3,
      duration_min: 20,
      avg_quality: 4,
      curviness_score: 5,
      elevation_gain_m: 100,
      surface_mix: {},
    } as never);
    expect(
      useTripStore.getState().activeTrip!.days[0]!.routeGeometry,
    ).toBeDefined();

    // Remove the end → only the start remains → no longer routable → the stale
    // route geometry + stats are cleared (the live hook won't recompute them).
    const end = useTripStore
      .getState()
      .activeTrip!.days[0]!.waypoints.find((w) => w.type === "end")!;
    useTripStore.getState().removeWaypointById(end.id);
    const day = useTripStore.getState().activeTrip!.days[0]!;
    expect(day.routeGeometry).toBeUndefined();
    expect(day.distanceKm).toBe(0);
  });

  it("marks the preview stale on edit and fresh after applyRouteResult", () => {
    useTripStore.getState().resetForTest?.();
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 5, lng: 5 }, "set-end");
    // An edit leaves the selected day's preview stale until a fresh route lands.
    expect(useTripStore.getState().stalePreviewDays.length).toBeGreaterThan(0);

    useTripStore.getState().applyRouteResult(1, {
      geometry: [
        { lat: 1, lng: 1 },
        { lat: 5, lng: 5 },
      ],
      distance_km: 5,
      duration_min: 10,
      avg_quality: 4,
      curviness_score: 5,
      elevation_gain_m: 50,
      surface_mix: {},
    } as never);
    expect(useTripStore.getState().stalePreviewDays).toEqual([]);

    // A subsequent edit makes it stale again.
    useTripStore.getState().placeWaypoint({ lat: 2, lng: 2 }, "add-via");
    expect(useTripStore.getState().stalePreviewDays.length).toBeGreaterThan(0);
  });

  it("moveWaypoint marks the preview stale on a real move but not a no-op", () => {
    useTripStore.getState().resetForTest?.();
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 5, lng: 5 }, "set-end");
    useTripStore.setState({ stalePreviewDays: [] });
    const start = useTripStore
      .getState()
      .activeTrip!.days[0]!.waypoints.find((w) => w.type === "start")!;

    // No-op move (same location) → preview stays fresh.
    useTripStore.getState().moveWaypoint(0, start.id, { lat: 1, lng: 1 });
    expect(useTripStore.getState().stalePreviewDays).toEqual([]);

    // Real move → preview goes stale until the live hook reroutes.
    useTripStore.getState().moveWaypoint(0, start.id, { lat: 2, lng: 2 });
    expect(useTripStore.getState().stalePreviewDays.length).toBeGreaterThan(0);
  });
});

describe("useTripStore day lifecycle + overnight link sync (Task 8)", () => {
  beforeEach(() => useTripStore.getState().resetForTest?.());

  /** Helper: build a 1-day trip with a start and end waypoint on day 1. */
  function seedOneDay() {
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    useTripStore.getState().placeWaypoint({ lat: 2, lng: 2 }, "set-end");
  }

  it("addDay appends a linked day seeded from the previous end and selects it", () => {
    seedOneDay();
    useTripStore.getState().addDay();

    const state = useTripStore.getState();
    const trip = state.activeTrip!;
    expect(trip.days).toHaveLength(2);

    const day2 = trip.days[1]!;
    expect(day2.startLinked).toBe(true);
    // Start of day 2 should mirror day 1's end location (lat:2, lng:2).
    const start = day2.waypoints.find((w) => w.type === "start");
    expect(start).toBeDefined();
    expect(start!.location).toEqual({ lat: 2, lng: 2 });

    // The new day is selected.
    expect(state.selectedDayIndex).toBe(1);
    expect(state.routeDirty).toBe(true);
  });

  it("addDay is capped at 14 days", () => {
    seedOneDay();
    // Add 13 more days (starting from 1 we already have → total 14).
    for (let i = 0; i < 13; i++) {
      useTripStore.getState().addDay();
    }
    expect(useTripStore.getState().activeTrip!.days).toHaveLength(14);

    // One more addDay should be a no-op.
    useTripStore.getState().addDay();
    expect(useTripStore.getState().activeTrip!.days).toHaveLength(14);
  });

  it("editing day 1 end moves a linked day 2 start and marks both stale", () => {
    seedOneDay();
    useTripStore.getState().addDay();

    // Clear stale to isolate the next edit's effect.
    useTripStore.setState({ stalePreviewDays: [] });

    // Move day 1's end to a new location — day 2 is selected as index 1,
    // so switch back to day 1 first.
    useTripStore.setState({ selectedDayIndex: 0 });
    useTripStore.getState().placeWaypoint({ lat: 5, lng: 5 }, "set-end");

    const state = useTripStore.getState();
    const trip = state.activeTrip!;

    // Day 1's end should be updated.
    const day1End = trip.days[0]!.waypoints.find((w) => w.type === "end");
    expect(day1End!.location).toEqual({ lat: 5, lng: 5 });

    // Day 2's linked start should mirror the new end.
    const day2Start = trip.days[1]!.waypoints.find((w) => w.type === "start");
    expect(day2Start!.location).toEqual({ lat: 5, lng: 5 });

    // Both day 1 (dayNumber 1) and day 2 (dayNumber 2) should be stale.
    expect(state.stalePreviewDays).toContain(1);
    expect(state.stalePreviewDays).toContain(2);
  });

  it("placing a start on day 2 overrides the link (startLinked=false) and stops mirroring", () => {
    seedOneDay();
    useTripStore.getState().addDay();

    // Manually place a start on day 2 — overrides the link.
    useTripStore.setState({ selectedDayIndex: 1 });
    useTripStore.getState().placeWaypoint({ lat: 9, lng: 9 }, "set-start");

    const state = useTripStore.getState();
    const trip = state.activeTrip!;

    // Day 2 must no longer be linked.
    expect(trip.days[1]!.startLinked).toBe(false);

    // Now edit day 1's end — day 2's start should NOT move.
    useTripStore.setState({ selectedDayIndex: 0 });
    useTripStore.getState().placeWaypoint({ lat: 3, lng: 3 }, "set-end");

    const afterEdit = useTripStore.getState().activeTrip!;
    const day2Start = afterEdit.days[1]!.waypoints.find(
      (w) => w.type === "start",
    );
    // Still at the manually placed location, not the new day 1 end.
    expect(day2Start!.location).toEqual({ lat: 9, lng: 9 });
  });

  it("relinkDayStart re-seeds day 2 start from day 1 end and resumes mirroring", () => {
    seedOneDay();
    useTripStore.getState().addDay();

    // Break the link by placing a manual start on day 2.
    useTripStore.setState({ selectedDayIndex: 1 });
    useTripStore.getState().placeWaypoint({ lat: 9, lng: 9 }, "set-start");
    expect(useTripStore.getState().activeTrip!.days[1]!.startLinked).toBe(
      false,
    );

    // Re-link day 2 — should re-seed from day 1's end (lat:2, lng:2).
    useTripStore.getState().relinkDayStart(1);

    const state = useTripStore.getState();
    const trip = state.activeTrip!;

    expect(trip.days[1]!.startLinked).toBe(true);
    const day2Start = trip.days[1]!.waypoints.find((w) => w.type === "start");
    expect(day2Start!.location).toEqual({ lat: 2, lng: 2 });
    expect(state.routeDirty).toBe(true);
  });

  it("removeDay (middle) renumbers, clamps, and re-seeds the new day 2's linked start from day 1's end", () => {
    // Build a 3-day trip where every day has a real start + end so the
    // overnight boundary actually cascades on removal.
    seedOneDay(); // day 1: start (1,1) → end (2,2)
    useTripStore.getState().addDay(); // day 2: linked start seeded from (2,2)
    useTripStore.setState({ selectedDayIndex: 1 });
    useTripStore.getState().placeWaypoint({ lat: 20, lng: 20 }, "set-end"); // day 2 end (20,20)
    useTripStore.getState().addDay(); // day 3: linked start seeded from (20,20)
    useTripStore.setState({ selectedDayIndex: 2 });
    useTripStore.getState().placeWaypoint({ lat: 30, lng: 30 }, "set-end"); // day 3 end (30,30)

    const beforeRemove = useTripStore.getState().activeTrip!;
    expect(beforeRemove.days).toHaveLength(3);
    expect(beforeRemove.days[2]!.startLinked).toBe(true);

    // Remove the MIDDLE day (index 1, the (?,?)→(20,20) day).
    useTripStore.getState().removeDay(1);

    const state = useTripStore.getState();
    const trip = state.activeTrip!;

    // Should now have 2 days, renumbered 1 and 2.
    expect(trip.days).toHaveLength(2);
    expect(trip.days[0]!.dayNumber).toBe(1);
    expect(trip.days[1]!.dayNumber).toBe(2);

    // The new day 2 was the old day 3 (linked) — its start must re-seed to the
    // new predecessor's (old day 1) END location (2,2), not the removed day's end.
    expect(trip.days[1]!.startLinked).toBe(true);
    const newDay2Start = trip.days[1]!.waypoints.find(
      (w) => w.type === "start",
    );
    expect(newDay2Start!.location).toEqual({ lat: 2, lng: 2 });

    // selectedDayIndex must be clamped to the new length.
    expect(state.selectedDayIndex).toBeLessThan(2);
    expect(state.routeDirty).toBe(true);
  });

  it("removeDay(0) clears the dangling link on the new first day", () => {
    seedOneDay();
    useTripStore.getState().addDay(); // day 2 startLinked=true
    expect(useTripStore.getState().activeTrip!.days[1]!.startLinked).toBe(true);

    // Remove day 0 — the old day 2 becomes day 1 with no predecessor.
    useTripStore.getState().removeDay(0);

    const trip = useTripStore.getState().activeTrip!;
    expect(trip.days).toHaveLength(1);
    expect(trip.days[0]!.startLinked).toBe(false);
  });

  it("removeDay remaps stale day numbers so no orphaned flag wedges the save gate", () => {
    seedOneDay(); // day 1
    useTripStore.getState().addDay(); // day 2 (linked)
    useTripStore.getState().addDay(); // day 3 (linked)
    // Override day 3's start so removeDay won't cascade — isolates the remap.
    useTripStore.setState({ selectedDayIndex: 2 });
    useTripStore.getState().placeWaypoint({ lat: 30, lng: 30 }, "set-start");
    expect(useTripStore.getState().activeTrip!.days[2]!.startLinked).toBe(
      false,
    );

    // Day 3 is the only stale day; days 1 and 2 are fresh.
    useTripStore.setState({ stalePreviewDays: [3] });

    // Remove the MIDDLE day (index 1): old day 3 becomes day 2.
    useTripStore.getState().removeDay(1);

    // The stale flag must follow the renumber (3 → 2) with no orphaned `3`
    // left behind that no selected day could ever clear.
    expect(useTripStore.getState().stalePreviewDays).toEqual([2]);
    expect(useTripStore.getState().activeTrip!.days).toHaveLength(2);
  });

  it("moveWaypoint marks the DRAGGED day stale and cascades a moved end to the linked next day", () => {
    seedOneDay(); // day 1: start (1,1) → end (2,2)
    useTripStore.getState().addDay(); // day 2: linked start seeded from (2,2)
    useTripStore.setState({ selectedDayIndex: 1 });
    useTripStore.getState().placeWaypoint({ lat: 20, lng: 20 }, "set-end"); // day 2 end

    // Selected day is 2, but we drag DAY 1's end — the dragged day must be the
    // one marked stale, and the linked day 2 must cascade.
    useTripStore.setState({ stalePreviewDays: [], selectedDayIndex: 1 });
    const day1End = useTripStore
      .getState()
      .activeTrip!.days[0]!.waypoints.find((w) => w.type === "end")!;
    useTripStore.getState().moveWaypoint(0, day1End.id, { lat: 5, lng: 5 });

    const state = useTripStore.getState();
    // Day 1 (dragged) is stale even though day 2 is selected.
    expect(state.stalePreviewDays).toContain(1);
    // Day 2 (linked) cascaded: stale + its start re-seeded to the new end.
    expect(state.stalePreviewDays).toContain(2);
    const day2Start = state.activeTrip!.days[1]!.waypoints.find(
      (w) => w.type === "start",
    )!;
    expect(day2Start.location).toEqual({ lat: 5, lng: 5 });
  });

  it("setWaypointType promoting a via→start on day 2 breaks the link and stops mirroring", () => {
    seedOneDay(); // day 1: start (1,1) → end (2,2)
    useTripStore.getState().addDay(); // day 2: linked start seeded from (2,2)

    // Add a via on day 2, then promote it to start via setWaypointType.
    useTripStore.setState({ selectedDayIndex: 1 });
    useTripStore.getState().placeWaypoint({ lat: 9, lng: 9 }, "add-via");
    const via = useTripStore
      .getState()
      .activeTrip!.days[1]!.waypoints.find((w) => w.type === "via")!;
    useTripStore.getState().setWaypointType(via.id, "start");

    // Link must be broken.
    expect(useTripStore.getState().activeTrip!.days[1]!.startLinked).toBe(
      false,
    );

    // Editing day 1's end must NOT move day 2's (now manual) start.
    useTripStore.setState({ selectedDayIndex: 0 });
    useTripStore.getState().placeWaypoint({ lat: 7, lng: 7 }, "set-end");

    const day2Starts = useTripStore
      .getState()
      .activeTrip!.days[1]!.waypoints.filter((w) => w.type === "start");
    // The promoted via (9,9) is the start; it stayed put.
    expect(
      day2Starts.some((w) => w.location.lat === 9 && w.location.lng === 9),
    ).toBe(true);
    expect(
      day2Starts.some((w) => w.location.lat === 7 && w.location.lng === 7),
    ).toBe(false);
  });

  it("removeDay is a no-op when only 1 day remains", () => {
    seedOneDay();
    expect(useTripStore.getState().activeTrip!.days).toHaveLength(1);

    useTripStore.getState().removeDay(0);

    // Trip should still have 1 day.
    expect(useTripStore.getState().activeTrip!.days).toHaveLength(1);
  });

  it("removeDay keeps the same logical day selected when an EARLIER day is removed", () => {
    // Build a 3-day trip (each complete), select day 3, remove day 1.
    seedOneDay();
    useTripStore.getState().addDay();
    useTripStore.setState({ selectedDayIndex: 1 });
    useTripStore.getState().placeWaypoint({ lat: 20, lng: 20 }, "set-end");
    useTripStore.getState().addDay();
    useTripStore.setState({ selectedDayIndex: 2 });
    useTripStore.getState().placeWaypoint({ lat: 30, lng: 30 }, "set-end");

    // Day 3 is selected (index 2). Remove day 1 (index 0).
    useTripStore.setState({ selectedDayIndex: 2 });
    useTripStore.getState().removeDay(0);

    // Old day 3 is now at index 1 — selection must follow it, not jump to old
    // day 2 (which is now index... ) via a bare clamp to length-1.
    expect(useTripStore.getState().activeTrip!.days).toHaveLength(2);
    expect(useTripStore.getState().selectedDayIndex).toBe(1);
  });

  it("removeDay is undoable (snapshots the deleted day onto the undo stack)", () => {
    seedOneDay();
    useTripStore.getState().addDay();
    useTripStore.setState({ selectedDayIndex: 1 });
    useTripStore.getState().placeWaypoint({ lat: 20, lng: 20 }, "set-end"); // day 2 complete
    expect(useTripStore.getState().activeTrip!.days).toHaveLength(2);

    useTripStore.getState().removeDay(1);
    expect(useTripStore.getState().activeTrip!.days).toHaveLength(1);
    expect(useTripStore.getState().canUndo).toBe(true);

    useTripStore.getState().undo();
    expect(useTripStore.getState().activeTrip!.days).toHaveLength(2); // day restored
  });

  it("addWaypoint marks the MUTATED day stale, not the selected day", () => {
    seedOneDay(); // day 1
    useTripStore.getState().addDay();
    useTripStore.setState({ selectedDayIndex: 1 });
    useTripStore.getState().placeWaypoint({ lat: 20, lng: 20 }, "set-end"); // day 2 complete
    // Select day 2, clear stale, then add a stop to DAY 1 (index 0).
    useTripStore.setState({ stalePreviewDays: [], selectedDayIndex: 1 });

    useTripStore.getState().addWaypoint(0, {
      id: "stop-1",
      name: "Fuel",
      type: "fuel",
      location: { lng: 1.2, lat: 1.2 },
    });

    const stale = useTripStore.getState().stalePreviewDays;
    expect(stale).toContain(1); // the mutated day (day 1)
    expect(stale).not.toContain(2); // NOT the selected day (day 2)
  });

  it("addDay creates day 1 on a zero-day metadata draft without crashing", () => {
    // Metadata-only server draft: a trip whose days array is empty.
    useTripStore.setState({
      activeTrip: {
        id: "draft-0",
        name: "Empty draft",
        status: "draft",
        num_days: 1,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        parameters: {
          days: 1,
          dailyKmTarget: 250,
          roadPreference: "mixed",
          surfacePreference: ["asphalt"],
          avoidHighways: true,
          avoidTolls: false,
          avoidUnpaved: true,
          minQuality: 3,
        },
        collaborators: [{ userId: "u", displayName: "You", role: "owner" }],
        days: [],
      } as never,
    });

    expect(() => useTripStore.getState().addDay()).not.toThrow();
    const trip = useTripStore.getState().activeTrip!;
    expect(trip.days).toHaveLength(1);
    expect(trip.days[0]!.dayNumber).toBe(1);
    expect(trip.days[0]!.startLinked).toBeFalsy(); // day 1 is never linked
    expect(useTripStore.getState().selectedDayIndex).toBe(0);
  });

  it("addDay is undoable and invalidates a pending redo", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 2, lng: 2 }, "set-end"); // day 1 (snapshot)
    s.placeWaypoint({ lat: 1.5, lng: 1.5 }, "add-via"); // edit (snapshot)
    s.undo(); // creates a redo entry
    expect(useTripStore.getState().canRedo).toBe(true);

    s.addDay();
    // The stale redo must be invalidated (pressing Redo would otherwise drop
    // the new day), and the addition itself must be undoable.
    expect(useTripStore.getState().canRedo).toBe(false);
    expect(useTripStore.getState().canUndo).toBe(true);
    expect(useTripStore.getState().activeTrip!.days).toHaveLength(2);

    s.undo();
    expect(useTripStore.getState().activeTrip!.days).toHaveLength(1);
  });

  it("relinkDayStart is undoable and recovers the manual start", () => {
    seedOneDay(); // day 1: start (1,1) → end (2,2)
    useTripStore.getState().addDay(); // day 2 linked, start seeded from (2,2)
    // Manually override day 2's start.
    useTripStore.setState({ selectedDayIndex: 1 });
    useTripStore.getState().placeWaypoint({ lat: 9, lng: 9 }, "set-start");
    expect(useTripStore.getState().activeTrip!.days[1]!.startLinked).toBe(
      false,
    );

    // Re-link → start re-seeds to day 1's end and the link is restored.
    useTripStore.getState().relinkDayStart(1);
    expect(useTripStore.getState().activeTrip!.days[1]!.startLinked).toBe(true);
    expect(
      useTripStore
        .getState()
        .activeTrip!.days[1]!.waypoints.find((w) => w.type === "start")!
        .location,
    ).toEqual({ lat: 2, lng: 2 });
    expect(useTripStore.getState().canUndo).toBe(true);

    // Undo recovers the rider's manual start.
    useTripStore.getState().undo();
    expect(useTripStore.getState().activeTrip!.days[1]!.startLinked).toBe(
      false,
    );
    expect(
      useTripStore
        .getState()
        .activeTrip!.days[1]!.waypoints.find((w) => w.type === "start")!
        .location,
    ).toEqual({ lat: 9, lng: 9 });
  });
});
