import { deriveDayQualitySegments } from "@/lib/trip-planner-map";
import { splitIntoDays } from "@/lib/planner/day-splitter";
import { dayFinishWaypoint, useTripStore } from "./trip";
import type { RouteResponse } from "@/lib/api";
import type { RouteSegment } from "@/lib/planner/types";
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

    useTripStore.getState().insertWaypointBeforeEnd(0, {
      id: "fuel-1",
      name: "Fuel stop",
      location: { lat: 46.53, lng: 10.45 },
      type: "fuel",
    });

    // Add then remove a stay suggestion — exercises addWaypoint/removeWaypoint
    // while geometry must stay intact. (A terminal stay would BECOME the day's
    // finish, so it's added after the fuel-before-end insertion above.)
    useTripStore.getState().addWaypoint(0, {
      id: "stay-1",
      name: "Hotel Stelvio",
      location: { lat: 46.62, lng: 10.58 },
      type: "accommodation",
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

  it("saveDays sends the day title and normalizes a terminal accommodation to an end", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start"); // day 1: start
    // A generated-style overnight finish: terminal accommodation, no `end`.
    s.addWaypoint(0, {
      id: "hotel-1",
      name: "Hotel",
      type: "accommodation",
      location: { lng: 2, lat: 2 },
    });
    const trip = useTripStore.getState().activeTrip!;
    useTripStore.setState({
      activeTrip: {
        ...trip,
        days: [{ ...trip.days[0]!, title: "Leg A" }],
      },
    });

    const days = useTripStore.getState().saveDays();
    expect(days).toHaveLength(1);
    expect(days[0]!.title).toBe("Leg A"); // title sent with the day
    const types = days[0]!.waypoints.map((w) => w.type);
    expect(types).toContain("end"); // terminal accommodation re-typed to end
    expect(types).not.toContain("hotel");
  });

  it("markRouteDirty marks an accommodation-terminated day stale", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start"); // day 1: start
    s.addWaypoint(0, {
      id: "hotel-1",
      name: "Hotel",
      type: "accommodation", // terminal overnight, no explicit end
      location: { lng: 2, lat: 2 },
    });
    useTripStore.setState({ stalePreviewDays: [] });

    s.markRouteDirty();
    // start + accommodation has <2 RAW routing points, but normalizing the
    // overnight finish makes it routable — it must be staled (and re-previewed)
    // so Save can't persist an unpreviewed reroute for it.
    expect(useTripStore.getState().stalePreviewDays).toContain(1);
  });

  it("syncLinkedStart cascades a moved terminal accommodation into the linked successor", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start"); // day 1: start
    s.addWaypoint(0, {
      id: "hotel-1",
      name: "Hotel",
      type: "accommodation", // day 1 finishes at the overnight (2,2)
      location: { lng: 2, lat: 2 },
    });
    s.addDay(); // day 2 linked, start seeded from day 1's overnight (2,2)
    expect(
      useTripStore
        .getState()
        .activeTrip!.days[1]!.waypoints.find((w) => w.type === "start")!
        .location,
    ).toEqual({ lng: 2, lat: 2 });

    // Move day 1's overnight; the linked day 2 start must follow and go stale.
    const hotel = useTripStore
      .getState()
      .activeTrip!.days[0]!.waypoints.find((w) => w.type === "accommodation")!;
    useTripStore.setState({ stalePreviewDays: [], selectedDayIndex: 0 });
    s.moveWaypoint(0, hotel.id, { lat: 9, lng: 9 });

    const day2Start = useTripStore
      .getState()
      .activeTrip!.days[1]!.waypoints.find((w) => w.type === "start")!;
    expect(day2Start.location).toEqual({ lng: 9, lat: 9 });
    expect(useTripStore.getState().stalePreviewDays).toContain(2);
  });

  it("add-via inserts before a terminal accommodation (keeps the overnight terminal)", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start"); // day 1: start
    s.addWaypoint(0, {
      id: "hotel-1",
      name: "Hotel",
      type: "accommodation", // generated overnight finish, no explicit end
      location: { lng: 2, lat: 2 },
    });

    s.placeWaypoint({ lat: 5, lng: 5 }, "add-via"); // menu "Add via"
    // The via lands BEFORE the accommodation, so it stays terminal and the day
    // remains complete (start → via → accommodation).
    const types = useTripStore
      .getState()
      .activeTrip!.days[0]!.waypoints.map((w) => w.type);
    expect(types).toEqual(["start", "via", "accommodation"]);
  });

  it("appendPlannerWaypoint inserts before a terminal accommodation", () => {
    const s = useTripStore.getState();
    s.appendPlannerWaypoint(0, { lng: 1, lat: 1 }); // day 1: start
    s.addWaypoint(0, {
      id: "hotel-1",
      name: "Hotel",
      type: "accommodation",
      location: { lng: 2, lat: 2 },
    });

    s.appendPlannerWaypoint(0, { lng: 5, lat: 5 }); // map-click add
    const types = useTripStore
      .getState()
      .activeTrip!.days[0]!.waypoints.map((w) => w.type);
    expect(types).toEqual(["start", "via", "accommodation"]);
  });

  it("addWaypoint cascades a new terminal stay into the linked successor", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start"); // day 1: start
    s.addWaypoint(0, {
      id: "stay-1",
      name: "Hotel",
      type: "accommodation", // day 1 finishes at the overnight (2,2)
      location: { lng: 2, lat: 2 },
    });
    s.addDay(); // day 2 linked, start seeded from day 1's overnight (2,2)
    expect(
      useTripStore
        .getState()
        .activeTrip!.days[1]!.waypoints.find((w) => w.type === "start")!
        .location,
    ).toEqual({ lng: 2, lat: 2 });

    // Add a NEW terminal stay to day 1 — its finish moves to (8,8); the linked
    // day 2 start must re-seed there and go stale (not keep the old overnight).
    useTripStore.setState({ stalePreviewDays: [], selectedDayIndex: 1 });
    s.addWaypoint(0, {
      id: "stay-2",
      name: "New hotel",
      type: "accommodation",
      location: { lng: 8, lat: 8 },
    });

    const day2Start = useTripStore
      .getState()
      .activeTrip!.days[1]!.waypoints.find((w) => w.type === "start")!;
    expect(day2Start.location).toEqual({ lng: 8, lat: 8 });
    expect(useTripStore.getState().stalePreviewDays).toContain(2);
  });

  it("a stay added after an explicit end becomes the day finish for saveDays", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 2, lng: 2 }, "set-end"); // day 1: [start, end(2,2)]
    s.addWaypoint(0, {
      id: "stay-1",
      name: "Hotel",
      type: "accommodation", // appended AFTER the end → the new finish
      location: { lng: 3, lat: 3 },
    });

    const wp = useTripStore.getState().saveDays()[0]!.waypoints;
    // Save normalizes: old end → via, terminal stay → end, routing to (3,3).
    expect(wp.map((w) => w.type)).toEqual(["start", "via", "end"]);
    expect(wp[wp.length - 1]).toMatchObject({ lat: 3, lng: 3 });
  });

  it("saveDays demotes a prior stay when a replacement terminal stay becomes the finish", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start"); // [start]
    s.addWaypoint(0, {
      id: "old",
      name: "Old hotel",
      type: "accommodation", // [start, accommodation(old, 2,2)]
      location: { lng: 2, lat: 2 },
    });
    s.addWaypoint(0, {
      id: "new",
      name: "New hotel",
      type: "accommodation", // [start, acc(old), acc(new, 3,3)]
      location: { lng: 3, lat: 3 },
    });

    const wp = useTripStore.getState().saveDays()[0]!.waypoints;
    // The OLD stay → via, the NEW terminal stay → end. No stale `hotel` is
    // serialized, so a reload's overnight reads from the new stay (the end).
    expect(wp.map((w) => w.type)).toEqual(["start", "via", "end"]);
    expect(wp.filter((w) => w.type === "hotel")).toHaveLength(0);
    expect(wp[wp.length - 1]).toMatchObject({ lat: 3, lng: 3 });
  });

  it("set-end replaces a terminal accommodation finish instead of appending a second end", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start"); // day 1: start
    s.addWaypoint(0, {
      id: "hotel-1",
      name: "Hotel",
      type: "accommodation", // [start, accommodation(2,2)]
      location: { lng: 2, lat: 2 },
    });

    s.placeWaypoint({ lat: 9, lng: 9 }, "set-end"); // menu "Set as finish"
    const wps = useTripStore.getState().activeTrip!.days[0]!.waypoints;
    // The accommodation slot becomes the end — no stale overnight left behind.
    expect(wps.map((w) => w.type)).toEqual(["start", "end"]);
    expect(wps[1]!.location).toEqual({ lng: 9, lat: 9 });
  });

  it("set-end on [start, end, stay] demotes the old end and replaces the stay", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 2, lng: 2 }, "set-end"); // [start, end(2,2)]
    s.addWaypoint(0, {
      id: "hotel-1",
      name: "Hotel",
      type: "accommodation", // [start, end, accommodation(3,3)]
      location: { lng: 3, lat: 3 },
    });

    s.placeWaypoint({ lat: 9, lng: 9 }, "set-end");
    const wps = useTripStore.getState().activeTrip!.days[0]!.waypoints;
    // Old end → via, the terminal stay slot → the new end. Exactly one end.
    expect(wps.map((w) => w.type)).toEqual(["start", "via", "end"]);
    expect(wps.filter((w) => w.type === "end")).toHaveLength(1);
    expect(wps[2]!.location).toEqual({ lng: 9, lat: 9 });
  });

  it("reorderWaypoints cascades a finish change into the linked successor", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 2, lng: 2 }, "set-end"); // [start, end(2,2)]
    s.addWaypoint(0, {
      id: "stay-1",
      name: "Hotel",
      type: "accommodation", // [start, end, accommodation(3,3)] — finish = (3,3)
      location: { lng: 3, lat: 3 },
    });
    s.addDay(); // day 2 linked, seeded from the finish (3,3)
    expect(
      useTripStore
        .getState()
        .activeTrip!.days[1]!.waypoints.find((w) => w.type === "start")!
        .location,
    ).toEqual({ lng: 3, lat: 3 });

    // Drag the accommodation BEFORE the end → the finish reverts to (2,2).
    useTripStore.setState({ stalePreviewDays: [], selectedDayIndex: 1 });
    s.reorderWaypoints(0, 2, 1);
    expect(
      useTripStore.getState().activeTrip!.days[0]!.waypoints.map((w) => w.type),
    ).toEqual(["start", "accommodation", "end"]);

    // The linked day 2 start re-seeds to the new finish (2,2) and goes stale.
    const day2Start = useTripStore
      .getState()
      .activeTrip!.days[1]!.waypoints.find((w) => w.type === "start")!;
    expect(day2Start.location).toEqual({ lng: 2, lat: 2 });
    expect(useTripStore.getState().stalePreviewDays).toContain(2);
  });

  it("reordering a terminal stay off the end promotes the trailing via to the finish (role-from-index)", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start"); // [start(1,1)]
    s.addWaypoint(0, {
      id: "via-1",
      name: "Via",
      type: "via",
      location: { lng: 5, lat: 5 },
    });
    s.addWaypoint(0, {
      id: "stay-1",
      name: "Hotel",
      type: "accommodation", // [start, via, accommodation(2,2)] — finish = (2,2)
      location: { lng: 2, lat: 2 },
    });
    s.addDay(); // day 2 linked, seeded from the terminal stay (2,2)
    expect(useTripStore.getState().activeTrip!.days[1]!.startLinked).toBe(true);

    // Drag the stay BEFORE the via. Roles derive from position, so the
    // now-trailing via is promoted to the day's finish — the day never
    // goes finishless while it has two routing waypoints.
    useTripStore.setState({ selectedDayIndex: 1 });
    s.reorderWaypoints(0, 2, 1);
    expect(
      useTripStore.getState().activeTrip!.days[0]!.waypoints.map((w) => w.type),
    ).toEqual(["start", "accommodation", "end"]);

    // The linked successor re-seeds its start from the promoted finish.
    const day2 = useTripStore.getState().activeTrip!.days[1]!;
    expect(day2.startLinked).toBe(true);
    expect(day2.waypoints.find((w) => w.type === "start")!.location).toEqual({
      lng: 5,
      lat: 5,
    });
  });

  it("adding a stay after an explicit end re-seeds the linked successor to the stay", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 2, lng: 2 }, "set-end"); // day 1: [start, end(2,2)]
    s.addDay(); // day 2 linked, start seeded from day 1's end (2,2)
    expect(
      useTripStore
        .getState()
        .activeTrip!.days[1]!.waypoints.find((w) => w.type === "start")!
        .location,
    ).toEqual({ lng: 2, lat: 2 });

    useTripStore.setState({ stalePreviewDays: [], selectedDayIndex: 1 });
    s.addWaypoint(0, {
      id: "stay-1",
      name: "Hotel",
      type: "accommodation",
      location: { lng: 8, lat: 8 }, // new finish moves day 1's boundary
    });

    const day2Start = useTripStore
      .getState()
      .activeTrip!.days[1]!.waypoints.find((w) => w.type === "start")!;
    expect(day2Start.location).toEqual({ lng: 8, lat: 8 });
    expect(useTripStore.getState().stalePreviewDays).toContain(2);
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

  it("removeWaypointById removes from the pin's OWNING day, not the selected one", () => {
    // The map shows every day's pins — removing a Day 2 pin while Day 1
    // is selected must delete it from Day 2 (it was a silent no-op).
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 3, lng: 3 }, "set-end");
    s.addDay();
    s.setSelectedDay(1);
    s.placeWaypoint({ lat: 4, lng: 4 }, "set-start");
    s.placeWaypoint({ lat: 6, lng: 6 }, "set-end");
    s.placeWaypoint({ lat: 5, lng: 5 }, "add-via");
    const day2Via = useTripStore
      .getState()
      .activeTrip!.days[1]!.waypoints.find((w) => w.type === "via")!;

    s.setSelectedDay(0);
    useTripStore.getState().removeWaypointById(day2Via.id);

    const days = useTripStore.getState().activeTrip!.days;
    expect(days[1]!.waypoints.find((w) => w.id === day2Via.id)).toBeUndefined();
    // Day 1 untouched.
    expect(days[0]!.waypoints).toHaveLength(2);
  });

  it("markDayRouteDirty stales ONLY the given day's preview", () => {
    // A LEG override affects one day; staling every routable day would
    // wedge the Save gate on days live routing never revisits.
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 3, lng: 3 }, "set-end");
    s.addDay();
    s.setSelectedDay(1);
    s.placeWaypoint({ lat: 4, lng: 4 }, "set-start");
    s.placeWaypoint({ lat: 6, lng: 6 }, "set-end");
    useTripStore.setState({ routeDirty: false, stalePreviewDays: [] });

    useTripStore.getState().markDayRouteDirty(1);

    expect(useTripStore.getState().routeDirty).toBe(true);
    expect(useTripStore.getState().stalePreviewDays).toEqual([2]);

    // Idempotent — no duplicate entries.
    useTripStore.getState().markDayRouteDirty(1);
    expect(useTripStore.getState().stalePreviewDays).toEqual([2]);
  });

  it("markDayRouteDirty never stales an unroutable day", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    useTripStore.setState({ routeDirty: false, stalePreviewDays: [] });

    // Day 0 has a lone start — the live hook can't re-route it.
    useTripStore.getState().markDayRouteDirty(0);

    expect(useTripStore.getState().routeDirty).toBe(true);
    expect(useTripStore.getState().stalePreviewDays).toEqual([]);
  });

  it("removeWaypointById with an unknown id is a state no-op", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    const before = useTripStore.getState().activeTrip;
    useTripStore.getState().removeWaypointById("nope");
    expect(useTripStore.getState().activeTrip).toBe(before);
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

  it("removeDay clears a successor link when the new predecessor has no finish", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start"); // day 1: [start] — NO finish
    s.addDay(); // day 2 (unlinked — day 1 has no finish)
    useTripStore.setState({ selectedDayIndex: 1 });
    s.placeWaypoint({ lat: 2, lng: 2 }, "set-start");
    s.placeWaypoint({ lat: 3, lng: 3 }, "set-end"); // day 2: [start, end(3,3)]
    s.addDay(); // day 3 linked, seeded from day 2's finish (3,3)
    expect(useTripStore.getState().activeTrip!.days[2]!.startLinked).toBe(true);

    // Remove the middle day — old day 3 becomes day 2, its new predecessor is
    // day 1 (start only, no finish), so the now-invalid link must be cleared.
    s.removeDay(1);
    const newDay2 = useTripStore.getState().activeTrip!.days[1]!;
    expect(newDay2.startLinked).toBe(false);
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

  it("dragging a linked successor's start breaks the link and stops mirroring", () => {
    seedOneDay(); // day 1: start (1,1) → end (2,2)
    useTripStore.getState().addDay(); // day 2: linked start seeded from (2,2)
    expect(useTripStore.getState().activeTrip!.days[1]!.startLinked).toBe(true);
    const day2Start = useTripStore
      .getState()
      .activeTrip!.days[1]!.waypoints.find((w) => w.type === "start")!;

    // Drag day 2's (linked) start to a new spot.
    useTripStore.getState().moveWaypoint(1, day2Start.id, { lat: 9, lng: 9 });
    expect(useTripStore.getState().activeTrip!.days[1]!.startLinked).toBe(
      false,
    );

    // A later edit to day 1's end must NOT overwrite the dragged start.
    useTripStore.setState({ selectedDayIndex: 0 });
    useTripStore.getState().placeWaypoint({ lat: 7, lng: 7 }, "set-end");
    const after = useTripStore
      .getState()
      .activeTrip!.days[1]!.waypoints.find((w) => w.type === "start")!;
    expect(after.location).toEqual({ lng: 9, lat: 9 }); // stayed where dragged
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

  it("undo clamps selectedDayIndex when the restored trip has fewer days", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 2, lng: 2 }, "set-end"); // day 1
    s.addDay(); // appends day 2 and selects index 1
    expect(useTripStore.getState().selectedDayIndex).toBe(1);
    expect(useTripStore.getState().activeTrip!.days).toHaveLength(2);

    s.undo(); // back to a single day
    expect(useTripStore.getState().activeTrip!.days).toHaveLength(1);
    // selectedDayIndex must clamp into range — not stay at 1 ("Day 2 of 1"),
    // which would make the next placement target a missing day and recreate it.
    expect(useTripStore.getState().selectedDayIndex).toBe(0);
  });

  it("undo restores the snapshot's exact stale set, not every routable day", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 2, lng: 2 }, "set-end"); // day 1 routable
    s.addDay();
    useTripStore.setState({ selectedDayIndex: 1 });
    s.placeWaypoint({ lat: 20, lng: 20 }, "set-end"); // day 2 routable
    // Both days routed fresh, but the trip is still dirty (edited since load).
    useTripStore.setState({
      stalePreviewDays: [],
      routeDirty: true,
      selectedDayIndex: 0,
    });

    // Edit day 1 → its snapshot captures { dirty: true, stale: [] }.
    s.placeWaypoint({ lat: 1.5, lng: 1.5 }, "add-via");
    expect(useTripStore.getState().stalePreviewDays).toContain(1);

    s.undo();
    // The captured set ([]) is restored verbatim — NOT a reconstruction from
    // all routable days, which would wrongly stale the untouched day 2.
    expect(useTripStore.getState().stalePreviewDays).toEqual([]);
  });

  it("Add day does not link a successor when the predecessor has no finish yet", () => {
    const s = useTripStore.getState();
    s.appendPlannerWaypoint(0, { lng: 1, lat: 1 }); // day 1: start only (no finish)
    s.addDay();
    // Day 2 must NOT be linked — an unseeded "linked" start would be filled by
    // the next map click WITHOUT clearing the link, then hidden outside focus
    // and overwritten by a later predecessor finish.
    expect(useTripStore.getState().activeTrip!.days[1]!.startLinked).toBe(
      false,
    );
    expect(
      useTripStore
        .getState()
        .activeTrip!.days[1]!.waypoints.filter((w) => w.type === "start"),
    ).toHaveLength(0);

    // Once day 1 has a finish, the rider can relink → start seeds to it.
    s.appendPlannerWaypoint(0, { lng: 2, lat: 2 }); // day 1 finish at (2,2)
    s.relinkDayStart(1);
    expect(useTripStore.getState().activeTrip!.days[1]!.startLinked).toBe(true);
    const day2Start = useTripStore
      .getState()
      .activeTrip!.days[1]!.waypoints.find((w) => w.type === "start");
    expect(day2Start?.location).toEqual({ lng: 2, lat: 2 });
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

  it("relinkDayStart is a no-op when the predecessor has no finish", () => {
    const s = useTripStore.getState();
    s.appendPlannerWaypoint(0, { lng: 1, lat: 1 }); // day 1: start only, no end
    s.addDay(); // day 2 linked, no seeded start (day 1 has no end)
    // Manually place day 2's start (this also breaks the link).
    useTripStore.setState({ selectedDayIndex: 1 });
    s.placeWaypoint({ lat: 9, lng: 9 }, "set-start");
    expect(useTripStore.getState().activeTrip!.days[1]!.startLinked).toBe(
      false,
    );

    // Relink — but day 1 has no finish to mirror → no-op.
    s.relinkDayStart(1);
    expect(useTripStore.getState().activeTrip!.days[1]!.startLinked).toBe(
      false,
    );
    // The rider's manual start is preserved (not hidden/overwritten).
    const day2Start = useTripStore
      .getState()
      .activeTrip!.days[1]!.waypoints.find((w) => w.type === "start")!;
    expect(day2Start.location).toEqual({ lng: 9, lat: 9 });
  });
});

