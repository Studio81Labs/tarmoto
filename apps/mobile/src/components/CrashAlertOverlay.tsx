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
  const markDispatched = useCrashStore((s) => s.markDispatched);
  const markFailed = useCrashStore((s) => s.markFailed);
  const resetAlert = useCrashStore((s) => s.reset);

  const [remainingMs, setRemainingMs] = useState(countdownMs);
  const dispatchedRef = useRef(false);

  const visible =
    phase === "countdown" || phase === "dispatched" || phase === "failed";

  // ── Countdown ticker ──
  useEffect(() => {
    if (phase !== "countdown") {
      setRemainingMs(countdownMs);
      dispatchedRef.current = false;
      return;
    }
    setRemainingMs(countdownMs);
    const startedAt = Date.now();
    const id = setInterval(() => {
      const elapsed = Date.now() - startedAt;
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
    try {
      await api.sendCrashAlert(
        alert.lat ?? 0,
        alert.lng ?? 0,
        alert.rideId ?? undefined,
        alert.speedAtImpact ?? undefined,
      );
      markDispatched();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Couldn't reach the server.";
      markFailed(message);
    }
  }, [alert, markDispatched, markFailed]);

  useEffect(() => {
    if (phase === "countdown" && remainingMs <= 0) {
      void dispatch();
    }
  }, [phase, remainingMs, dispatch]);

  // ── Foreground re-trigger ──
  // If the rider's phone backgrounded mid-countdown the overlay is still
  // active when they return — but timers continue counting in JS. This
  // hook is only here to make sure the overlay forces a re-render when
  // the app comes back into focus, so the displayed seconds don't lag.
  useEffect(() => {
    if (phase !== "countdown") return;
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next === "active") setRemainingMs((prev) => prev);
    });
    return () => sub.remove();
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
                useCrashStore.setState({ phase: "countdown" });
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
