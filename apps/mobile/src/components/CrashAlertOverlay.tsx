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
import { borderRadius, colors, fontSize, fontWeight, spacing } from "@/theme";
import { useCrashStore } from "@/stores";
import { api } from "@/services/api";
import { CRASH_DEFAULTS } from "@/services/crashDetector";
import { ttsService } from "@/services/tts";

const COUNTDOWN_TICK_MS = 250;
/** Pulse cadence while the overlay is up — matches alarm-clock timing. */
const HAPTIC_PULSE_MS = 1_000;

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
  const phase = useCrashStore((s) => s.phase);
  const alert = useCrashStore((s) => s.alert);
  const errorMessage = useCrashStore((s) => s.errorMessage);
  const cancel = useCrashStore((s) => s.cancel);
  const beginDispatch = useCrashStore((s) => s.beginDispatch);
  const markDispatched = useCrashStore((s) => s.markDispatched);
  const markFailed = useCrashStore((s) => s.markFailed);
  const resetAlert = useCrashStore((s) => s.reset);

  const [remainingMs, setRemainingMs] = useState(countdownMs);
  const dispatchedRef = useRef(false);
  // Lifted out of the countdown effect so the AppState handler can also
  // recompute the remaining time when the rider returns from background
  // — see the foreground hook below.
  const startedAtRef = useRef<number | null>(null);

  const visible = phase !== "idle";

  // ── Countdown ticker ──
  useEffect(() => {
    if (phase !== "countdown") {
      setRemainingMs(countdownMs);
      dispatchedRef.current = false;
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
      "Crash detected. Tap I'm OK to cancel, or help will be alerted.",
    );
    const pulse = setInterval(() => haptics.trigger(), HAPTIC_PULSE_MS);
    return () => clearInterval(pulse);
  }, [phase]);

  // ── Auto-dispatch on countdown elapsed ──
  const dispatch = useCallback(async () => {
    if (dispatchedRef.current) return;
    dispatchedRef.current = true;
    if (!alert) {
      // Defensive: no snapshot means we have nothing to send. Surface as
      // a failure so the rider knows the alert didn't go out.
      markFailed("No location captured for the alert.");
      return;
    }
    // GPS may have had no fix when the spike landed (tunnel, indoor
    // start, dead module). Don't fall back to `(0, 0)` — that's Null
    // Island in the Atlantic and would dispatch a meaningless location
    // to emergency contacts during a real crash. Better to fail loudly
    // so the rider can fall back to a manual call. (Bugbot 5069fc01.)
    if (alert.lat === null || alert.lng === null) {
      markFailed("No GPS fix at the moment of impact.");
      return;
    }
    // Flip into the dispatching phase BEFORE the network call so the
    // cancel button is hidden for the rest of the request lifecycle.
    // Without this gate the rider could tap "I'm OK" while the POST is
    // already in flight — the backend may already have queued the alert
    // and notified contacts, so flipping the local store to idle would
    // contradict reality and trigger a "HELP IS ON THE WAY" screen on
    // the resolve. (Bugbot 1032971c.)
    beginDispatch();
    try {
      await api.sendCrashAlert(
        alert.lat,
        alert.lng,
        alert.rideId ?? undefined,
        alert.speedAtImpact ?? undefined,
      );
      markDispatched();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Couldn't reach the server.";
      markFailed(message);
    }
  }, [alert, beginDispatch, markDispatched, markFailed]);

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
            <Text style={styles.headline}>CRASH DETECTED</Text>
            <Text style={styles.subhead}>
              We'll alert your emergency contacts in
            </Text>
            <Text style={styles.countdown} accessibilityLiveRegion="assertive">
              {seconds}
            </Text>
            <Text style={styles.subhead}>seconds</Text>
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={cancel}
              accessibilityRole="button"
              accessibilityLabel="I'm OK, cancel crash alert"
            >
              <Text style={styles.cancelLabel}>I'M OK — CANCEL</Text>
            </TouchableOpacity>
          </>
        ) : null}

        {phase === "dispatching" ? (
          <>
            <Text style={styles.headline}>ALERTING CONTACTS…</Text>
            <Text style={styles.subhead}>
              Sending your location to your emergency contacts.
            </Text>
          </>
        ) : null}

        {phase === "dispatched" ? (
          <>
            <Text style={styles.headline}>HELP IS ON THE WAY</Text>
            <Text style={styles.subhead}>
              Your emergency contacts have been notified.
            </Text>
            <TouchableOpacity
              style={styles.dismissBtn}
              onPress={resetAlert}
              accessibilityRole="button"
              accessibilityLabel="Dismiss crash alert"
            >
              <Text style={styles.dismissLabel}>Dismiss</Text>
            </TouchableOpacity>
          </>
        ) : null}

        {phase === "failed" ? (
          <>
            <Text style={styles.headline}>ALERT FAILED</Text>
            <Text style={styles.subhead}>
              {errorMessage ?? "Unable to reach the server."}
            </Text>
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={() => {
                dispatchedRef.current = false;
                // Skip straight back to dispatching — going through
                // countdown would re-prompt the rider with a 30-second
                // "I'm OK" timer after they explicitly chose to retry,
                // which is worse UX than just re-firing the request.
                useCrashStore.setState({ phase: "dispatching" });
                void dispatch();
              }}
              accessibilityRole="button"
              accessibilityLabel="Retry crash alert"
            >
              <Text style={styles.cancelLabel}>RETRY</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.dismissBtn}
              onPress={resetAlert}
              accessibilityRole="button"
              accessibilityLabel="Dismiss without alerting"
            >
              <Text style={styles.dismissLabel}>Dismiss</Text>
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
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.lg,
  },
  headline: {
    color: colors.textInverse,
    fontSize: fontSize.h1,
    fontWeight: fontWeight.black,
    letterSpacing: 1,
    textAlign: "center",
  },
  subhead: {
    color: colors.textInverse,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    textAlign: "center",
  },
  countdown: {
    color: colors.textInverse,
    fontSize: 160,
    lineHeight: 170,
    fontWeight: fontWeight.black,
  },
  cancelBtn: {
    marginTop: spacing.xl,
    paddingHorizontal: spacing.xxxl,
    paddingVertical: spacing.lg,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.textInverse,
    minWidth: 280,
    alignItems: "center",
  },
  cancelLabel: {
    color: colors.danger,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.black,
    letterSpacing: 1,
  },
  dismissBtn: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    borderWidth: 2,
    borderColor: colors.textInverse,
  },
  dismissLabel: {
    color: colors.textInverse,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
});
