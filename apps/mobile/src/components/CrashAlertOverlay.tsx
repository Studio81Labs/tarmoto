/**
 * CrashAlertOverlay — US-12 AC #2/#3.
 *
 * Full-screen modal that takes over the UI when the crash detector
 * fires. Shows a 30-second countdown, a large "I'm OK — cancel" button,
 * and dispatches the crash alert when the timer hits zero.
 *
 * Cancelling within the countdown is silent — `useCrashStore.cancel()`
 * resets the store and no contacts are notified. Dispatch failures stay
 * on screen with a retry affordance so a transient network issue doesn't
 * leave the rider thinking help is on the way when the request never
 * left the device.
 *
 * Sound + haptics: `react-native-haptic-feedback` fires a continuous
 * pulse pattern while the overlay is up. TTS speaks the alert via the
 * existing `ttsService` so a rider whose phone is in the tank bag still
 * gets an audible warning to cancel. Both modules are loaded
 * defensively (lazy require, fall back to no-op) so jest and platforms
 * without the native binding still mount cleanly.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  AppState,
  type AppStateStatus,
} from "react-native";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  QUALITY_COLORS,
} from "@/theme/brand";
import { useCrashStore } from "@/stores";
import { api } from "@/services/api";
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import { CRASH_DEFAULTS } from "@/services/crashDetector";
import { ttsService } from "@/services/tts";
import { useTranslation } from "@/i18n/I18nProvider";
import { useFormat } from "@/format/FormatProvider";

const t = brandColorsLight;
/**
 * Full-bleed crash background — the Q1 ("avoid") ramp red. The spec calls
 * for a Q1-red countdown; ink text clears ~6.6:1 on it (white would only
 * reach ~3.3:1), so headlines/countdown/subhead render ink and the primary
 * "I'm OK" button is a cream raised surface with an ink label.
 */
const CRASH_BG = QUALITY_COLORS[0];

const COUNTDOWN_TICK_MS = 250;
/** Pulse cadence while the overlay is up — matches alarm-clock timing. */
const HAPTIC_PULSE_MS = 1_000;
/**
 * When the backend reports `dispatch_in_progress` on an idempotent
 * replay (the original POST is still working server-side), we poll
 * after this many ms to read the eventual outcome.
 */
const IN_FLIGHT_POLL_MS = 3_000;
/**
 * Cap how many times we'll re-poll an in-flight replay before
 * surfacing a "still dispatching" failure with a manual retry button.
 * Sized so the auto-poll budget plus a couple of manual retries fits
 * inside the backend's 5/min per-(ip,user) throttle: 1 initial send +
 * 2 polls = 3 calls in ~6 s, leaving 2 manual RETRY attempts in the
 * minute.
 */
const MAX_IN_FLIGHT_POLLS = 2;

interface HapticTrigger {
  trigger: () => void;
}

function loadHaptics(): HapticTrigger {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("react-native-haptic-feedback") as {
      default?: { trigger?: (type: string) => void };
      trigger?: (type: string) => void;
    };
    const trigger = mod.default?.trigger ?? mod.trigger;
    if (typeof trigger !== "function") return { trigger: () => {} };
    return { trigger: () => trigger("notificationError") };
  } catch {
    return { trigger: () => {} };
  }
}

const haptics = loadHaptics();

export interface CrashAlertOverlayProps {
  /** Override for tests — defaults to the configured countdown. */
  countdownMs?: number;
}

