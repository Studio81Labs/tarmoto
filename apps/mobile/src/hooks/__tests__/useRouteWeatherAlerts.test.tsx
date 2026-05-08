/**
 * useRouteWeatherAlerts — US-13 navigation weather feed.
 *
 * Focus: gating (disabled / unusable polyline), the initial-poll path,
 * `progressM`-based ahead-only filter, and TTS gating. The polling
 * cadence itself is asserted at the React-effect level (interval is
 * created when enabled, torn down on unmount); we don't drive the
 * interval here — fake timers don't compose with React 19 effects and
 * real-timer races against `waitFor` were causing OOMs in CI.
 */

import { renderHook, waitFor } from "@testing-library/react-native";
import { useRouteWeatherAlerts } from "../useRouteWeatherAlerts";
import { api } from "@/services/api";
import { ttsService } from "@/services/tts";
import type { LatLng, RouteWeatherResponse, WeatherAlert } from "@/types";

jest.mock("@/services/api", () => ({
  api: {
    getRouteWeather: jest.fn(),
  },
}));

jest.mock("@/services/tts", () => ({
  ttsService: {
    speak: jest.fn(),
    setMuted: jest.fn(),
    isMuted: jest.fn(() => false),
  },
}));

const polyline: LatLng[] = [
  { lat: 49.0, lng: 16.0 },
  { lat: 50.0, lng: 17.0 },
];

function buildResponse(alerts: WeatherAlert[]): RouteWeatherResponse {
  return {
    points: [],
    has_alerts: alerts.length > 0,
    alerts: alerts.map((a) => a.message),
    typed_alerts: alerts,
  };
}

function buildAlert(overrides: Partial<WeatherAlert>): WeatherAlert {
  return {
    id: "storm-0",
    kind: "storm",
    severity: "critical",
    lat: 49.0,
    lng: 16.0,
    distance_km_from_start: 0,
    title: "Storm warning",
    message: "Severe storm ahead.",
    ...overrides,
  };
}

const HUGE_INTERVAL_MS = 60 * 60 * 1000;