describe("useTripStore Plan & inspect segment selection", () => {
  beforeEach(() => useTripStore.getState().resetForTest?.());

  it("selectPlannerSegment sets and clears the selection", () => {
    useTripStore.getState().selectPlannerSegment("d1-s2");
    expect(useTripStore.getState().selectedPlannerSegmentId).toBe("d1-s2");
    useTripStore.getState().selectPlannerSegment(null);
    expect(useTripStore.getState().selectedPlannerSegmentId).toBeNull();
  });

  it("setActiveTrip and undo clear a stale segment selection", () => {
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    useTripStore.getState().placeWaypoint({ lat: 5, lng: 5 }, "set-end");
    useTripStore.getState().selectPlannerSegment("d1-s0");

    useTripStore.getState().undo();
    expect(useTripStore.getState().selectedPlannerSegmentId).toBeNull();

    useTripStore.getState().selectPlannerSegment("d1-s0");
    useTripStore.getState().setActiveTrip(null);
    expect(useTripStore.getState().selectedPlannerSegmentId).toBeNull();
  });
});

describe("useTripStore insertWaypointBefore (reroute via)", () => {
  beforeEach(() => useTripStore.getState().resetForTest?.());

  function seedRoute() {
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    useTripStore.getState().placeWaypoint({ lat: 5, lng: 5 }, "set-end");
    useTripStore.getState().placeWaypoint({ lat: 3, lng: 3 }, "add-via");
    useTripStore.setState({ routeDirty: false, stalePreviewDays: [] });
  }

  it("inserts immediately before the anchor waypoint", () => {
    seedRoute();
    const via = useTripStore
      .getState()
      .activeTrip!.days[0]!.waypoints.find((w) => w.type === "via")!;

    useTripStore.getState().insertWaypointBefore(0, via.id, {
      id: "reroute-1",
      name: "Reroute via",
      location: { lat: 2, lng: 2 },
      type: "via",
    });

    const types = useTripStore
      .getState()
      .activeTrip!.days[0]!.waypoints.map((w) => w.id);
    expect(types.indexOf("reroute-1")).toBe(types.indexOf(via.id) - 1);
  });

  it("falls back to the finish boundary when the anchor is missing or null", () => {
    seedRoute();
    useTripStore.getState().insertWaypointBefore(0, null, {
      id: "reroute-2",
      name: "Reroute via",
      location: { lat: 4, lng: 4 },
      type: "via",
    });
    const waypoints = useTripStore.getState().activeTrip!.days[0]!.waypoints;
    // Lands before the end waypoint.
    expect(waypoints[waypoints.length - 1]!.type).toBe("end");
    expect(waypoints[waypoints.length - 2]!.id).toBe("reroute-2");

    useTripStore.getState().insertWaypointBefore(0, "nope", {
      id: "reroute-3",
      name: "Reroute via",
      location: { lat: 4.5, lng: 4.5 },
      type: "via",
    });
    const after = useTripStore.getState().activeTrip!.days[0]!.waypoints;
    expect(after[after.length - 2]!.id).toBe("reroute-3");
  });

  it("never inserts ahead of the day's start", () => {
    seedRoute();
    const start = useTripStore
      .getState()
      .activeTrip!.days[0]!.waypoints.find((w) => w.type === "start")!;
    useTripStore.getState().insertWaypointBefore(0, start.id, {
      id: "reroute-4",
      name: "Reroute via",
      location: { lat: 1.5, lng: 1.5 },
      type: "via",
    });
    const waypoints = useTripStore.getState().activeTrip!.days[0]!.waypoints;
    expect(waypoints[0]!.type).toBe("start");
    expect(waypoints[1]!.id).toBe("reroute-4");
  });

  it("marks the route dirty and the day stale so live routing re-runs", () => {
    seedRoute();
    const via = useTripStore
      .getState()
      .activeTrip!.days[0]!.waypoints.find((w) => w.type === "via")!;
    useTripStore.getState().insertWaypointBefore(0, via.id, {
      id: "reroute-5",
      name: "Reroute via",
      location: { lat: 2, lng: 2 },
      type: "via",
    });
    expect(useTripStore.getState().routeDirty).toBe(true);
    expect(useTripStore.getState().stalePreviewDays).toContain(1);
  });
});

