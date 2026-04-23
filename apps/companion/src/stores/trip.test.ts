import { useTripStore } from "./trip";

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
});