export default function CrashAlertOverlay({
  countdownMs = CRASH_DEFAULTS.countdownMs,
}: CrashAlertOverlayProps): React.ReactElement | null {
  const format = useFormat();
  const translate = useTranslation();
  // The alarm lifecycle belongs to the crash phase. Presentation preferences
  // may change while the countdown is active, but must not restart the
  // high-priority warning or its haptic cadence. Async/error paths still need
  // the current translator, so keep it live independently of that lifecycle.
  const translateRef = useRef(translate);
  useEffect(() => {
    translateRef.current = translate;
  }, [translate]);
  const phase = useCrashStore((s) => s.phase);
  // `dispatch` reads the alert via `useCrashStore.getState()` at call
  // time so the manual-RETRY rotation lands before we POST. The hook
  // selector isn't needed here because no JSX branch reads alert
  // fields directly.
  const errorMessage = useCrashStore((s) => s.errorMessage);
  const cancel = useCrashStore((s) => s.cancel);
  const beginDispatch = useCrashStore((s) => s.beginDispatch);
  const markDispatched = useCrashStore((s) => s.markDispatched);
  const markFailed = useCrashStore((s) => s.markFailed);
  const rotateIncidentId = useCrashStore((s) => s.rotateIncidentId);
  const resetAlert = useCrashStore((s) => s.reset);

  // Reactive `crash_detection` kill switch. If an operator force-disables it
  // DURING an armed countdown (a false-alert incident), tear the overlay down
  // immediately — dismiss the alert and cancel the `crash:*` speech lane —
  // rather than letting it keep occupying the screen, pulsing haptics, and
  // speaking for the rest of the ~30s window until the dispatch-time gate
  // below fires. That dispatch-time gate stays as belt-and-braces.
  const crashDetectionActive = useFeatureKillSwitchActive("crash_detection");
  useEffect(() => {
    if (!crashDetectionActive && phase !== "idle") {
      resetAlert();
      ttsService.cancelByKeyPrefix("crash:");
    }
  }, [crashDetectionActive, phase, resetAlert]);

  const [remainingMs, setRemainingMs] = useState(countdownMs);
  /**
   * Set while a `sendCrashAlert` request is in flight. Used as the
   * single source of truth for "another dispatch is already running" so
   * a double-tap on RETRY (or a re-fire of the auto-dispatch effect)
   * can't queue a second `POST /safety/crash-alert` for the same
   * incident — that would double-notify emergency contacts. (Bugbot
   * ac36c38f.) The ref is only cleared in the request's `finally`, so
   * the next legitimate retry tap proceeds the moment the current
   * attempt has completed (resolve or reject).
   */
  const inFlightRef = useRef(false);
  // Pending in-flight-replay poll, scheduled when the backend replies
  // `dispatch_in_progress: true`. Cleared on every fresh dispatch entry
  // and on unmount so a stale timer can't fire after the rider already
  // dismissed the overlay or kicked off a manual retry.
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Lifted out of the countdown effect so the AppState handler can also
  // recompute the remaining time when the rider returns from background
  // — see the foreground hook below.
  const startedAtRef = useRef<number | null>(null);

  const visible = phase !== "idle";

  // ── Countdown ticker ──
  useEffect(() => {
    if (phase !== "countdown") {
      setRemainingMs(countdownMs);
      startedAtRef.current = null;
      return;
    }
    setRemainingMs(countdownMs);
    startedAtRef.current = Date.now();
    const id = setInterval(() => {
      if (startedAtRef.current === null) return;
      const elapsed = Date.now() - startedAtRef.current;
      const next = Math.max(0, countdownMs - elapsed);
      setRemainingMs(next);
    }, COUNTDOWN_TICK_MS);
    return () => clearInterval(id);
  }, [phase, countdownMs]);

  // ── Audible + haptic alarm ──
  useEffect(() => {
    if (phase !== "countdown") return;
    haptics.trigger();
    ttsService.speak(
      translateRef.current(
        "Crash detected. Tap I'm OK to cancel, or help will be alerted.",
      ),
      // Crash followup must preempt any in-flight nav prompt — a rider
      // mid-turn can't afford to hear "in 300 meters, turn left" over
      // the top of their crash countdown.
      { priority: "high", key: "crash:countdown" },
    );
    const pulse = setInterval(() => haptics.trigger(), HAPTIC_PULSE_MS);
    return () => clearInterval(pulse);
  }, [phase]);

  // ── Auto-dispatch on countdown elapsed ──
  const dispatch = useCallback(
    async (pollAttempt = 0) => {
      // `inFlightRef` is the single guard against concurrent dispatches.
      // Both the auto-dispatch effect (fires whenever phase=countdown and
      // remaining<=0) and the manual RETRY button funnel through this
      // function; the ref ensures only one POST is in flight at a time.
      // Critically, the ref is NOT reset by callers — only the `finally`
      // below clears it, so a double-tap on RETRY can't race past the
      // guard.
      if (inFlightRef.current) return;
      // Operator kill switch (`crash_detection`) — belt-and-braces safety net.
      // The detector won't arm a new countdown while it's force-disabled, but
      // if an operator kills it (e.g. false-SOS storm) AFTER a countdown was
      // already armed, never POST the SOS. Dismiss the overlay to idle so the
      // rider isn't stranded on a countdown that will never dispatch.
      if (!isFeatureKillSwitchActive("crash_detection")) {
        resetAlert();
        return;
      }
      // Read the alert directly from the store rather than the
      // closure variable. The RETRY button rotates the alertId via
      // `rotateIncidentId()` and immediately calls `dispatch()` —
      // because React state updates are batched, the closure-captured
      // `alert` would still hold the pre-rotation id at that point.
      // Pulling from the store at call time guarantees we send the
      // freshly-rotated id.
      const alert = useCrashStore.getState().alert;
      if (!alert) {
        // Defensive: no snapshot means we have nothing to send. Surface as
        // a failure so the rider knows the alert didn't go out. Treat as
        // transient — a fresh incident would generate a new snapshot.
        markFailed(
          translate("No location captured for the alert."),
          "transient",
        );
        return;
      }
      // GPS may have had no fix when the spike landed (tunnel, indoor
      // start, dead module). Don't fall back to `(0, 0)` — that's Null
      // Island in the Atlantic and would dispatch a meaningless location
      // to emergency contacts during a real crash. Better to fail loudly
      // so the rider can fall back to a manual call. (Bugbot 5069fc01.)
      if (alert.lat === null || alert.lng === null) {
        markFailed(
          translate("No GPS fix at the moment of impact."),
          "transient",
        );
        return;
      }
      // A new dispatch supersedes any pending in-flight-replay poll —
      // the rider hit RETRY (or the auto-dispatch refired), so we don't
      // want the old timer to also fire and double-call.
      if (pollTimeoutRef.current !== null) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
      inFlightRef.current = true;
      // Flip into the dispatching phase BEFORE the network call so the
      // cancel button is hidden for the rest of the request lifecycle.
      // Without this gate the rider could tap "I'm OK" while the POST is
      // already in flight — the backend may already have queued the alert
      // and notified contacts, so flipping the local store to idle would
      // contradict reality and trigger a "HELP IS ON THE WAY" screen on
      // the resolve. (Bugbot 1032971c.)
      beginDispatch();
      try {
        // `alert.alertId` is a stable UUID generated once in
        // `startCountdown`. Threading it on every attempt gives the
        // backend a fixed idempotency key so a network retry replays
        // the original outcome instead of re-notifying contacts.
        const result = await api.sendCrashAlert(alert.lat, alert.lng, {
          ...(alert.rideId != null ? { rideId: alert.rideId } : {}),
          ...(alert.speedAtImpact != null
            ? { speedAtImpact: alert.speedAtImpact }
            : {}),
          alertId: alert.alertId,
        });
        // Idempotent replay where the original POST is still running
        // server-side. We don't know the eventual `contacts_notified`
        // yet — keep the rider on the dispatching phase and re-poll
        // shortly to read the real outcome instead of misclassifying
        // this as a failure. Bounded to MAX_IN_FLIGHT_POLLS so a stuck
        // backend doesn't loop forever.
        if (result.dispatch_in_progress) {
          if (pollAttempt < MAX_IN_FLIGHT_POLLS) {
            pollTimeoutRef.current = setTimeout(() => {
              pollTimeoutRef.current = null;
              void dispatch(pollAttempt + 1);
            }, IN_FLIGHT_POLL_MS);
          } else {
            // Transient: the original is still working server-side, so
            // a manual RETRY should keep the same alertId to replay
            // the eventual outcome (instead of dispatching twice).
            markFailed(
              translate(
                "Original alert is still being sent. Please wait a moment, then tap RETRY.",
              ),
              "transient",
            );
          }
          return;
        }
        // Backend returns 200 even when nothing actually went out (every
        // contact failed, notifier unconfigured, no contacts on file).
        // Surface that as a failure so the rider doesn't see "HELP IS ON
        // THE WAY" while the alert silently fizzled. This is a `completed`
        // failure — the row is closed server-side under this alertId, so
        // RETRY needs a fresh id to genuinely re-dispatch.
        if (result.contacts_notified === 0) {
          markFailed(
            result.contacts.length === 0
              ? translate("No emergency contacts on file.")
              : translate("Couldn't reach any of your emergency contacts."),
            "completed",
          );
        } else {
          markDispatched();
        }
      } catch {
        // Network / timeout / 5xx — request never reached completion
        // server-side, so the original `alertId` was never (or only
        // partially) recorded. Treat as transient so RETRY keeps the
        // same id; if the backend ends up with the row anyway, the
        // retry will replay it instead of double-notifying.
        markFailed(translate("Couldn't reach the server."), "transient");
      } finally {
        inFlightRef.current = false;
      }
    },
    [beginDispatch, markDispatched, markFailed, resetAlert, translate],
  );

  useEffect(() => {
    if (phase === "countdown" && remainingMs <= 0) {
      void dispatch();
    }
  }, [phase, remainingMs, dispatch]);

  // ── Foreground re-trigger ──
  // While the app is backgrounded, RN may pause the JS thread on iOS, so
  // the countdown setInterval doesn't tick and the displayed seconds
  // freeze at the last value rendered before backgrounding. On return
  // we recompute remainingMs directly from `startedAtRef` rather than
  // using `setRemainingMs(prev => prev)` — the previous form was a
  // bail-out and produced no re-render, so the UI stayed stale until
  // the next interval fire. (Bugbot c2c8337d.)
  useEffect(() => {
    if (phase !== "countdown") return;
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next !== "active") return;
      if (startedAtRef.current === null) return;
      const elapsed = Date.now() - startedAtRef.current;
      setRemainingMs(Math.max(0, countdownMs - elapsed));
    });
    return () => sub.remove();
  }, [phase, countdownMs]);

  // Cancel any pending in-flight-replay poll on unmount or when the
  // phase moves out of dispatching/failed terminals — without this a
  // stale timer could fire after the rider dismissed the overlay and
  // resurrect a closed alert.
  useEffect(() => {
    if (phase !== "dispatching") {
      if (pollTimeoutRef.current !== null) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    }
    return () => {
      if (pollTimeoutRef.current !== null) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    };
  }, [phase]);

  if (!visible) return null;

  const seconds = Math.ceil(remainingMs / 1000);

  return (
    <Modal
      visible
      animationType="fade"
      transparent={false}
      statusBarTranslucent
    >
      <View style={styles.container}>
        {phase === "countdown" ? (
          <>
            <Text style={styles.headline}>{translate("CRASH DETECTED")}</Text>
            <Text style={styles.subhead}>
              {translate("We'll alert your emergency contacts in")}
            </Text>
            <Text style={styles.countdown} accessibilityLiveRegion="assertive">
              {format.integer(seconds)}
            </Text>
            <Text style={styles.subhead}>
              {translate("{seconds, plural, one {second} other {seconds}}", {
                seconds,
              })}
            </Text>
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={cancel}
              accessibilityRole="button"
              accessibilityLabel={translate("I'm OK, cancel crash alert")}
            >
              <Text style={styles.cancelLabel}>
                {translate("I'M OK — CANCEL")}
              </Text>
            </TouchableOpacity>
          </>
        ) : null}

        {phase === "dispatching" ? (
          <>
            <Text style={styles.headline}>
              {translate("ALERTING CONTACTS…")}
            </Text>
            <Text style={styles.subhead}>
              {translate("Sending your location to your emergency contacts.")}
            </Text>
          </>
        ) : null}

        {phase === "dispatched" ? (
          <>
            <Text style={styles.headline}>
              {translate("HELP IS ON THE WAY")}
            </Text>
            <Text style={styles.subhead}>
              {translate("Your emergency contacts have been notified.")}
            </Text>
            <TouchableOpacity
              style={styles.dismissBtn}
              onPress={resetAlert}
              accessibilityRole="button"
              accessibilityLabel={translate("Dismiss crash alert")}
            >
              <Text style={styles.dismissLabel}>{translate("Dismiss")}</Text>
            </TouchableOpacity>
          </>
        ) : null}

        {phase === "failed" ? (
          <>
            <Text style={styles.headline}>{translate("ALERT FAILED")}</Text>
            <Text style={styles.subhead}>
              {errorMessage ?? translate("Unable to reach the server.")}
            </Text>
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={() => {
                // Only rotate the incident id when the previous
                // failure was a backend-completed permanent failure
                // (every contact's send rejected, dispatch_completed_at
                // set). For transient failures (network error, timeout,
                // in-flight bound exhausted) the original `alertId` was
                // either never recorded server-side or the original
                // dispatch is still in flight — keep the id so the
                // backend can replay deterministically and we don't
                // double-notify. `dispatch()`'s own `inFlightRef`
                // guard still dedupes a double-tap either way.
                if (useCrashStore.getState().failureSource === "completed") {
                  rotateIncidentId();
                }
                // Hop straight to dispatching so the failed UI hides
                // immediately — re-running the 30-second countdown
                // after an explicit retry tap would be worse UX.
                useCrashStore.setState({ phase: "dispatching" });
                void dispatch();
              }}
              accessibilityRole="button"
              accessibilityLabel={translate("Retry crash alert")}
            >
              <Text style={styles.cancelLabel}>{translate("RETRY")}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.dismissBtn}
              onPress={resetAlert}
              accessibilityRole="button"
              accessibilityLabel={translate("Dismiss without alerting")}
            >
              <Text style={styles.dismissLabel}>{translate("Dismiss")}</Text>
            </TouchableOpacity>
          </>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: CRASH_BG,
    alignItems: "center",
    justifyContent: "center",
    padding: brandSpacing.s5,
    gap: brandSpacing.s4,
  },
  headline: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 32,
    fontWeight: "800",
    letterSpacing: 1,
    textAlign: "center",
  },
  subhead: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
  countdown: {
    color: t.fg,
    fontFamily: brandFonts.mono,
    fontSize: 160,
    lineHeight: 170,
    fontWeight: "800",
  },
  cancelBtn: {
    marginTop: brandSpacing.s5,
    paddingHorizontal: brandSpacing.s8,
    paddingVertical: brandSpacing.s4,
    borderRadius: brandRadii.pill,
    backgroundColor: t.invFg,
    minWidth: 280,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 1,
  },
  dismissBtn: {
    marginTop: brandSpacing.s4,
    paddingHorizontal: brandSpacing.s5,
    paddingVertical: brandSpacing.s3,
    minHeight: 44,
    justifyContent: "center",
    borderRadius: brandRadii.pill,
    borderWidth: 2,
    borderColor: t.fg,
  },
  dismissLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
});