describe("useTripStore role-from-index waypoints (addendum §1)", () => {
  beforeEach(() => useTripStore.getState().resetForTest?.());

  function seed() {
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    useTripStore.getState().placeWaypoint({ lat: 5, lng: 5 }, "set-end");
    useTripStore.getState().placeWaypoint({ lat: 3, lng: 3 }, "add-via");
  }
  const types = () =>
    useTripStore.getState().activeTrip!.days[0]!.waypoints.map((w) => w.type);
  const names = () =>
    useTripStore.getState().activeTrip!.days[0]!.waypoints.map((w) => w.name);

  it("dragging the via to the top makes it the start and demotes the old start", () => {
    seed(); // [start, via, end]
    useTripStore.getState().reorderWaypoints(0, 1, 0);
    expect(types()).toEqual(["start", "via", "end"]);
    // The moved via is now named Start; the old start became a via.
    expect(names()).toEqual(["Start", "Via 1", "Finish"]);
  });

  it("dragging the start to the bottom makes it the finish", () => {
    seed(); // [start, via, end]
    useTripStore.getState().reorderWaypoints(0, 0, 2);
    // Order after move: [via, end, start] → roles by index.
    expect(types()).toEqual(["start", "via", "end"]);
  });

  it("preserves custom (geocoded) names across a re-role", () => {
    seed();
    const day = useTripStore.getState().activeTrip!.days[0]!;
    const via = day.waypoints[1]!;
    // Simulate a geocoded custom name.
    useTripStore.setState((state) => {
      const trip = state.activeTrip!;
      const waypoints = trip.days[0]!.waypoints.map((w) =>
        w.id === via.id ? { ...w, name: "Velké Meziříčí" } : w,
      );
      return {
        activeTrip: {
          ...trip,
          days: [{ ...trip.days[0]!, waypoints }],
        },
      };
    });
    useTripStore.getState().reorderWaypoints(0, 1, 0);
    expect(names()[0]).toBe("Velké Meziříčí");
    expect(types()[0]).toBe("start");
  });

  it("removing the start promotes the next routing waypoint", () => {
    seed();
    const start = useTripStore
      .getState()
      .activeTrip!.days[0]!.waypoints.find((w) => w.type === "start")!;
    useTripStore.getState().removeWaypointById(start.id);
    expect(types()).toEqual(["start", "end"]);
  });

  it("stop-type waypoints keep their type and never take a role", () => {
    seed();
    useTripStore.getState().insertWaypointBeforeEnd(0, {
      id: "fuel-1",
      name: "Gas",
      location: { lat: 4, lng: 4 },
      type: "fuel",
    });
    // Move the fuel stop to the top — roles must skip it.
    const waypoints = useTripStore.getState().activeTrip!.days[0]!.waypoints;
    const fuelIndex = waypoints.findIndex((w) => w.id === "fuel-1");
    useTripStore.getState().reorderWaypoints(0, fuelIndex, 0);
    const after = useTripStore.getState().activeTrip!.days[0]!.waypoints;
    expect(after[0]!.type).toBe("fuel");
    // Routing roles still valid on the remaining routing waypoints.
    const routingTypes = after
      .filter((w) => w.type !== "fuel")
      .map((w) => w.type);
    expect(routingTypes[0]).toBe("start");
    expect(routingTypes[routingTypes.length - 1]).toBe("end");
  });

  it("supports a loop: finish placed on the start coordinate", () => {
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-end");
    const waypoints = useTripStore.getState().activeTrip!.days[0]!.waypoints;
    expect(waypoints).toHaveLength(2);
    expect(waypoints[0]!.type).toBe("start");
    expect(waypoints[1]!.type).toBe("end");
    expect(waypoints[1]!.location).toEqual(waypoints[0]!.location);
  });
});