describe("useRouteWeatherAlerts", () => {
  const getRouteWeatherMock = api.getRouteWeather as jest.MockedFunction<
    typeof api.getRouteWeather
  >;
  const speakMock = ttsService.speak as jest.MockedFunction<
    typeof ttsService.speak
  >;

  beforeEach(() => {
    getRouteWeatherMock.mockReset();
    speakMock.mockReset();
  });

  it("returns no alerts and skips polling when disabled", () => {
    const { result } = renderHook(() =>
      useRouteWeatherAlerts({
        polyline,
        progressM: null,
        enabled: false,
        voiceEnabled: true,
        intervalMs: HUGE_INTERVAL_MS,
      }),
    );

    expect(result.current.alerts).toEqual([]);
    expect(getRouteWeatherMock).not.toHaveBeenCalled();
  });

  it("returns no alerts and skips polling when polyline is unusable", () => {
    renderHook(() =>
      useRouteWeatherAlerts({
        polyline: [{ lat: 1, lng: 1 }],
        progressM: null,
        enabled: true,
        voiceEnabled: true,
        intervalMs: HUGE_INTERVAL_MS,
      }),
    );

    expect(getRouteWeatherMock).not.toHaveBeenCalled();
  });

  it("fetches on mount and surfaces typed alerts", async () => {
    const alert = buildAlert({ id: "storm-1", distance_km_from_start: 25 });
    getRouteWeatherMock.mockResolvedValue(buildResponse([alert]));

    const { result, unmount } = renderHook(() =>
      useRouteWeatherAlerts({
        polyline,
        progressM: null,
        enabled: true,
        voiceEnabled: true,
        intervalMs: HUGE_INTERVAL_MS,
      }),
    );

    await waitFor(() => expect(result.current.alerts).toHaveLength(1));
    expect(result.current.alerts[0]?.id).toBe("storm-1");
    unmount();
  });

  it("hides alerts the rider has already passed", async () => {
    const passed = buildAlert({
      id: "wind-0",
      severity: "warning",
      kind: "wind",
      distance_km_from_start: 5,
    });
    const ahead = buildAlert({
      id: "storm-3",
      distance_km_from_start: 30,
    });
    getRouteWeatherMock.mockResolvedValue(buildResponse([passed, ahead]));

    // Rider is 10 km in — `passed` (5 km) is behind, `ahead` (30 km) is not.
    const { result, unmount } = renderHook(() =>
      useRouteWeatherAlerts({
        polyline,
        progressM: 10_000,
        enabled: true,
        voiceEnabled: true,
        intervalMs: HUGE_INTERVAL_MS,
      }),
    );

    await waitFor(() => expect(result.current.alerts).toHaveLength(1));
    expect(result.current.alerts[0]?.id).toBe("storm-3");
    unmount();
  });

  it("speaks critical alerts on mount", async () => {
    const critical = buildAlert({ id: "storm-9", distance_km_from_start: 12 });
    getRouteWeatherMock.mockResolvedValue(buildResponse([critical]));

    const { unmount } = renderHook(() =>
      useRouteWeatherAlerts({
        polyline,
        progressM: null,
        enabled: true,
        voiceEnabled: true,
        intervalMs: HUGE_INTERVAL_MS,
      }),
    );

    await waitFor(() => expect(speakMock).toHaveBeenCalledTimes(1));
    expect(speakMock).toHaveBeenCalledWith(
      expect.stringContaining("Storm warning"),
      // Critical weather alerts ride on the high-priority lane so they
      // preempt nav prompts (US-16 AC #3). The dedupe key keeps a
      // re-fired identical alert from stacking inside that lane.
      expect.objectContaining({ priority: "high" }),
    );
    unmount();
  });

  it("does not speak critical alerts the rider has already passed", async () => {
    const passed = buildAlert({
      id: "storm-passed",
      severity: "critical",
      kind: "storm",
      distance_km_from_start: 5,
      message: "PASSED storm message",
    });
    const ahead = buildAlert({
      id: "storm-ahead",
      severity: "critical",
      kind: "storm",
      distance_km_from_start: 30,
      message: "AHEAD storm message",
    });
    getRouteWeatherMock.mockResolvedValue(buildResponse([passed, ahead]));

    // Rider is at 10 km in. The banner already filters `passed` out at
    // render time; this test guards the parallel filter inside the
    // polling effect so TTS doesn't contradict the visual UI.
    const { result, unmount } = renderHook(() =>
      useRouteWeatherAlerts({
        polyline,
        progressM: 10_000,
        enabled: true,
        voiceEnabled: true,
        intervalMs: HUGE_INTERVAL_MS,
      }),
    );

    await waitFor(() => expect(result.current.alerts).toHaveLength(1));
    expect(result.current.alerts[0]?.id).toBe("storm-ahead");
    expect(speakMock).toHaveBeenCalledTimes(1);
    const spokenPhrases = speakMock.mock.calls.map((c) => c[0]);
    expect(spokenPhrases.some((p) => p.includes("AHEAD"))).toBe(true);
    expect(spokenPhrases.some((p) => p.includes("PASSED"))).toBe(false);
    unmount();
  });

  it("skips TTS when voice is disabled, even for critical alerts", async () => {
    const critical = buildAlert({ id: "ice-0", kind: "ice" });
    getRouteWeatherMock.mockResolvedValue(buildResponse([critical]));

    const { result, unmount } = renderHook(() =>
      useRouteWeatherAlerts({
        polyline,
        progressM: null,
        enabled: true,
        voiceEnabled: false,
        intervalMs: HUGE_INTERVAL_MS,
      }),
    );

    await waitFor(() => expect(result.current.alerts).toHaveLength(1));
    expect(speakMock).not.toHaveBeenCalled();
    unmount();
  });

  it("never speaks non-critical alerts", async () => {
    const wind = buildAlert({
      id: "wind-2",
      kind: "wind",
      severity: "warning",
    });
    const wet = buildAlert({
      id: "wet-2",
      kind: "wet",
      severity: "info",
    });
    getRouteWeatherMock.mockResolvedValue(buildResponse([wind, wet]));

    const { result, unmount } = renderHook(() =>
      useRouteWeatherAlerts({
        polyline,
        progressM: null,
        enabled: true,
        voiceEnabled: true,
        intervalMs: HUGE_INTERVAL_MS,
      }),
    );

    await waitFor(() => expect(result.current.alerts).toHaveLength(2));
    expect(speakMock).not.toHaveBeenCalled();
    unmount();
  });

  it("swallows transport failures with no banner update — no error to the rider", async () => {
    getRouteWeatherMock.mockRejectedValue(new Error("offline"));

    const { result, unmount } = renderHook(() =>
      useRouteWeatherAlerts({
        polyline,
        progressM: null,
        enabled: true,
        voiceEnabled: true,
        intervalMs: HUGE_INTERVAL_MS,
      }),
    );

    // Give the mock a microtask to reject and the state to settle.
    await waitFor(() => expect(getRouteWeatherMock).toHaveBeenCalledTimes(1));
    expect(result.current.alerts).toEqual([]);
    expect(speakMock).not.toHaveBeenCalled();
    unmount();
  });
});
