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
 *     FAB preference honoured, locale + unit + verbose mode applied per
 *     the rider's Settings, and stale "in 300 m" prompts collapsed
 *     against fresher "in 50 m" prompts via dedupe keys.
 *
 *   - Suppress local TTS while CarPlay / Android Auto is presenting
 *     prompts so the rider doesn't hear every cue twice (#498). The
 *     suppression is re-evaluated on every connect / disconnect event
 *     from the head-unit bridge.
 *
 *   - Fire haptic feedback at `warning-near` and `execute` so the rider
 *     gets a tactile cue even with the helmet audio muted.
 */
import { useEffect, useRef, useState } from "react";
import ReactNativeHapticFeedback from "react-native-haptic-feedback";
import { detectDeviceLocale } from "@/i18n/deviceLocale";
import { locationService, type LocationUpdate } from "@/services/location";
import {
  NavSession,
  TTS_BCP47_BY_LOCALE,
  announcementKey,
  buildCumulativeDistances,
  extractManeuvers,
  phraseForAnnouncement,
  resolveVoiceLocale,
  type DistanceUnit,
  type Maneuver,
  type NavAnnouncement,
  type NavTick,
  type VoiceLocale,
} from "@/services/navigation";
import { ttsService } from "@/services/tts";
import type { LatLng } from "@/types";

export interface UseNavigationSessionOptions {
  polyline: LatLng[];
  roadNames?: Array<string | undefined>;
  voiceEnabled: boolean;
  /** When false, skip calls to locationService — used in storybook/tests. */
  trackLocation?: boolean;
  /**
   * Voice preferences forwarded to the TTS service + phrase builder.
   * `language` of `"auto"` resolves at mount time from the device
   * locale; the resolved locale is also pushed to `ttsService.setLanguage()`
   * so the engine picks a matching voice pack.
   */
  language?: "auto" | VoiceLocale;
  unit?: DistanceUnit;
  verbose?: boolean;
  volume?: number;
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
  const {
    polyline,
    roadNames,
    voiceEnabled,
    trackLocation = true,
    language = "auto",
    unit = "metric",
    verbose = true,
    volume = 1,
  } = options;

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

  // Resolve the spoken locale once per render — the auto branch reads
  // device settings, every fixed branch is a constant cast. Used both
  // for the phrase builder and for pushing the BCP-47 tag to the TTS
  // engine so the voice pack matches.
  const resolvedLocale: VoiceLocale =
    language === "auto"
      ? resolveVoiceLocale(detectDeviceLocale() ?? undefined)
      : language;

  // Sync voice state during render, not in an effect. Location callbacks
  // can fire between commit and effect flush, so an effect-based update
  // would leave the ref reading a stale value on the first few ticks
  // after a toggle AND — worse — leave the TTS singleton's mute flag
  // out of sync with the ref: on off→on, handleAnnouncement would read
  // `voiceEnabled=true` from the ref and call `ttsService.speak()` while
  // `ttsService.muted` was still `true`, silently dropping the phrase.
  // `NavSession` has already marked the threshold as fired, so that
  // announcement would never replay. Flipping both values during render
  // keeps them in lockstep. The `prevVoiceEnabledRef` guard means the
  // singleton isn't reset on every re-render — only on actual
  // transitions, which also means `setMuted(true)`'s stop() side effect
  // doesn't thrash during unrelated renders.
  const voiceRef = useRef(voiceEnabled);
  voiceRef.current = voiceEnabled;
  const localeRef = useRef<VoiceLocale>(resolvedLocale);
  localeRef.current = resolvedLocale;
  const unitRef = useRef<DistanceUnit>(unit);
  unitRef.current = unit;
  const verboseRef = useRef(verbose);
  verboseRef.current = verbose;
  const prevVoiceEnabledRef = useRef<boolean | null>(null);
  if (prevVoiceEnabledRef.current !== voiceEnabled) {
    prevVoiceEnabledRef.current = voiceEnabled;
    ttsService.setMuted(!voiceEnabled);
  }