describe("useTripStore split lifecycle (addendum)", () => {
  beforeEach(() => useTripStore.getState().resetForTest?.());

  const KM_PER_DEG_LAT = 111.194926;
  const degPerKm = 1 / KM_PER_DEG_LAT;

  function seedRoutedTrip(totalKm = 600) {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 45, lng: 15 }, "set-start");
    s.placeWaypoint({ lat: 45 + totalKm * degPerKm, lng: 15 }, "set-end");
    s.placeWaypoint({ lat: 45 + 100 * degPerKm, lng: 15 }, "add-via");
    // Simulate the live-routing result: dense meridian geometry.
    const geometry = Array.from({ length: totalKm + 1 }, (_, km) => ({
      lat: 45 + km * degPerKm,
      lng: 15,
    }));
    useTripStore.getState().applyRouteResult(1, {
      geometry,
      distance_km: totalKm,
      duration_min: totalKm,
      avg_quality: 3.9,
      curviness_score: 40,
      elevation_gain_m: 4000,
      surface_mix: { asphalt: totalKm * 1000 },
    });
  }

  function plansFor(totalKm = 600) {
    const day = useTripStore.getState().activeTrip!.days[0]!;
    const segments = deriveDayQualitySegments(day);
    return splitIntoDays(segments, {
      dailyKmTarget: 250,
      forcedDays: null,
      totalTimeMin: totalKm,
    });
  }

  it("planningMode: defaults single; applySplit opts into multiday; leaving multiday drops the split", () => {
    seedRoutedTrip();
    expect(useTripStore.getState().planningMode).toBe("single");

    // Running a split IS acting on the multi-day section (revision 2 §A).
    useTripStore.getState().applySplit(plansFor());
    expect(useTripStore.getState().planningMode).toBe("multiday");
    expect(useTripStore.getState().splitStatus).toBe("split");

    // Backing out to single mode removes the day concept entirely.
    useTripStore.getState().setPlanningMode("single");
    expect(useTripStore.getState().splitStatus).toBe("none");
    expect(useTripStore.getState().dayPlans).toBeNull();
    expect(useTripStore.getState().pinnedBreakKms).toEqual([]);

    // Opting in again has no day side effects until an actual split.
    useTripStore.getState().setPlanningMode("multiday");
    expect(useTripStore.getState().splitStatus).toBe("none");
    expect(useTripStore.getState().dayPlans).toBeNull();
  });

  it("loads a saved multi-day trip in multiday mode; fresh trips stay single", () => {
    seedRoutedTrip();
    useTripStore.getState().applySplit(plansFor());
    useTripStore.getState().materializeSplit();
    const materialized = useTripStore.getState().activeTrip!;

    useTripStore.getState().setActiveTrip(materialized);
    expect(useTripStore.getState().planningMode).toBe("multiday");

    useTripStore.getState().setActiveTrip(null);
    expect(useTripStore.getState().planningMode).toBe("single");
  });

  it("starts unsplit; applySplit enters 'split'; route edits go 'stale'", () => {
    seedRoutedTrip();
    expect(useTripStore.getState().splitStatus).toBe("none");

    useTripStore.getState().applySplit(plansFor());
    expect(useTripStore.getState().splitStatus).toBe("split");
    expect(useTripStore.getState().dayPlans!.length).toBeGreaterThanOrEqual(2);

    // A waypoint edit invalidates the split but keeps the plans for display.
    useTripStore.getState().placeWaypoint({ lat: 45.5, lng: 15.1 }, "add-via");
    expect(useTripStore.getState().splitStatus).toBe("stale");
    expect(useTripStore.getState().dayPlans).not.toBeNull();

    // Pref changes (markRouteDirty) also invalidate.
    useTripStore.getState().applySplit(plansFor());
    useTripStore.getState().markRouteDirty();
    expect(useTripStore.getState().splitStatus).toBe("stale");
  });

  it("loads a saved multi-day trip as an existing split", () => {
    seedRoutedTrip();
    useTripStore.getState().applySplit(plansFor());
    useTripStore.getState().materializeSplit();
    const materialized = useTripStore.getState().activeTrip!;
    useTripStore.getState().setActiveTrip(materialized);

    expect(useTripStore.getState().splitStatus).toBe("split");
    expect(useTripStore.getState().dayPlans!.length).toBe(
      materialized.days.length,
    );

    useTripStore.getState().setActiveTrip(null);
    expect(useTripStore.getState().splitStatus).toBe("none");
    expect(useTripStore.getState().dayPlans).toBeNull();
  });

  it("materializeSplit rewrites days that satisfy the save gate", () => {
    seedRoutedTrip();
    const plans = plansFor();
    useTripStore.getState().applySplit(plans);
    useTripStore.getState().materializeSplit();

    const trip = useTripStore.getState().activeTrip!;
    expect(trip.days).toHaveLength(plans.length);
    expect(trip.num_days).toBe(plans.length);

    let coveredKm = 0;
    trip.days.forEach((day, index) => {
      // Complete per the save gate: start + finish + geometry.
      expect(day.waypoints.some((w) => w.type === "start")).toBe(true);
      expect(dayFinishWaypoint(day.waypoints)).toBeDefined();
      expect(day.routeGeometry!.coordinates.length).toBeGreaterThanOrEqual(2);
      expect(day.distanceKm).toBeCloseTo(plans[index]!.distanceKm, 0);
      expect(day.startLinked).toBe(index > 0);
      coveredKm += day.distanceKm;
    });
    expect(coveredKm).toBeCloseTo(600, 0);

    // The via placed at ~km 100 belongs to day 1.
    expect(trip.days[0]!.waypoints.some((w) => w.type === "via")).toBe(true);
    expect(trip.days[1]!.waypoints.some((w) => w.type === "via")).toBe(false);

    // Original endpoints survive at the outer boundaries.
    expect(trip.days[0]!.waypoints[0]!.name).toBe("Start");
    expect(trip.days[trip.days.length - 1]!.waypoints.at(-1)!.type).toBe("end");
  });

  it("interpolates a between-vertices break so consecutive days share the exact boundary", () => {
    // SPARSE geometry — one vertex every 40 km — so the 250 km break
    // falls between vertices (240 / 280 km). Vertex-filtering alone
    // would end day 1 at km 240 and start day 2 at km 280: a 40 km gap
    // in the saved geometry and mismatched boundary waypoints.
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 45, lng: 15 }, "set-start");
    s.placeWaypoint({ lat: 45 + 600 * degPerKm, lng: 15 }, "set-end");
    const geometry = Array.from({ length: 16 }, (_, i) => ({
      lat: 45 + i * 40 * degPerKm,
      lng: 15,
    }));
    useTripStore.getState().applyRouteResult(1, {
      geometry,
      distance_km: 600,
      duration_min: 600,
      avg_quality: 4,
      curviness_score: 40,
      elevation_gain_m: 1000,
      surface_mix: {},
    });
    const mkPlan = (dayNumber: number, endKm: number, distanceKm: number) => ({
      dayNumber,
      segmentIds: [],
      distanceKm,
      timeMin: distanceKm,
      quality: {
        distanceKm,
        timeMin: distanceKm,
        score: 4,
        surfaceMix: [],
        flagged: [],
      },
      startTown: "A",
      endTown: "B",
      suggestedStays: [],
      endKm,
    });
    useTripStore
      .getState()
      .applySplit([mkPlan(1, 250, 250), mkPlan(2, 600, 350)]);
    useTripStore.getState().materializeSplit();

    const trip = useTripStore.getState().activeTrip!;
    const day1Coords = trip.days[0]!.routeGeometry!.coordinates;
    const day2Coords = trip.days[1]!.routeGeometry!.coordinates;
    const boundaryLat = 45 + 250 * degPerKm;

    // Both days carry the interpolated km-250 point — no gap, and the
    // linked-start boundary waypoints sit on the same spot.
    expect(day1Coords.at(-1)![1]).toBeCloseTo(boundaryLat, 4);
    expect(day2Coords[0]).toEqual(day1Coords.at(-1));
    expect(trip.days[1]!.waypoints[0]!.location.lat).toBeCloseTo(
      boundaryLat,
      4,
    );
    expect(
      dayFinishWaypoint(trip.days[0]!.waypoints)!.location.lat,
    ).toBeCloseTo(boundaryLat, 4);
  });
});

