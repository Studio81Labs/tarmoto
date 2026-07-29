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
import { t as translate } from "@/i18n";
import { localizeWeatherAlert } from "@/services/weatherAlertCopy";
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
  /**
   * Master kill-switch — when false, the hook clears state and polls
   * nothing. Mirrors the rider's `weatherAlertsEnabled` preference; the
   * NavigationScreen voice FAB is intentionally NOT consulted here
   * because critical alerts are safety notices and ride on the
   * high-priority TTS lane that bypasses the FAB mute.
   */
  enabled: boolean;
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
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = options;

  const [allAlerts, setAllAlerts] = useState<WeatherAlert[]>(NO_ALERTS);

  // IDs we've already read aloud — TTS fires once per occurrence even
  // across re-polls. Reset whenever the route changes (the IDs are
  // sample-index based, so a new polyline produces a fresh space).
  const spokenIdsRef = useRef<Set<string>>(new Set());
  const lastSpokenAtRef = useRef<number>(0);

  // Mirror progress in a ref so the polling effect — which closes over
  // its initial `progressM` — can still apply the ahead-only filter to
  // TTS announcements. Without this, a critical alert at a point the
  // rider has already passed (e.g. weather changes back at km 5 while
  // the rider is at km 10) would be read aloud even though the banner
  // correctly hides it via the render-time `progressM` check below.
  const progressMRef = useRef(progressM);
  progressMRef.current = progressM;

  // Reset memory when the polyline identity changes — a fresh route
  // means the rider's "passed" frame of reference also resets.
  useEffect(() => {
    spokenIdsRef.current = new Set();
    lastSpokenAtRef.current = 0;
    setAllAlerts(NO_ALERTS);
  }, [polyline]);

  // When the feed is disabled (operator `weather_alerts` kill or the rider
  // preference), the main effect below stops polling and clears the banner —
  // but a weather phrase may have ALREADY entered the TTS pipeline. Weather
  // rides the high-priority lane, so navigation teardown deliberately preserves
  // it; cancel it explicitly here by key prefix so bad provider data isn't
  // announced after the kill, while a crash-countdown on the same lane keeps
  // playing.
  useEffect(() => {
    if (!enabled) ttsService.cancelByKeyPrefix("weather:");
  }, [enabled]);

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

        // TTS announce critical alerts the rider hasn't heard yet that
        // are still ahead of their current progress. Throttle prevents
        // two criticals in the same poll from reading back-to-back.
        //
        // We deliberately do NOT gate critical alerts on the
        // NavigationScreen voice FAB (`voiceEnabledRef`). The FAB
        // mutes turn-by-turn guidance, not safety alerts — a rider
        // who silenced nav prompts still needs to hear about a storm
        // ahead. The `enabled` flag (which mirrors the
        // weather-alerts-enabled preference) is the right place to
        // opt out of weather TTS entirely. Gating ALL alerts on the
        // voice FAB is fine; we just route critical ones through the
        // high-priority `ttsService.speak()` lane that bypasses the
        // FAB mute, the volume slider, and the external-audio guard.
        const progressMNow = progressMRef.current;
        for (const alert of next) {
          if (alert.severity !== "critical") continue;
          if (spokenIdsRef.current.has(alert.id)) continue;
          if (
            progressMNow !== null &&
            alert.distance_km_from_start * 1000 <= progressMNow
          ) {
            // Already behind the rider — banner hides it, voice must too.
            continue;
          }
          const now = Date.now();
          if (now - lastSpokenAtRef.current < TTS_THROTTLE_MS) continue;
          // Critical weather alerts preempt nav prompts so a rider
          // doesn't get "in 300 meters, turn left" played over a storm
          // warning. The dedupe key keeps a re-fired identical alert
          // from stacking inside the high-priority queue. The
          // `priority: "high"` tag also bypasses the voice-FAB mute,
          // the volume<=0 mute, and the external-audio guard inside
          // `ttsService` so the alert always reaches the rider.
          const copy = localizeWeatherAlert(alert);
          ttsService.speak(
            translate("{title}. {message}", {
              title: copy.title,
              // eslint-disable-next-line no-restricted-syntax -- localizeWeatherAlert returns cataloged copy.
              message: copy.message,
            }),
            {
              priority: "high",
              key: `weather:${alert.id}`,
            },
          );
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
