/**
 * CrashAlertOverlay — countdown / cancel / dispatch state machine
 * (US-12 AC #2/#3).
 */
import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import CrashAlertOverlay from "../CrashAlertOverlay";
import { useCrashStore } from "@/stores";
import { api } from "@/services/api";

jest.mock("@react-native-vector-icons/material-design-icons", () => {
  const ReactLib = require("react");
  const { Text } = require("react-native");
  return function MockIcon({ name }: { name?: string }) {
    return ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  };
});

jest.mock("react-native-haptic-feedback", () => ({
  __esModule: true,
  default: { trigger: jest.fn() },
}));

jest.mock("@/services/tts", () => ({
  ttsService: {
    speak: jest.fn(),
    isMuted: jest.fn(() => false),
    setMuted: jest.fn(),
  },
}));

jest.mock("@/services/api", () => ({
  api: {
    sendCrashAlert: jest.fn(),
  },
}));

const mockedApi = api as jest.Mocked<typeof api>;

function snapshot() {
  return {
    triggeredAt: 1_700_000_000_000,
    rideId: "ride-1",
    lat: 49.82,
    lng: 18.26,
    speedAtImpact: 65,
  };
}

describe("CrashAlertOverlay", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    useCrashStore.setState({
      phase: "idle",
      alert: null,
      errorMessage: null,
    });
    mockedApi.sendCrashAlert.mockReset();
    mockedApi.sendCrashAlert.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("renders nothing when the store is idle", () => {
    const { toJSON } = render(<CrashAlertOverlay countdownMs={1_000} />);
    // Modal returns null when no alert is active.
    expect(toJSON()).toBeNull();
  });

  it("shows the countdown when an alert is active", () => {
    render(<CrashAlertOverlay countdownMs={3_000} />);
    act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });

    expect(screen.getByText("CRASH DETECTED")).toBeTruthy();
    expect(screen.getByLabelText(/cancel crash alert/i)).toBeTruthy();
  });

  it("clears the store and never calls the API when the rider cancels", () => {
    render(<CrashAlertOverlay countdownMs={3_000} />);
    act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });

    fireEvent.press(screen.getByLabelText(/cancel crash alert/i));

    expect(useCrashStore.getState().phase).toBe("idle");
    expect(mockedApi.sendCrashAlert).not.toHaveBeenCalled();
  });

  it("dispatches the alert when the countdown elapses", async () => {
    render(<CrashAlertOverlay countdownMs={1_000} />);
    act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });

    // Advance past the countdown plus a tick so the elapsed-check
    // setInterval lands a 0 reading.
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });

    await waitFor(() =>
      expect(mockedApi.sendCrashAlert).toHaveBeenCalledWith(
        49.82,
        18.26,
        "ride-1",
        65,
      ),
    );
    expect(useCrashStore.getState().phase).toBe("dispatched");
  });

  it("flips to failed state when the API rejects", async () => {
    mockedApi.sendCrashAlert.mockRejectedValueOnce(new Error("offline"));
    render(<CrashAlertOverlay countdownMs={500} />);
    act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });

    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });

    await waitFor(() => expect(useCrashStore.getState().phase).toBe("failed"));
    expect(useCrashStore.getState().errorMessage).toBe("offline");
  });
});