describe("stop inserts never stale unchanged geometry", () => {
  beforeEach(() => useTripStore.getState().resetForTest?.());

  function seedRoutableDay() {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    s.placeWaypoint({ lat: 3, lng: 3 }, "set-end");
    useTripStore.setState({ routeDirty: false, stalePreviewDays: [] });
  }

  it("a non-routing stop arms Save but does not stale the day", () => {
    seedRoutableDay();
    useTripStore.getState().insertWaypointBeforeEnd(0, {
      id: "fuel-1",
      name: "Fuel",
      location: { lat: 2, lng: 2 },
      type: "fuel",
    });
    expect(useTripStore.getState().routeDirty).toBe(true);
    expect(useTripStore.getState().stalePreviewDays).toEqual([]);
  });

  it("a via stales the day it changes", () => {
    seedRoutableDay();
    useTripStore.getState().insertWaypointBeforeEnd(0, {
      id: "via-1",
      name: "Via",
      location: { lat: 2, lng: 2 },
      type: "via",
    });
    expect(useTripStore.getState().stalePreviewDays).toEqual([1]);
  });

  it("insertWaypointBefore follows the same rule", () => {
    seedRoutableDay();
    const end = useTripStore
      .getState()
      .activeTrip!.days[0]!.waypoints.find((w) => w.type === "end")!;
    useTripStore.getState().insertWaypointBefore(0, end.id, {
      id: "photo-1",
      name: "Photo",
      location: { lat: 2, lng: 2 },
      type: "photo",
    });
    expect(useTripStore.getState().routeDirty).toBe(true);
    expect(useTripStore.getState().stalePreviewDays).toEqual([]);

    useTripStore.getState().insertWaypointBefore(0, end.id, {
      id: "via-2",
      name: "Via",
      location: { lat: 2.5, lng: 2.5 },
      type: "via",
    });
    expect(useTripStore.getState().stalePreviewDays).toEqual([1]);
  });
});

