/**
 * LocationService — multi-consumer watch sharing.
 *
 * One OS `watchPosition` is shared between the ride recorder (`start`/`stop`,
 * which owns the trip odometer) and independent subscribers (navigation, via
 * `subscribe`). The invariants that matter: a subscriber must never reset the
 * ride's distance, and unsubscribing a subscriber must not tear the watch out
 * from under a recording ride (the `basic_navigation` kill-switch bug).
 */

let mockWatchCallback: ((position: unknown) => void) | null = null;
let mockWatchId = 0;
const mockClearWatch = jest.fn();

jest.mock("@react-native-community/geolocation", () => ({
  __esModule: true,
  default: {
    watchPosition: jest.fn((success: (position: unknown) => void) => {
      mockWatchCallback = success;
      return ++mockWatchId;
    }),
    clearWatch: (id: number) => mockClearWatch(id),
  },
}));

jest.mock("../sensors", () => ({
  sensorService: { updateLocation: jest.fn() },
}));

import Geolocation from "@react-native-community/geolocation";
import { locationService } from "../location";

const watchPositionMock = Geolocation.watchPosition as jest.Mock;

function emit(lat: number, lng: number): void {
  mockWatchCallback?.({
    coords: {
      latitude: lat,
      longitude: lng,
      speed: 10,
      accuracy: 5,
      altitude: 100,
    },
    timestamp: 1,
  });
}

describe("locationService multi-consumer watch", () => {
  beforeEach(() => {
    // Reset the singleton between cases.
    locationService.stop();
    watchPositionMock.mockClear();
    mockClearWatch.mockClear();
    mockWatchCallback = null;
  });

  it("fans a single watch out to the ride recorder and a subscriber", () => {
    const ride = jest.fn();
    const nav = jest.fn();

    locationService.start(ride);
    const unsub = locationService.subscribe(nav);

    // Only ONE OS watch for both consumers.
    expect(watchPositionMock).toHaveBeenCalledTimes(1);

    emit(49.5, 18.1);
    expect(ride).toHaveBeenCalledTimes(1);
    expect(nav).toHaveBeenCalledTimes(1);

    unsub();
  });

  it("keeps the ride feed alive when a subscriber unsubscribes", () => {
    const ride = jest.fn();
    const nav = jest.fn();

    locationService.start(ride);
    const unsub = locationService.subscribe(nav);

    // Navigation closes (e.g. basic_navigation kill flips trackLocation off).
    unsub();
    // The watch must NOT be cleared — the ride still needs it.
    expect(mockClearWatch).not.toHaveBeenCalled();

    emit(49.5, 18.1);
    expect(ride).toHaveBeenCalledTimes(1); // ride still receiving fixes
    expect(nav).not.toHaveBeenCalled(); // nav no longer receiving
  });

  it("does not reset the ride odometer when a subscriber joins", () => {
    locationService.start(jest.fn());
    emit(49.5, 18.1);
    emit(49.5005, 18.1); // ~55 m — inside the 1–500 m accrual window
    const distanceBefore = locationService.getDistance();
    expect(distanceBefore).toBeGreaterThan(0);

    // Navigation opens mid-ride — must not zero the trip odometer.
    const unsub = locationService.subscribe(jest.fn());
    expect(locationService.getDistance()).toBe(distanceBefore);
    unsub();
  });

  it("clears the watch only when BOTH the ride and all subscribers are gone", () => {
    const unsub = locationService.subscribe(jest.fn());
    locationService.start(jest.fn());
    expect(watchPositionMock).toHaveBeenCalledTimes(1);

    // Ride stops but nav is still subscribed → watch stays.
    locationService.stop();
    expect(mockClearWatch).not.toHaveBeenCalled();

    // Last consumer leaves → watch cleared.
    unsub();
    expect(mockClearWatch).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing subscriber from the ride feed", () => {
    const ride = jest.fn();
    const bad = jest.fn(() => {
      throw new Error("nav listener blew up");
    });

    locationService.start(ride);
    const unsub = locationService.subscribe(bad);

    expect(() => emit(49.5, 18.1)).not.toThrow();
    expect(ride).toHaveBeenCalledTimes(1);
    unsub();
  });
});
