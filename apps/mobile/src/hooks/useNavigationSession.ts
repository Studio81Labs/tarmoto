/**
 * useNavigationSession — React hook that wires live GPS into `NavSession`
 * and surfaces the latest state to NavigationScreen (US-16).
 *
 * Responsibilities:
 *
 *   - Subscribe to `locationService` updates for the duration of the
 *     screen's mount, and feed each fix to the `NavSession` instance.
 *
 *   - Keep the session identity stable across re-renders (a new session
 *     would reset `farFired` / `nearFired` and re-announce the same
 *     maneuver repeatedly).
 *
 *   - Forward emitted announcements to the TTS service, with the voice
 *     FAB preference honoured.
 *
 *   - Fire haptic feedback at `warning-near` and `execute` so the rider
 *     gets a tactile cue even with the helmet audio muted.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import ReactNativeHapticFeedback from "react-native-haptic-feedback";
import { locationService, type LocationUpdate } from "@/services/location";
import {
  NavSession,
  extractManeuvers,
  phraseForAnnouncement,
  type Maneuver,
  type NavAnnouncement,
  type NavTick,
} from "@/services/navigation";
import { ttsService } from "@/services/tts";
import type { LatLng } from "@/types";

export interface UseNavigationSessionOptions {
  polyline: LatLng[];
  roadNames?: Array<string | undefined>;
  voiceEnabled: boolean;
  /** When false, skip calls to locationService — used in storybook/tests. */
  trackLocation?: boolean;
}

export interface NavigationState {
  tick: NavTick | null;
  maneuvers: Maneuver[];
  liveLocation: LatLng | null;
  liveSpeedKmh: number;
  totalDistanceM: number;
}

const HAPTIC_CONFIG = {
  enableVibrateFallback: true,
  ignoreAndroidSystemSettings: false,
};

export function useNavigationSession(
  options: UseNavigationSessionOptions,
): NavigationState {
  const { polyline, roadNames, voiceEnabled, trackLocation = true } = options;

  const maneuvers = useMemo(
    () => extractManeuvers(polyline, roadNames),
    [polyline, roadNames],
  );

  // Recreate the session when the polyline identity changes — different
  // routes need different distance offsets. useMemo (not useState) is
  // intentional: a route change mid-session is a programmatic event, not
  // a user action that should preserve announcement state.
  const session = useMemo(
    () => new NavSession(polyline, maneuvers),
    [polyline, maneuvers],
  );

  const [tick, setTick] = useState<NavTick | null>(null);
  const [liveLocation, setLiveLocation] = useState<LatLng | null>(null);
  const [liveSpeedKmh, setLiveSpeedKmh] = useState(0);
  // Ref mirrors — read inside the location callback so it picks up the
  // latest `voiceEnabled` flag without the subscription having to teardown
  // and re-attach on every toggle.
  const voiceRef = useRef(voiceEnabled);
  useEffect(() => {
    voiceRef.current = voiceEnabled;
    ttsService.setMuted(!voiceEnabled);
  }, [voiceEnabled]);

  useEffect(() => {
    if (!trackLocation) return undefined;

    const handle = (loc: LocationUpdate) => {
      const here: LatLng = { lat: loc.lat, lng: loc.lng };
      setLiveLocation(here);
      setLiveSpeedKmh(loc.speed);
      const next = session.update(here);
      setTick(next);

      for (const ann of next.announcements) {
        handleAnnouncement(ann, voiceRef.current);
      }
    };

    locationService.start(handle);
    return () => {
      locationService.stop();
      ttsService.stop();
    };
  }, [session, trackLocation]);

  const totalDistanceM = useMemo(() => {
    if (maneuvers.length === 0) return 0;
    return maneuvers[maneuvers.length - 1].distanceFromStartM;
  }, [maneuvers]);

  return { tick, maneuvers, liveLocation, liveSpeedKmh, totalDistanceM };
}

function handleAnnouncement(ann: NavAnnouncement, voiceEnabled: boolean): void {
  // Haptics land regardless of the voice toggle — the rider can suppress
  // voice without silencing the physical cue. "Near" is a double-tap so
  // it feels more urgent than the far warning (which we don't haptic at
  // all; three waypoints into a chain we don't want wrist-buzz fatigue).
  if (ann.type === "warning-near" || ann.type === "execute") {
    ReactNativeHapticFeedback.trigger("notificationWarning", HAPTIC_CONFIG);
  } else if (ann.type === "off-route") {
    ReactNativeHapticFeedback.trigger("notificationError", HAPTIC_CONFIG);
  } else if (ann.type === "arrived") {
    ReactNativeHapticFeedback.trigger("notificationSuccess", HAPTIC_CONFIG);
  }

  if (!voiceEnabled) return;
  const phrase = phraseForAnnouncement(ann);
  if (phrase) ttsService.speak(phrase);
}
