/**
 * useRouteWeatherAlerts — US-13 navigation-side weather feed.
 *
 * Calls `POST /weather/route` with the active polyline on mount and at a
 * fixed interval, keeps a deduped list of alerts the rider hasn't passed
 * yet, and (when voice is on) reads each `critical` alert aloud once via
 * the shared TTS service. Failures are swallowed — riders should never
 * see a blocking error from this surface, the next poll just retries.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "@/services/api";
import { ttsService } from "@/services/tts";
import type { LatLng, WeatherAlert } from "@/types";

/** Default poll cadence — every 5 minutes per US-13 acceptance criteria. */
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Stable reference for the "no alerts" state. Reusing this lets React's
 * `Object.is` bailout skip a redundant re-render every time the hook
 * resets its alert list (route change, disabled flip, transport reset).
 */
const NO_ALERTS: WeatherAlert[] = [];

/**
 * Floor between two TTS announcements from this hook. The TTS service
 * already serialises queued phrases, but a freshly arrived critical
 * alert immediately after a previous one would otherwise stack two
 * "Storm warning ahead!" reads back-to-back. The throttle keeps the
 * rider from hearing the same urgency twice in quick succession.
 */
const TTS_THROTTLE_MS = 60 * 1000;

export interface UseRouteWeatherAlertsOptions {
  /** Active route to query — empty/short polyline disables the hook. */
  polyline: LatLng[];
  /**
   * Rider's progress along the polyline in metres (`tick.progressM`).
   * `null` before the first GPS fix lands; in that case we keep every
   * alert visible since we can't know what's behind us yet.
   */
  progressM: number | null;
  /** Master kill-switch — when false, the hook clears state and polls nothing. */
  enabled: boolean;
  /**
   * Whether voice prompts are live. Mirrors NavigationScreen's voice FAB
   * so a muted rider doesn't get a TTS read-out while the toggle is off.
   */
  voiceEnabled: boolean;
  /** Override the poll cadence — test seam. */
  intervalMs?: number;
}

export interface UseRouteWeatherAlertsResult {
  /** Active alerts ahead of the rider, deduped across polls. */
  alerts: WeatherAlert[];
}

export function useRouteWeatherAlerts(
  options: UseRouteWeatherAlertsOptions,
): UseRouteWeatherAlertsResult {
  const {
    polyline,
    progressM,
    enabled,
    voiceEnabled,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = options;

  const [allAlerts, setAllAlerts] = useState<WeatherAlert[]>(NO_ALERTS);

  // IDs we've already read aloud — TTS fires once per occurrence even
  // across re-polls. Reset whenever the route changes (the IDs are
  // sample-index based, so a new polyline produces a fresh space).
  const spokenIdsRef = useRef<Set<string>>(new Set());
  const lastSpokenAtRef = useRef<number>(0);

  // The latest voice flag the polling effect should consult. Keeping it
  // in a ref means we don't tear down the interval just to flip a TTS
  // gate that the next poll naturally picks up.
  const voiceEnabledRef = useRef(voiceEnabled);
  voiceEnabledRef.current = voiceEnabled;

  // Reset memory when the polyline identity changes — a fresh route
  // means the rider's "passed" frame of reference also resets.
  useEffect(() => {
    spokenIdsRef.current = new Set();
    lastSpokenAtRef.current = 0;
    setAllAlerts(NO_ALERTS);
  }, [polyline]);

  useEffect(() => {
    if (!enabled || polyline.length < 2) {
      setAllAlerts(NO_ALERTS);
      return undefined;
    }

    let cancelled = false;

    const poll = async (): Promise<void> => {
      try {
        const response = await api.getRouteWeather(polyline);
        if (cancelled) return;

        const next = response.typed_alerts ?? [];
        setAllAlerts(next);

        // TTS announce: only critical alerts the rider hasn't heard yet,
        // and only when voice is enabled. Throttle prevents two criticals
        // landing in the same poll from reading back-to-back.
        if (!voiceEnabledRef.current) return;
        for (const alert of next) {
          if (alert.severity !== "critical") continue;
          if (spokenIdsRef.current.has(alert.id)) continue;
          const now = Date.now();
          if (now - lastSpokenAtRef.current < TTS_THROTTLE_MS) continue;
          ttsService.speak(`${alert.title}. ${alert.message}`);
          spokenIdsRef.current.add(alert.id);
          lastSpokenAtRef.current = now;
        }
      } catch {
        // Offline / transient backend failure — leave the existing
        // banner state alone and let the next interval retry. Riders
        // should never see a weather-API error pop up mid-ride.
      }
    };

    void poll();
    const handle = setInterval(() => {
      void poll();
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [enabled, polyline, intervalMs]);

  // Drop alerts the rider has already passed. We compare in metres
  // because `progressM` is metres while alerts speak in km.
  const alerts =
    progressM === null
      ? allAlerts
      : allAlerts.filter((a) => a.distance_km_from_start * 1000 > progressM);

  return { alerts };
}