describe("useTripStore renameWaypoint", () => {
  beforeEach(() => useTripStore.getState().resetForTest?.());

  it("renames without dirtying the route or invalidating a split", () => {
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    useTripStore.getState().placeWaypoint({ lat: 5, lng: 5 }, "set-end");
    useTripStore.setState({ routeDirty: false, splitStatus: "split" });
    const start = useTripStore
      .getState()
      .activeTrip!.days[0]!.waypoints.find((w) => w.type === "start")!;

    useTripStore.getState().renameWaypoint(start.id, "Jihlava");

    const renamed = useTripStore
      .getState()
      .activeTrip!.days[0]!.waypoints.find((w) => w.id === start.id)!;
    expect(renamed.name).toBe("Jihlava");
    expect(useTripStore.getState().routeDirty).toBe(false);
    expect(useTripStore.getState().splitStatus).toBe("split");
  });

  it("is a no-op for unknown waypoint ids", () => {
    useTripStore.getState().placeWaypoint({ lat: 1, lng: 1 }, "set-start");
    const before = useTripStore.getState().activeTrip;
    useTripStore.getState().renameWaypoint("nope", "X");
    expect(useTripStore.getState().activeTrip).toBe(before);
  });
});

describe("placeWaypoint POI metadata (revision 4)", () => {
  beforeEach(() => {
    useTripStore.setState({ activeTrip: null, selectedDayIndex: 0 });
  });

  it("names the placed point and carries poiCategory through every role", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 49.64, lng: 16.04 }, "set-start", undefined, {
      name: "Devět skal vista",
      poiCategory: "viewpoint",
    });
    s.placeWaypoint({ lat: 49.2, lng: 16.6 }, "set-end", undefined, {
      name: "Hotel Ráztoka",
      poiCategory: "biker_hotel",
    });
    s.placeWaypoint({ lat: 49.5, lng: 16.3 }, "add-via", undefined, {
      name: "Benzina Frenštát",
      poiCategory: "fuel",
    });
    const waypoints =
      useTripStore.getState().activeTrip?.days[0]?.waypoints ?? [];
    expect(waypoints.map((w) => [w.type, w.name, w.poiCategory])).toEqual([
      ["start", "Devět skal vista", "viewpoint"],
      ["via", "Benzina Frenštát", "fuel"],
      ["end", "Hotel Ráztoka", "biker_hotel"],
    ]);
  });

  it("clears stale POI provenance when a start is re-placed without meta", () => {
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 49.64, lng: 16.04 }, "set-start", undefined, {
      name: "Devět skal vista",
      poiCategory: "viewpoint",
    });
    useTripStore
      .getState()
      .placeWaypoint({ lat: 50.0, lng: 14.4 }, "set-new-start");
    const start = useTripStore
      .getState()
      .activeTrip?.days[0]?.waypoints.find((w) => w.type === "start");
    expect(start?.poiCategory).toBeUndefined();
    expect(start?.location).toEqual({ lng: 14.4, lat: 50.0 });
  });
});

