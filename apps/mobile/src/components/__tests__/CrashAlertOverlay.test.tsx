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
import { api, type CrashAlertResponse } from "@/services/api";

const mockCrashAlertResponse: CrashAlertResponse = {
  alert_id: "00000000-0000-4000-8000-000000000000",
  contacts_notified: 1,
  contacts: [],
  idempotent_replay: false,
  dispatch_in_progress: false,
};

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
    mockedApi.sendCrashAlert.mockResolvedValue(mockCrashAlertResponse);
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
        expect.objectContaining({
          rideId: "ride-1",
          speedAtImpact: 65,
          // The store stamps a fresh UUID per incident; we don't pin
          // the literal value but we do assert it's threaded through.
          alertId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        }),
      ),
    );
    expect(useCrashStore.getState().phase).toBe("dispatched");
  });

  it("reuses the same alertId on RETRY so the backend can replay", async () => {
    // First attempt fails so the rider can hit RETRY. Both attempts
    // must carry the same incident-scoped UUID — otherwise the backend
    // treats the retry as a brand-new alert and re-notifies contacts.
    mockedApi.sendCrashAlert.mockRejectedValueOnce(new Error("network down"));
    mockedApi.sendCrashAlert.mockResolvedValueOnce(mockCrashAlertResponse);

    render(<CrashAlertOverlay countdownMs={1_000} />);
    act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    await waitFor(() => expect(useCrashStore.getState().phase).toBe("failed"));

    fireEvent.press(screen.getByLabelText(/retry crash alert/i));
    await waitFor(() =>
      expect(useCrashStore.getState().phase).toBe("dispatched"),
    );

    const firstAttemptOpts = mockedApi.sendCrashAlert.mock.calls[0][2];
    const retryOpts = mockedApi.sendCrashAlert.mock.calls[1][2];
    expect(firstAttemptOpts?.alertId).toBeDefined();
    expect(retryOpts?.alertId).toBe(firstAttemptOpts?.alertId);
  });

  it("shows ALERT FAILED when the backend reports zero contacts notified", async () => {
    // 200 OK but `contacts_notified: 0` (notifier unconfigured, every
    // send failed, no contacts on file). The rider must NOT see "HELP
    // IS ON THE WAY" in any of those cases — they need to fall back to
    // a manual call.
    mockedApi.sendCrashAlert.mockResolvedValueOnce({
      ...mockCrashAlertResponse,
      contacts_notified: 0,
      contacts: [
        {
          contact_id: "c-1",
          name: "Jane",
          channel: "sms",
          status: "failed",
          provider_message_id: null,
          error: "Twilio 5xx",
        },
      ],
    });

    render(<CrashAlertOverlay countdownMs={1_000} />);
    act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });

    await waitFor(() => expect(useCrashStore.getState().phase).toBe("failed"));
    expect(screen.getByText(/ALERT FAILED/i)).toBeTruthy();
  });

  it("shows a no-contacts message when the user has none configured", async () => {
    mockedApi.sendCrashAlert.mockResolvedValueOnce({
      ...mockCrashAlertResponse,
      contacts_notified: 0,
      contacts: [],
    });

    render(<CrashAlertOverlay countdownMs={1_000} />);
    act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });

    await waitFor(() => expect(useCrashStore.getState().phase).toBe("failed"));
    expect(useCrashStore.getState().errorMessage).toMatch(
      /No emergency contacts/i,
    );
  });

  it("hides the cancel button once dispatch starts", async () => {
    // Bugbot 1032971c: while the network call is in flight phase
    // flips to "dispatching" and the cancel button must be gone, so
    // a late tap on "I'm OK" can't pretend to cancel an alert that
    // has already been sent.
    let resolveSend: () => void = () => {};
    mockedApi.sendCrashAlert.mockImplementationOnce(
      () =>
        new Promise<CrashAlertResponse>((resolve) => {
          resolveSend = () => resolve(mockCrashAlertResponse);
        }),
    );
    render(<CrashAlertOverlay countdownMs={500} />);
    act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });

    await act(async () => {
      jest.advanceTimersByTime(800);
    });

    await waitFor(() =>
      expect(useCrashStore.getState().phase).toBe("dispatching"),
    );
    expect(screen.queryByLabelText(/cancel crash alert/i)).toBeNull();

    // Even calling cancel() programmatically while dispatching must be
    // a no-op so a stale tap from before the phase flipped can't reset
    // the store.
    act(() => useCrashStore.getState().cancel());
    expect(useCrashStore.getState().phase).toBe("dispatching");

    await act(async () => {
      resolveSend();
    });
    await waitFor(() =>
      expect(useCrashStore.getState().phase).toBe("dispatched"),
    );
  });

  it("refuses to dispatch when GPS has no fix at impact", async () => {
    // Bugbot 5069fc01: a previous version fell back to (0, 0) for null
    // lat/lng, dispatching a Null Island location to contacts during a
    // real crash. The overlay must surface a failure instead so the
    // rider knows to fall back to a manual call.
    render(<CrashAlertOverlay countdownMs={500} />);
    act(() => {
      useCrashStore.getState().startCountdown({
        triggeredAt: 1,
        rideId: "ride-99",
        lat: null,
        lng: null,
        speedAtImpact: null,
      });
    });

    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });

    await waitFor(() => expect(useCrashStore.getState().phase).toBe("failed"));
    expect(mockedApi.sendCrashAlert).not.toHaveBeenCalled();
    expect(useCrashStore.getState().errorMessage).toMatch(/no gps fix/i);
  });

  it("recomputes the countdown from wall clock when the app foregrounds", async () => {
    // Bugbot c2c8337d: on iOS the JS thread can be paused while the
    // app is backgrounded, freezing the displayed seconds at the
    // last value rendered before backgrounding. The previous nudge
    // `setRemainingMs(prev => prev)` was a useState bail-out and
    // produced no re-render — the UI stayed stale until the next
    // setInterval tick. The handler must instead recompute remaining
    // time directly from the start timestamp.
    const ReactNative = require("react-native");
    let appStateListener: ((s: string) => void) | null = null;
    const origAdd = ReactNative.AppState.addEventListener;
    ReactNative.AppState.addEventListener = jest.fn(
      (evt: string, cb: never) => {
        if (evt === "change") {
          appStateListener = cb as never as (s: string) => void;
        }
        return { remove: jest.fn() };
      },
    );

    try {
      render(<CrashAlertOverlay countdownMs={10_000} />);
      const baseline = Date.now();
      jest.setSystemTime(baseline);
      act(() => {
        useCrashStore.getState().startCountdown(snapshot());
      });

      // Initial render shows the full countdown.
      expect(screen.getByText("10")).toBeTruthy();

      // Simulate 7 seconds of wall-clock passing while the JS thread
      // was paused (no setInterval ticks). The displayed value would
      // remain stuck at "10" without the fix.
      jest.setSystemTime(baseline + 7_000);
      await act(async () => {
        appStateListener?.("active");
      });

      // Foreground recompute: 10s - 7s elapsed = 3s remaining.
      await waitFor(() => expect(screen.getByText("3")).toBeTruthy());
    } finally {
      ReactNative.AppState.addEventListener = origAdd;
    }
  });

  it("retry tap fires exactly one POST and hides the retry button", async () => {
    // Bugbot ac36c38f: the previous retry handler reset the in-flight
    // guard on every tap, so consecutive presses (or any other caller
    // re-invoking `dispatch()`) could queue a second
    // `POST /safety/crash-alert` — double-notifying emergency
    // contacts. Two defences now stack: pressing RETRY immediately
    // flips the phase to "dispatching" so the button unmounts
    // (preventing UI re-tap), and a separate `inFlightRef` guards
    // concurrent `dispatch()` calls from any other code path.
    let resolveSend: () => void = () => {};
    let pendingCount = 0;
    mockedApi.sendCrashAlert.mockImplementation(
      () =>
        new Promise<CrashAlertResponse>((resolve) => {
          pendingCount += 1;
          resolveSend = () => {
            pendingCount -= 1;
            resolve(mockCrashAlertResponse);
          };
        }),
    );
    render(<CrashAlertOverlay countdownMs={300} />);
    act(() => {
      useCrashStore.getState().startCountdown(snapshot());
      // Skip the countdown — drop straight into the failed terminal
      // state so the retry path is the only thing under test.
      useCrashStore.setState({ phase: "failed", errorMessage: "offline" });
    });

    fireEvent.press(screen.getByLabelText(/retry crash alert/i));

    // Single fire only — the button must unmount synchronously and any
    // re-invocation of `dispatch()` must short-circuit on the in-flight
    // ref until this request resolves.
    await waitFor(() => expect(pendingCount).toBe(1));
    expect(mockedApi.sendCrashAlert).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText(/retry crash alert/i)).toBeNull();
    expect(useCrashStore.getState().phase).toBe("dispatching");

    await act(async () => {
      resolveSend();
    });
    await waitFor(() =>
      expect(useCrashStore.getState().phase).toBe("dispatched"),
    );
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
