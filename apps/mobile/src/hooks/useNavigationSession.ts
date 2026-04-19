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
import { useEffect, useRef, useState } from "react";
import ReactNativeHapticFeedback from "react-native-haptic-feedback";
import { locationService, type LocationUpdate } from "@/services/location";
import {
  NavSession,
  buildCumulativeDistances,
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
}

const HAPTIC_CONFIG = {
  enableVibrateFallback: true,
  ignoreAndroidSystemSettings: false,
};

export function useNavigationSession(
  options: UseNavigationSessionOptions,
): NavigationState {
  const { polyline, roadNames, voiceEnabled, trackLocation = true } = options;

  // Keep the `NavSession` in a ref rather than `useMemo`. useMemo is a
  // performance hint — React is allowed to drop the cached value (e.g. for
  // offscreen renders), which would hand us a fresh session mid-ride and
  // re-announce every maneuver the rider has already passed. A ref is
  // guaranteed stable across renders; we rebuild only when the input
  // polyline or road-name array identity changes, and we dedupe the
  // cumulative-distance haversines across `extractManeuvers` and the
  // `NavSession` constructor while we're building both.
  const sessionRef = useRef<{
    polyline: LatLng[];
    roadNames: Array<string | undefined> | undefined;
    session: NavSession;
    maneuvers: Maneuver[];
  } | null>(null);

  if (
    sessionRef.current === null ||
    sessionRef.current.polyline !== polyline ||
    sessionRef.current.roadNames !== roadNames
  ) {
    const cumulative = buildCumulativeDistances(polyline);
    const maneuvers = extractManeuvers(polyline, roadNames, cumulative);
    const session = new NavSession(polyline, maneuvers, cumulative);
    sessionRef.current = { polyline, roadNames, session, maneuvers };
  }
  const { session, maneuvers } = sessionRef.current;

  const [tick, setTick] = useState<NavTick | null>(null);
  const [liveLocation, setLiveLocation] = useState<LatLng | null>(null);
  // Sync voice state during render, not in an effect. Location callbacks
  // can fire between commit and effect flush, so an effect-based update
  // would leave the ref reading a stale value on the first few ticks
  // after a toggle. The mute side-effect on TTS itself still lives in
  // useEffect so it runs once per change, not on every render.
  const voiceRef = useRef(voiceEnabled);
  voiceRef.current = voiceEnabled;
  useEffect(() => {
    ttsService.setMuted(!voiceEnabled);
  }, [voiceEnabled]);

  useEffect(() => {
    if (!trackLocation) return undefined;

    const handle = (loc: LocationUpdate) => {
      const here: LatLng = { lat: loc.lat, lng: loc.lng };
      setLiveLocation(here);
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

  return { tick, maneuvers, liveLocation };
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
