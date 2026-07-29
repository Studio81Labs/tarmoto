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
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import { ttsService } from "@/services/tts";
import HapticFeedback from "react-native-haptic-feedback";
import { I18nProvider } from "@/i18n/I18nProvider";

const mockCrashAlertResponse: CrashAlertResponse = {
  alert_id: "00000000-0000-4000-8000-000000000000",
  contacts_notified: 1,
  contacts: [],
  idempotent_replay: false,
  dispatch_in_progress: false,
};

jest.mock("@/components/Icon", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  const MockIcon = ({ name }: { name?: string }) =>
    ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  return { Icon: MockIcon };
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
    cancelByKeyPrefix: jest.fn(),
  },
}));

jest.mock("@/services/api", () => ({
  api: {
    sendCrashAlert: jest.fn(),
  },
}));

jest.mock("@/services/systemSwitchCache", () => ({
  isFeatureKillSwitchActive: jest.fn(() => true),
}));

jest.mock("@/hooks/useFeatureKillSwitch", () => ({
  useFeatureKillSwitchActive: jest.fn(() => true),
}));

const mockedApi = api as jest.Mocked<typeof api>;
const mockedReactiveKill = useFeatureKillSwitchActive as jest.MockedFunction<
  typeof useFeatureKillSwitchActive
>;
const mockedKillSwitch = isFeatureKillSwitchActive as jest.MockedFunction<
  typeof isFeatureKillSwitchActive