describe("renameActiveTrip", () => {
  it("renames the working trip WITHOUT dirtying the route, and supports undo", () => {
    useTripStore.setState({
      activeTrip: null,
      routeDirty: false,
      undoStack: [],
      redoStack: [],
      selectedDayIndex: 0,
    });
    const s = useTripStore.getState();
    s.placeWaypoint({ lat: 49.0, lng: 15.0 }, "set-start");
    useTripStore.setState({ routeDirty: false });

    useTripStore.getState().renameActiveTrip("  Vysočina dash  ");
    expect(useTripStore.getState().activeTrip?.name).toBe("Vysočina dash");
    // A rename is a metadata edit — arming Save route for it would
    // re-route the whole trip unpreviewed just to carry a title.
    expect(useTripStore.getState().routeDirty).toBe(false);

    useTripStore.getState().undo();
    expect(useTripStore.getState().activeTrip?.name).toBe("New Trip");
  });

  it("ignores empty and unchanged names", () => {
    const before = useTripStore.getState().activeTrip;
    useTripStore.getState().renameActiveTrip("   ");
    expect(useTripStore.getState().activeTrip).toBe(before);
  });
});

describe("applySplit save-gate", () => {
  it("marks the draft dirty so a split on a clean loaded route is saveable", () => {
    useTripStore.setState({ routeDirty: false, splitStatus: "none" });
    useTripStore.getState().applySplit([
      {
        dayNumber: 1,
        segmentIds: [],
        distanceKm: 120,
        timeMin: 150,
        quality: { score: 4, bands: [] } as never,
        startTown: "A",
        endTown: "B",
        suggestedStays: [],
        endKm: 120,
      },
    ]);
    expect(useTripStore.getState().splitStatus).toBe("split");
    expect(useTripStore.getState().routeDirty).toBe(true);
  });
});