  // Push language + volume to the engine on every render where the
  // resolved value changed. Setting language is a Promise-returning
  // call but we don't await it — the next phrase will pick up the new
  // voice once the engine has processed the request.
  const prevLocaleRef = useRef<VoiceLocale | null>(null);
  if (prevLocaleRef.current !== resolvedLocale) {
    prevLocaleRef.current = resolvedLocale;
    ttsService.setLanguage(TTS_BCP47_BY_LOCALE[resolvedLocale]);
  }
  const prevVolumeRef = useRef<number | null>(null);
  if (prevVolumeRef.current !== volume) {
    prevVolumeRef.current = volume;
    ttsService.setVolume(volume);
  }

  // Reset the singleton's mute flag when the session tears down so a rider
  // who muted mid-nav doesn't leak silence to every future TTS consumer
  // (commute alerts, future crash detection, etc.). The voice-enabled
  // effect above only cleans itself on flag transitions, so we need this
  // mount-only cleanup for the unmount case.
  useEffect(() => {
    return () => {
      ttsService.setMuted(false);
      // Belt-and-suspenders: clear any paused state set by an explicit
      // ride-pause flow (none ships today, but `ttsService.pause()` is
      // exposed for that future consumer) so the next mount of any TTS
      // surface starts in the resumed state.
      ttsService.resume();
    };
  }, []);

  // We deliberately do NOT pause TTS on AppState transitions. The app
  // declares background-audio + background-location modes (iOS) and
  // foreground-service location (Android), so a rider who locks the
  // phone or app-switches while a route is running is a SUPPORTED
  // riding context — they're still navigating, just not looking at
  // the screen. Pausing the helmet feed on `background` would silence
  // every turn cue and crash/weather alert until the rider unlocked,
  // which is the exact opposite of the safety guarantee voice nav
  // provides. The native audio session keeps the engine warm across
  // these transitions on its own.
  //
  // The `pause()` / `resume()` API on `ttsService` stays exposed for
  // an explicit ride-pause flow if/when one ships; we just don't wire
  // it to AppState.

  // CarPlay / Android Auto handoff: we deliberately do NOT auto-suppress
  // local TTS just because the head unit is connected. The current
  // CarPlay surface (`useCarPlayRideMirror`) renders only the ride
  // status board — it does NOT speak navigation prompts. Suppressing
  // here on mere connection would silence every turn cue on bikes
  // running Tarmoto + CarPlay status board, with nothing to replace it.
  //
  // The suppression hook lives in `ttsService.setExternalAudioActive()`
  // so the eventual CarPlay nav-prompt forwarding (#498) can call it
  // when it actually owns the audio path. High-priority phrases (crash
  // / critical weather) bypass the suppression unconditionally — those
  // never travel through the head unit.

  useEffect(() => {
    if (!trackLocation) return undefined;

    const handle = (loc: LocationUpdate) => {
      const here: LatLng = { lat: loc.lat, lng: loc.lng };
      setLiveLocation(here);
      const next = session.update(here);
      setTick(next);

      for (const ann of next.announcements) {
        handleAnnouncement(ann, voiceRef.current, {
          locale: localeRef.current,
          unit: unitRef.current,
          verbose: verboseRef.current,
        });
      }
    };

    // Subscribe as an INDEPENDENT consumer (not the ride recorder's `start`),
    // so navigation opening/closing — including a `basic_navigation` kill
    // flipping `trackLocation` off — never tears down a concurrently-recording
    // ride's GPS feed or resets its trip odometer.
    const unsubscribe = locationService.subscribe(handle);
    return () => {
      unsubscribe();
      // Stop only navigation prompts — a `basic_navigation` kill (or a screen
      // unmount) mid-utterance must NOT cancel an in-flight high-priority
      // safety alert (crash countdown / critical weather), which won't replay
      // because its phase hasn't changed.
      ttsService.stopNavigation();
    };
  }, [session, trackLocation]);

  return { tick, maneuvers, liveLocation };
}

function handleAnnouncement(
  ann: NavAnnouncement,
  voiceEnabled: boolean,
  phraseOptions: { locale: VoiceLocale; unit: DistanceUnit; verbose: boolean },
): void {
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
  const phrase = phraseForAnnouncement(ann, phraseOptions);
  if (phrase) {
    const key = announcementKey(ann);
    ttsService.speak(phrase, key !== undefined ? { key } : {});
  }
}