>;
const mockedSpeak = jest.mocked(ttsService.speak);
const mockedHapticTrigger = jest.mocked(HapticFeedback.trigger);

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
    mockedKillSwitch.mockReset();
    mockedKillSwitch.mockReturnValue(true);
    mockedReactiveKill.mockReset();
    mockedReactiveKill.mockReturnValue(true);
    (ttsService.cancelByKeyPrefix as jest.Mock).mockReset();
    mockedSpeak.mockReset();
    mockedHapticTrigger.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("renders nothing when the store is idle", async () => {
    const { toJSON } = await render(<CrashAlertOverlay countdownMs={1_000} />);
    // Modal returns null when no alert is active.
    expect(toJSON()).toBeNull();
  });

  it("shows the countdown when an alert is active", async () => {
    await render(<CrashAlertOverlay countdownMs={3_000} />);
    await act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });

    expect(screen.getByText("CRASH DETECTED")).toBeTruthy();
    expect(screen.getByText("seconds")).toBeTruthy();
    expect(screen.getByLabelText(/cancel crash alert/i)).toBeTruthy();
    expect(mockedSpeak).toHaveBeenCalledWith(
      "Crash detected. Tap I'm OK to cancel, or help will be alerted.",
      { priority: "high", key: "crash:countdown" },
    );
  });

  it("does not restart the crash alarm when the regional locale changes", async () => {
    const view = await render(
      <I18nProvider locale="en" numberLocale="en-US">
        <CrashAlertOverlay countdownMs={3_000} />
      </I18nProvider>,
    );
    await act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });

    expect(mockedSpeak).toHaveBeenCalledTimes(1);
    expect(mockedHapticTrigger).toHaveBeenCalledTimes(1);

    await view.rerender(
      <I18nProvider locale="en" numberLocale="en-GB">
        <CrashAlertOverlay countdownMs={3_000} />
      </I18nProvider>,
    );

    expect(mockedSpeak).toHaveBeenCalledTimes(1);
    expect(mockedHapticTrigger).toHaveBeenCalledTimes(1);
  });

  it("uses the singular countdown unit at one second", async () => {
    await render(<CrashAlertOverlay countdownMs={1_000} />);
    await act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });

    expect(screen.getByText("second")).toBeTruthy();
  });

  it("clears the store and never calls the API when the rider cancels", async () => {
    await render(<CrashAlertOverlay countdownMs={3_000} />);
    await act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });

    await fireEvent.press(screen.getByLabelText(/cancel crash alert/i));

    expect(useCrashStore.getState().phase).toBe("idle");
    expect(mockedApi.sendCrashAlert).not.toHaveBeenCalled();
  });

  it("dispatches the alert when the countdown elapses", async () => {
    await render(<CrashAlertOverlay countdownMs={1_000} />);
    await act(() => {
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

  it("never POSTs and dismisses to idle when the operator kill switch is off", async () => {
    // Belt-and-braces: an operator force-disables crash_detection AFTER a
    // countdown was already armed. The elapsed-countdown dispatch must not send
    // the SOS, and must reset the overlay to idle so the rider isn't stranded.
    mockedKillSwitch.mockImplementation((key) => key !== "crash_detection");
    await render(<CrashAlertOverlay countdownMs={1_000} />);
    await act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });

    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });

    expect(mockedApi.sendCrashAlert).not.toHaveBeenCalled();
    expect(useCrashStore.getState().phase).toBe("idle");
  });

  it("tears down an armed countdown immediately when crash_detection is killed", async () => {
    // Operator flips crash_detection off DURING the countdown (false-alert
    // incident). The overlay must react reactively — not wait ~30s for the
    // dispatch-time gate — dismissing the alert and cancelling crash speech.
    mockedReactiveKill.mockReturnValue(false); // killed
    await render(<CrashAlertOverlay countdownMs={30_000} />);
    await act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });

    // Reset to idle without advancing the timer, and crash speech cancelled.
    expect(useCrashStore.getState().phase).toBe("idle");
    expect(ttsService.cancelByKeyPrefix).toHaveBeenCalledWith("crash:");
  });

  it("does NOT tear down a dispatching alert when crash_detection is killed", async () => {
    // Once the SOS POST has gone out (phase left `countdown`), the rider MUST
    // still see whether help was contacted — a kill must not yank it to idle.
    mockedReactiveKill.mockReturnValue(false); // killed
    await render(<CrashAlertOverlay countdownMs={30_000} />);
    await act(() => {
      useCrashStore.getState().startCountdown(snapshot());
      useCrashStore.getState().beginDispatch();
    });

    // Still dispatching (not reset to idle), and the crash speech wasn't cut.
    expect(useCrashStore.getState().phase).toBe("dispatching");
    expect(ttsService.cancelByKeyPrefix).not.toHaveBeenCalled();
  });

  it("keeps the same alertId on RETRY after a transient failure so the backend can replay", async () => {
    // Network errors / 5xx are transient: the original POST may have
    // landed and recorded the alert (or not), but EITHER WAY rotating
    // the id risks a double-dispatch — the backend's idempotency
    // replay can only deduplicate when the same key comes back. So
    // for transient failures the overlay must keep the id.
    mockedApi.sendCrashAlert.mockRejectedValueOnce(new Error("network down"));
    mockedApi.sendCrashAlert.mockResolvedValueOnce(mockCrashAlertResponse);

    await render(<CrashAlertOverlay countdownMs={1_000} />);
    await act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    await waitFor(() => expect(useCrashStore.getState().phase).toBe("failed"));
    expect(useCrashStore.getState().failureSource).toBe("transient");

    await fireEvent.press(screen.getByLabelText(/retry crash alert/i));
    await waitFor(() =>
      expect(useCrashStore.getState().phase).toBe("dispatched"),
    );

    const firstAttemptOpts = mockedApi.sendCrashAlert.mock.calls[0]?.[2];
    const retryOpts = mockedApi.sendCrashAlert.mock.calls[1]?.[2];
    expect(firstAttemptOpts?.alertId).toBeDefined();
    expect(retryOpts?.alertId).toBe(firstAttemptOpts?.alertId);
  });

  it("keeps the same alertId across in-flight replay polls so the backend resolves a single dispatch", async () => {
    // In-flight polling is the OPPOSITE of manual RETRY: the original
    // dispatch is still working server-side, and we want to read its
    // eventual outcome — not start a fresh one. So the auto-poll must
    // reuse the same alertId.
    mockedApi.sendCrashAlert
      .mockResolvedValueOnce({
        ...mockCrashAlertResponse,
        contacts_notified: 0,
        contacts: [],
        idempotent_replay: true,
        dispatch_in_progress: true,
      })
      .mockResolvedValueOnce({
        ...mockCrashAlertResponse,
        idempotent_replay: true,
        dispatch_in_progress: false,
      });

    await render(<CrashAlertOverlay countdownMs={1_000} />);
    await act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    await act(async () => {
      jest.advanceTimersByTime(3_500);
    });
    await waitFor(() =>
      expect(useCrashStore.getState().phase).toBe("dispatched"),
    );

    const initial = mockedApi.sendCrashAlert.mock.calls[0]?.[2];
    const poll = mockedApi.sendCrashAlert.mock.calls[1]?.[2];
    expect(poll?.alertId).toBe(initial?.alertId);
  });

  it("stays on the dispatching phase and re-polls when the backend reports an in-flight replay", async () => {
    // Idempotent replay: the original POST is still being processed
    // server-side, so the response carries `dispatch_in_progress: true`
    // and zero notified contacts. The UI must NOT misclassify that as
    // a failure — it should keep "ALERTING CONTACTS…" and re-poll for
    // the eventual outcome. The follow-up poll resolves with the real
    // success state.
    mockedApi.sendCrashAlert
      .mockResolvedValueOnce({
        ...mockCrashAlertResponse,
        contacts_notified: 0,
        contacts: [],
        idempotent_replay: true,
        dispatch_in_progress: true,
      })
      .mockResolvedValueOnce({
        ...mockCrashAlertResponse,
        idempotent_replay: true,
        dispatch_in_progress: false,
      });

    await render(<CrashAlertOverlay countdownMs={1_000} />);
    await act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });

    // First call already returned in-flight; phase must still be
    // dispatching, not failed.
    await waitFor(() =>
      expect(useCrashStore.getState().phase).toBe("dispatching"),
    );

    // Advance past the in-flight poll delay so the follow-up call
    // fires and resolves with the completed state.
    await act(async () => {
      jest.advanceTimersByTime(3_500);
    });

    await waitFor(() =>
      expect(useCrashStore.getState().phase).toBe("dispatched"),
    );
    expect(mockedApi.sendCrashAlert).toHaveBeenCalledTimes(2);
  });

  it("falls back to a 'still dispatching' failure after exhausting in-flight polls", async () => {
    // If the backend gets stuck reporting in-flight, bound the polling
    // so we don't loop forever. The poll cap is sized to fit inside
    // the backend's 5/min throttle alongside a couple of manual
    // retries (initial + 2 polls = 3 calls in ~6s, leaving 2 in
    // budget); after the cap the UI surfaces a manual-retry message.
    mockedApi.sendCrashAlert.mockResolvedValue({
      ...mockCrashAlertResponse,
      contacts_notified: 0,
      contacts: [],
      idempotent_replay: true,
      dispatch_in_progress: true,
    });

    await render(<CrashAlertOverlay countdownMs={1_000} />);
    await act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });

    // Drive 2 polls (each 3 s apart); the 3rd attempt is suppressed.
    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(3_500);
      });
    }

    await waitFor(() => expect(useCrashStore.getState().phase).toBe("failed"));
    expect(useCrashStore.getState().errorMessage).toMatch(/still being sent/i);
    // 1 initial + 2 polls = 3 calls; no further calls afterward.
    expect(mockedApi.sendCrashAlert).toHaveBeenCalledTimes(3);
  });

  it("recovers from a server-recorded permanent failure when the rider taps RETRY", async () => {
    // First dispatch reaches the backend and completes with every
    // contact's send rejected — the row is recorded as completed with
    // `contacts_notified: 0`. Without rotating the alertId on RETRY,
    // the next attempt would short-circuit to that recorded failure
    // replay and the rider could never actually retry. The overlay
    // rotates the id, so the second attempt is a fresh dispatch.
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
    mockedApi.sendCrashAlert.mockResolvedValueOnce(mockCrashAlertResponse);

    await render(<CrashAlertOverlay countdownMs={1_000} />);
    await act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    await waitFor(() => expect(useCrashStore.getState().phase).toBe("failed"));

    await fireEvent.press(screen.getByLabelText(/retry crash alert/i));
    await waitFor(() =>
      expect(useCrashStore.getState().phase).toBe("dispatched"),
    );

    const firstAttemptOpts = mockedApi.sendCrashAlert.mock.calls[0]?.[2];
    const retryOpts = mockedApi.sendCrashAlert.mock.calls[1]?.[2];
    expect(retryOpts?.alertId).not.toBe(firstAttemptOpts?.alertId);
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

    await render(<CrashAlertOverlay countdownMs={1_000} />);
    await act(() => {
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

    await render(<CrashAlertOverlay countdownMs={1_000} />);
    await act(() => {
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
    await render(<CrashAlertOverlay countdownMs={500} />);
    await act(() => {
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
    await act(() => useCrashStore.getState().cancel());
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
    await render(<CrashAlertOverlay countdownMs={500} />);
    await act(() => {
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
      await render(<CrashAlertOverlay countdownMs={10_000} />);
      const baseline = Date.now();
      jest.setSystemTime(baseline);
      await act(() => {
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
    await render(<CrashAlertOverlay countdownMs={300} />);
    await act(() => {
      useCrashStore.getState().startCountdown(snapshot());
      // Skip the countdown — drop straight into the failed terminal
      // state so the retry path is the only thing under test.
      useCrashStore.setState({ phase: "failed", errorMessage: "offline" });
    });

    await fireEvent.press(screen.getByLabelText(/retry crash alert/i));

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

  it("stores a translated generic failure when the API rejects", async () => {
    mockedApi.sendCrashAlert.mockRejectedValueOnce(new Error("offline"));
    await render(<CrashAlertOverlay countdownMs={500} />);
    await act(() => {
      useCrashStore.getState().startCountdown(snapshot());
    });

    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });

    await waitFor(() => expect(useCrashStore.getState().phase).toBe("failed"));
    expect(useCrashStore.getState().errorMessage).toBe(
      "Couldn't reach the server.",
    );
  });
});
