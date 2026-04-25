import React from "react";
import { render, act } from "@testing-library/react-native";
import RideDurationTicker from "../RideDurationTicker";

const mockUpdateDuration = jest.fn();

interface MockRideState {
  isRiding: boolean;
  startedAtMs: number | null;
  updateDuration: typeof mockUpdateDuration;
}

let mockState: MockRideState;

jest.mock("@/stores", () => {
  function useRideStore(sel: (s: MockRideState) => unknown): unknown {
    return sel(mockState);
  }
  return { useRideStore };
});

describe("RideDurationTicker", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockUpdateDuration.mockReset();
    mockState = {
      isRiding: false,
      startedAtMs: null,
      updateDuration: mockUpdateDuration,
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("does nothing when no ride is active", () => {
    render(<RideDurationTicker />);
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(mockUpdateDuration).not.toHaveBeenCalled();
  });

  it("ticks store.duration once per second derived from startedAtMs", () => {
    const now = Date.now();
    mockState.isRiding = true;
    mockState.startedAtMs = now - 30_000; // 30 s ago

    render(<RideDurationTicker />);
    // Mount fires an immediate tick so the HUD doesn't show 0 for the
    // first second of a fresh ride.
    expect(mockUpdateDuration).toHaveBeenLastCalledWith(30);

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(mockUpdateDuration).toHaveBeenLastCalledWith(31);

    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockUpdateDuration).toHaveBeenLastCalledWith(33);
  });

  it("self-corrects after a missed tick (e.g. app suspended) by re-deriving from wall clock", () => {
    // The ticker writes the absolute elapsed seconds, not s+1, so even
    // if the OS suspends the JS interval for a few seconds the next
    // tick lands at the right total instead of accumulating drift.
    const realDateNow = Date.now;
    const startedAtMs = realDateNow();
    mockState.isRiding = true;
    mockState.startedAtMs = startedAtMs;

    render(<RideDurationTicker />);

    // Fast-forward the wall clock by 10 seconds without firing the
    // interval (simulating a suspension). When the interval finally
    // ticks, it should jump straight to 10.
    const dateSpy = jest
      .spyOn(Date, "now")
      .mockImplementation(() => startedAtMs + 10_000);
    try {
      act(() => {
        jest.advanceTimersByTime(1000);
      });
      expect(mockUpdateDuration).toHaveBeenLastCalledWith(10);
    } finally {
      dateSpy.mockRestore();
    }
  });
});
