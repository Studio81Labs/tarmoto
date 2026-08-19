/**
 * Ride store — core lifecycle transitions.
 *
 * Focus: startRide/stopRide reset invariants, counters advance, and
 * defaults match the contract the screens read.
 */

import { useRideStore } from "../index";

const INITIAL_STATE = {
  activeRide: null,
  isRiding: false,
  rideType: "free" as const,
  currentSpeed: 0,
  currentQuality: null,
  location: null,
  distance: 0,
  duration: 0,
  segmentCount: 0,
  recentRides: [],
};

describe("useRideStore", () => {
  beforeEach(() => {
    useRideStore.setState(INITIAL_STATE);
  });

  it("startRide resets per-ride counters and flags isRiding", () => {
    useRideStore.setState({ distance: 100, duration: 60, segmentCount: 5 });
    useRideStore.getState().startRide("trip");

    const state = useRideStore.getState();
    expect(state.isRiding).toBe(true);
    expect(state.rideType).toBe("trip");
    expect(state.distance).toBe(0);
    expect(state.duration).toBe(0);
    expect(state.segmentCount).toBe(0);
    expect(state.currentQuality).toBeNull();
  });

  it('startRide defaults rideType to "free" when omitted', () => {
    useRideStore.getState().startRide();
    expect(useRideStore.getState().rideType).toBe("free");
  });

  it("stopRide clears active state and current speed", () => {
    useRideStore.getState().startRide("free");
    useRideStore.getState().updateSpeed(42);
    useRideStore.getState().stopRide();

    const state = useRideStore.getState();
    expect(state.isRiding).toBe(false);
    expect(state.activeRide).toBeNull();
    expect(state.currentSpeed).toBe(0);
    expect(state.currentQuality).toBeNull();
  });

  it("incrementSegments advances the counter monotonically", () => {
    useRideStore.getState().incrementSegments();
    useRideStore.getState().incrementSegments();
    useRideStore.getState().incrementSegments();
    expect(useRideStore.getState().segmentCount).toBe(3);
  });

  it("update* methods set values in isolation", () => {
    useRideStore.getState().updateDistance(1234);
    useRideStore.getState().updateDuration(567);
    useRideStore.getState().updateSpeed(55);

    const state = useRideStore.getState();
    expect(state.distance).toBe(1234);
    expect(state.duration).toBe(567);
    expect(state.currentSpeed).toBe(55);
    expect(state.isRiding).toBe(false); // update* alone shouldn't start a ride
  });
});
