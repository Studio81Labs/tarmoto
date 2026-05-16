import { useTripStore } from "./trip";
import type { TripParameters } from "@/lib/types";

describe("useTripStore planner editing", () => {
  beforeEach(() => {
    useTripStore.setState(useTripStore.getInitialState());
  });

  it("creates a draft trip from map clicks and recalculates route metrics in real time", () => {
    const store = useTripStore.getState();

    store.appendPlannerWaypoint(0, { lng: 14.41, lat: 50.08 });
    store.appendPlannerWaypoint(0, { lng: 14.61, lat: 50.19 });

    const firstSolvedDay = useTripStore.getState().activeTrip?.days[0];
    expect(firstSolvedDay?.waypoints.map((waypoint) => waypoint.type)).toEqual([
      "start",
      "end",
    ]);
    expect(firstSolvedDay?.routeGeometry?.coordinates.length).toBeGreaterThan(
      2,
    );
    expect(firstSolvedDay?.distanceKm).toBeGreaterThan(0);
    expect(firstSolvedDay?.durationMinutes).toBeGreaterThan(0);

    const twoPointDistance = firstSolvedDay?.distanceKm ?? 0;

    useTripStore
      .getState()
      .appendPlannerWaypoint(0, { lng: 14.52, lat: 50.24 });

    const rebuiltDay = useTripStore.getState().activeTrip?.days[0];
    expect(rebuiltDay?.waypoints.map((waypoint) => waypoint.type)).toEqual([
      "start",
      "via",
      "end",
    ]);
    expect(rebuiltDay?.distanceKm).toBeGreaterThan(twoPointDistance);
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

  it("uses the current planner parameters when map clicks create and rebuild a draft", () => {
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
    expect(activeTrip?.days[0]?.routeGeometry?.coordinates).toEqual([
      [14.41, 50.08],
      [14.61, 50.19],
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

  it("moves an existing routing waypoint and rebuilds the day route geometry", () => {
    const store = useTripStore.getState();

    store.appendPlannerWaypoint(0, { lng: 14.41, lat: 50.08 });
    store.appendPlannerWaypoint(0, { lng: 14.61, lat: 50.19 });

    const beforeMove = useTripStore.getState().activeTrip?.days[0];
    const startWaypoint = beforeMove?.waypoints[0];
    expect(startWaypoint?.type).toBe("start");
    expect(startWaypoint?.id).toBeDefined();
    const beforeGeometry = beforeMove?.routeGeometry?.coordinates ?? [];
    expect(beforeGeometry.length).toBeGreaterThan(0);

    useTripStore
      .getState()
      .moveWaypoint(0, startWaypoint!.id, { lng: 14.5, lat: 50.12 });

    const afterMove = useTripStore.getState().activeTrip?.days[0];
    expect(afterMove?.waypoints[0]?.location).toEqual({
      lng: 14.5,
      lat: 50.12,
    });
    expect(afterMove?.waypoints[0]?.id).toBe(startWaypoint!.id);
    expect(afterMove?.routeGeometry?.coordinates).not.toEqual(beforeGeometry);
    expect(afterMove?.routeGeometry?.coordinates[0]).toEqual([14.5, 50.12]);
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