describe("useTripStore applyRouteQuality (#862)", () => {
  beforeEach(() => {
    useTripStore.setState(useTripStore.getInitialState());
  });

  function routeResult(
    geometry: { lat: number; lng: number }[],
  ): RouteResponse {
    return {
      geometry,
      distance_km: 20,
      duration_min: 30,
      avg_quality: 4,
      curviness_score: 40,
      elevation_gain_m: 100,
      surface_mix: { asphalt: 20_000 },
    };
  }

  function qualitySegment(id: string): RouteSegment {
    return {
      id,
      geometry: {
        type: "LineString",
        coordinates: [
          [14.41, 50.08],
          [14.61, 50.19],
        ],
      },
      band: "good",
      surface: "asphalt",
      score: 4.2,
      passes: 12,
      lengthKm: 20,
      dayNumber: 1,
    };
  }

  // Seed a single day with committed geometry, returning the polyline the
  // quality would be computed against.
  function seedRoutedDay(): { lat: number; lng: number }[] {
    const store = useTripStore.getState();
    store.appendPlannerWaypoint(0, { lng: 14.41, lat: 50.08 });
    store.appendPlannerWaypoint(0, { lng: 14.61, lat: 50.19 });
    const geometry = [
      { lat: 50.08, lng: 14.41 },
      { lat: 50.19, lng: 14.61 },
    ];
    useTripStore.getState().applyRouteResult(1, routeResult(geometry));
    return geometry;
  }

  it("stores quality for a day whose geometry still matches", () => {
    const geometry = seedRoutedDay();
    const segments = [qualitySegment("d1-s0")];
    useTripStore.getState().applyRouteQuality(1, geometry, segments);
    expect(
      useTripStore.getState().activeTrip?.days[0]?.qualitySegments,
    ).toEqual(segments);
  });

  it("ignores a late response for a line the day no longer has", () => {
    seedRoutedDay();
    // Endpoint moved — a response computed for a since-replaced route.
    const staleGeometry = [
      { lat: 50.08, lng: 14.41 },
      { lat: 51.0, lng: 15.0 },
    ];
    useTripStore
      .getState()
      .applyRouteQuality(1, staleGeometry, [qualitySegment("d1-s0")]);
    expect(
      useTripStore.getState().activeTrip?.days[0]?.qualitySegments,
    ).toBeUndefined();
  });

  it("clears stored quality when the day is re-routed", () => {
    const geometry = seedRoutedDay();
    useTripStore
      .getState()
      .applyRouteQuality(1, geometry, [qualitySegment("d1-s0")]);
    expect(
      useTripStore.getState().activeTrip?.days[0]?.qualitySegments,
    ).toHaveLength(1);
    useTripStore.getState().applyRouteResult(
      1,
      routeResult([
        { lat: 50.08, lng: 14.41 },
        { lat: 50.3, lng: 14.8 },
      ]),
    );
    expect(
      useTripStore.getState().activeTrip?.days[0]?.qualitySegments,
    ).toBeUndefined();
  });
});
