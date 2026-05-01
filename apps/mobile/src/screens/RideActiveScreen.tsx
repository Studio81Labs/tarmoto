/**
 * RideActiveScreen — US-19 live ride HUD.
 *
 * The screen is glove-friendly: large numbers, high contrast, and the
 * stop-ride flow is gated behind a confirmation alert so a misclick on
 * a bumpy road can't end a ride. Three-row layout:
 *
 *   1. Speed (the headline metric — visible at a glance from a
 *      handlebar mount).
 *   2. Distance + duration side-by-side, plus the segment counter so
 *      the rider knows the sensor pipeline is alive.
 *   3. Current road quality with a surface icon. Falls back to a
 *      neutral "no reading yet" state until the first ML window lands.
 *
 * The screen subscribes to `useRideStore` for everything the sensor
 * pipeline writes (speed, quality, distance, segment count, duration).
 * Duration ticks centrally in `RideDurationTicker` (mounted at the
 * navigator root, so it keeps counting even when this screen isn't
 * focused) — this screen just renders the value the store carries.
 *
 * Quality-drop haptics: when the current quality falls below the
 * rider's `minQuality` preference, a single warning haptic fires. We
 * latch on the threshold-crossing (not on every quality update) so a
 * bumpy stretch doesn't strobe the phone non-stop. The latch is
 * cleared whenever the classifier returns null so a fresh below-
 * threshold reading after a "no signal" gap is treated as a new event.
 *
 * The US-4 hazard-report FAB stays mounted in the bottom-right corner
 * so a rider can flag a pothole or oil spill without leaving the HUD.
 */
import React, {
  type ComponentProps,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Icon from "@react-native-vector-icons/material-design-icons";
import ReactNativeHapticFeedback from "react-native-haptic-feedback";
import DeviceInfo from "react-native-device-info";
import HazardReportFab from "@/components/HazardReportFab";
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  meetsQualityThreshold,
  qualityColor,
  qualityLabel,
  shadows,
  spacing,
} from "@/theme";
import { useFormattedDuration, useKeepAwake } from "@/hooks";
import { api } from "@/services/api";
import { locationService } from "@/services/location";
import { getActiveModelVersion } from "@/services/mlClassifier";
import { sensorService } from "@/services/sensors";
import { ttsService } from "@/services/tts";
import { usePreferencesStore, useRideStore } from "@/stores";
import type { RideStackParamList } from "@/navigation/RootNavigator";
import type { HazardType, RideDetail } from "@/types";
import {
  formatDistanceKm,
  formatSpeedKmh,
  qualityScoreFromClass,
  surfaceIcon,
  surfaceLabel,
} from "./RideScreens.helpers";

type RideActiveRoute = RouteProp<RideStackParamList, "RideActive">;
type RideActiveNav = NativeStackNavigationProp<
  RideStackParamList,
  "RideActive"
>;
type IconName = ComponentProps<typeof Icon>["name"];

const HAPTIC_CONFIG = {
  enableVibrateFallback: true,
  ignoreAndroidSystemSettings: false,
};

/**
 * Module-scoped reference to the in-flight `/rides/start` promise.
 *
 * The original implementation held this in a per-mount `useRef`, but
 * that broke a real failure mode: rider taps Start (mount #1 owns the
 * promise), backs out, taps the in-progress banner (mount #2 has a
 * fresh `null` ref), then taps Stop while the POST is still pending.
 * Mount #2's `stopAndExit` would find no id locally — `activeRide.id`
 * still null, ref empty — bail out of the upload path, and the
 * captured sensor readings would be silently dropped. Hoisting the
 * promise to module scope lets any mount of this screen await the
 * same in-flight POST and still get a rideId in time to upload.
 *
 * Cleared by the success / error handler so a stale resolved promise
 * can't be awaited after the ride has already been stopped.
 */
let pendingStartPromise: Promise<RideDetail> | null = null;

/**
 * Test-only escape hatch for resetting the module-level
 * `pendingStartPromise` between specs. Real callers must never use
 * this — the promise is supposed to settle naturally via
 * `.finally`, and a stray reset mid-ride would orphan the in-flight
 * POST. The underscore prefix makes the intent explicit.
 */
export function __resetPendingStartPromiseForTests(): void {
  pendingStartPromise = null;
}

export default function RideActiveScreen() {
  const { params } = useRoute<RideActiveRoute>();
  const navigation = useNavigation<RideActiveNav>();
  useKeepAwake(true);

  const currentSpeed = useRideStore((s) => s.currentSpeed);
  const currentQuality = useRideStore((s) => s.currentQuality);
  const distance = useRideStore((s) => s.distance);
  const duration = useRideStore((s) => s.duration);
  const segmentCount = useRideStore((s) => s.segmentCount);
  const stopRideAction = useRideStore((s) => s.stopRide);
  const minQuality = usePreferencesStore((s) => s.minQuality);

  // ── Ride lifecycle: ensure a ride is active when the screen mounts. ──
  //
  // Two entry points to handle:
  //
  //   1. Fresh start — coming from the "Start a ride" CTA. Flip the
  //      local store flag and POST `/rides/start` so the backend has an
  //      id we can later stop and upload sensor windows against.
  //
  //   2. Resume — the rider left the screen mid-ride and tapped the
  //      "Ride in progress" banner. The store still has `isRiding=true`
  //      and `activeRide` already carries the backend id. We must NOT
  //      re-post `/rides/start` here (would create a duplicate ride
  //      every time the rider toggles tabs) — just reuse the existing
  //      id.
  //
  // The effect runs exactly once per mount (guarded by `startedRef`)
  // and reads from `useRideStore.getState()` directly so the dependency
  // array doesn't change when the store flips `isRiding` synchronously.
  // Earlier we listed `isRiding` in deps, which caused React to tear
  // down the cleanup mid-flight and skip `setActiveRide` once the POST
  // resolved.
  //
  // The in-flight start promise is captured in a ref so `stopAndExit`
  // can await it: if the rider taps Stop before the POST resolves, we
  // wait for the id and then call `/rides/:id/stop` rather than letting
  // the backend ride hang in `active`.
  const [startError, setStartError] = useState<string | null>(null);
  const [isStopping, setIsStopping] = useState(false);
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const store = useRideStore.getState();
    if (store.activeRide?.id) {
      // Resume with a known backend id — nothing to do.
      return;
    }
    if (store.isRiding && pendingStartPromise) {
      // Resume mid-flight — a prior mount's `/rides/start` POST is
      // still in flight and owns `pendingStartPromise`. Don't
      // double-post and don't restart telemetry; the original mount
      // already started both. (Restarting `locationService` here
      // would reset `totalDistance` to 0 and leak the prior watch.)
      return;
    }

    // Two paths land here:
    //
    //   - Fresh start (`!isRiding && !activeRide.id`): flip the local
    //     flag, start telemetry singletons, POST `/rides/start`.
    //
    //   - Resume after a failed start (`isRiding && !activeRide.id &&
    //     !pendingStartPromise`): a prior mount already flipped
    //     `isRiding` and started telemetry, but its POST rejected and
    //     left us local-only with no backend id. We MUST retry the
    //     POST here — otherwise the next stop has no id, skips
    //     `/rides/:id/stop` and `submitSensorData`, and the entire
    //     ride payload is dropped on transient start failures. We
    //     deliberately don't re-flip `isRiding` or restart telemetry
    //     in this case: the singletons are still running.
    const isFreshStart = !store.isRiding;
    if (isFreshStart) {
      store.startRide(params.rideType);
      // ── Telemetry capture ──
      // Without this the HUD stayed pegged at 0 km/h / 0 km / 0
      // segments even on a real ride: `sensorService` and
      // `locationService` are singletons that nothing else starts
      // on the ride path, so the store fields the screen renders
      // never receive any updates.
      sensorService.start((_features, classification) => {
        const s = useRideStore.getState();
        s.updateQuality(classification);
        s.incrementSegments();
      });
      locationService.start((update) => {
        const s = useRideStore.getState();
        s.updateLocation(update);
        s.updateSpeed(update.speed);
        // `locationService.getDistance()` is in metres; the store
        // and backend agree on kilometres for ride distance.
        s.updateDistance(locationService.getDistance() / 1000);
      });
    }

    const promise = api.startRide(params.rideType);
    pendingStartPromise = promise;
    // Snapshot the local ride session so the success handler can detect
    // a stale resolve. Two scenarios this guards against:
    //
    //   1. Rider backs out of the HUD, taps Stop on the in-progress
    //      banner before the POST resolves. `stopAndExit` clears local
    //      state without an id; the original POST eventually lands and
    //      would otherwise call `setActiveRide(ride)` on a finished
    //      ride — leaving an orphaned `active` row on the backend AND
    //      stranding the resume guard so the next "Start a ride" tap
    //      gets short-circuited and the rider can't open a new ride.
    //
    //   2. Rider stops, then starts a fresh ride before the original
    //      POST resolves. The stale resolve must not overwrite the new
    //      ride's id.
    //
    // `startedAtMs` is set inside `store.startRide(...)` (called above)
    // and cleared / replaced by every subsequent start/stop, so it's a
    // reliable session identifier.
    const sessionStartedAtMs = useRideStore.getState().startedAtMs;
    void promise
      .then((ride) => {
        const current = useRideStore.getState();
        if (current.startedAtMs !== sessionStartedAtMs) {
          // Local session moved on. Best-effort cleanup of the orphaned
          // backend ride so it doesn't sit in `active` forever and
          // block the rider's next start (one-active-ride-per-user).
          void api.stopRide(ride.id).catch(() => undefined);
          return;
        }
        current.setActiveRide(ride);
      })
      .catch((err) => {
        setStartError(
          err instanceof Error ? err.message : "Couldn't sync ride to server",
        );
      })
      .finally(() => {
        // Only clear the module-level handle if we still own it. A
        // newer ride started after a stop has already overwritten
        // it; clobbering it back to null here would strand that
        // newer mount's `stopAndExit` without anything to await.
        if (pendingStartPromise === promise) {
          pendingStartPromise = null;
        }
      });
  }, [params.rideType]);

  // ── Duration display ──
  // Sourced from the store, which is ticked by the root-level
  // `RideDurationTicker` so the count keeps advancing even when this
  // screen isn't focused. The HUD doesn't run its own setInterval —
  // doing so would freeze the count whenever the rider backed out
  // of the live HUD mid-ride and lose those seconds permanently when
  // they came back.
  const durationLabel = useFormattedDuration(duration);

  // ── Quality-drop haptic ──
  // Use the shared `meetsQualityThreshold` helper so the haptic, the
  // map filter, and the planning UI all interpret `minQuality` the same
  // way (the preference is an integer pegged to the half-step bucket
  // boundaries — a "Good or better" filter passes anything ≥3.5).
  // Without this, a 3.9 reading would be labelled "Good" by qualityLabel
  // yet still trigger the warning haptic.
  const qualityScore = qualityScoreFromClass(currentQuality);
  const lastBelowRef = useRef(false);
  useEffect(() => {
    if (!currentQuality) {
      // Classifier dropped out (e.g. between sensor windows). Clear
      // the latch so when readings resume, a fresh below-threshold
      // value is treated as a new event instead of being silently
      // suppressed by the previous session's latch.
      lastBelowRef.current = false;
      return;
    }
    const isBelow =
      qualityScore > 0 && !meetsQualityThreshold(qualityScore, minQuality);
    if (isBelow && !lastBelowRef.current) {
      ReactNativeHapticFeedback.trigger("notificationWarning", HAPTIC_CONFIG);
    }
    lastBelowRef.current = isBelow;
  }, [currentQuality, qualityScore, minQuality]);

  const stopAndExit = useCallback(async () => {
    if (isStopping) return;
    setIsStopping(true);
    // Resolve the rideId by waiting on any in-flight `/rides/start` so
    // a quick stop on a slow network still cleans up the backend ride
    // AND uploads the captured sensor readings. The promise lives at
    // module scope so a re-mount that didn't kick off the POST itself
    // (resume path on a slow network) can still await it — without
    // that, telemetry would be silently dropped.
    let id = useRideStore.getState().activeRide?.id ?? null;
    if (!id && pendingStartPromise) {
      try {
        const ride = await pendingStartPromise;
        id = ride.id;
      } catch {
        // Start failed → there's no backend ride to stop.
      }
    }
    if (id) {
      try {
        await api.stopRide(id);
      } catch (err) {
        // Don't silently swallow: clearing local state without a
        // matching backend stop locks the rider out of new rides
        // (the backend enforces one active ride per user). Surface
        // an alert with retry / force-stop choices and bail out of
        // the cleanup path so the rider can try again.
        setIsStopping(false);
        const message =
          err instanceof Error ? err.message : "Unable to reach the server.";
        Alert.alert("Couldn't stop ride", message, [
          { text: "Try again", onPress: () => void stopAndExit() },
          {
            text: "Discard locally",
            style: "destructive",
            onPress: () => {
              // Even on the local-only escape hatch we must release
              // the OS-level recording handles. Without this the GPS
              // watch + accelerometer/gyroscope subscriptions would
              // keep running for the rest of the app session,
              // burning battery and CPU on a "stopped" ride. The
              // captured readings are intentionally dropped — this
              // path is for the "rider knows they're offline and
              // accepts the lost data" case.
              locationService.stop();
              sensorService.stop();
              stopRideAction();
              navigation.goBack();
            },
          },
          { text: "Keep riding", style: "cancel" },
        ]);
        return;
      }
    }

    // ── Drain telemetry into the upload queue ──
    // `locationService.stop()` releases the watchPosition handle.
    // `sensorService.stop()` returns the buffered window readings AND
    // tears down the accelerometer/gyro subscriptions. We then hand
    // the readings to `api.submitSensorData` which routes through the
    // offline-aware queue (US-18 AC #4) — so an offline stop still
    // persists the data, it just lands once the link returns. We
    // intentionally do this *after* `/rides/:id/stop` so the backend
    // already has a ride row by the time the segment updates arrive.
    locationService.stop();
    const readings = sensorService.stop();
    if (id && readings.length > 0) {
      try {
        await api.submitSensorData(
          id,
          readings,
          DeviceInfo.getModel(),
          getActiveModelVersion(),
        );
      } catch {
        // Submission already routes through the offline queue, so any
        // exception here is exotic (programmer error, native module
        // not linked, etc.). Don't block the stop flow on it — the
        // backend ride is already stopped and the queue's drain path
        // owns the retry semantics from here.
      }
    }

    stopRideAction();
    navigation.goBack();
  }, [isStopping, stopRideAction, navigation]);

  const confirmStop = useCallback(() => {
    Alert.alert(
      "Stop ride?",
      "We'll save your stats and stop recording.",
      [
        { text: "Keep riding", style: "cancel" },
        {
          text: "Stop ride",
          style: "destructive",
          onPress: () => void stopAndExit(),
        },
      ],
      { cancelable: true },
    );
  }, [stopAndExit]);

  const handleOpenReport = useCallback(
    (preselectedType?: HazardType) => {
      navigation.navigate(
        "HazardReport",
        preselectedType ? { preselectedType } : undefined,
      );
    },
    [navigation],
  );

  // US-26 — entry into the group ride share screen. Opt-in: nothing
  // is broadcast until the rider explicitly creates or joins a ride
  // and starts publishing positions from there.
  const handleOpenGroupRide = useCallback(() => {
    navigation.navigate("GroupRide");
  }, [navigation]);

  const speedLabel = formatSpeedKmh(currentSpeed);
  const distanceLabel = formatDistanceKm(distance);
  const hasQuality = currentQuality !== null;
  const qLabel = hasQuality ? qualityLabel(qualityScore) : "Listening…";
  const qColor = hasQuality ? qualityColor(qualityScore) : colors.textTertiary;
  const surface = currentQuality?.surface_type ?? null;

  return (
    <View style={styles.container} accessibilityLabel="Active ride HUD">
      <View style={styles.header}>
        <Icon
          name="record-circle-outline"
          size={14}
          color={colors.danger}
          accessibilityElementsHidden
        />
        <Text style={styles.headerLabel}>RECORDING</Text>
        <View style={styles.headerSpacer} />
        <TouchableOpacity
          onPress={handleOpenGroupRide}
          accessibilityRole="button"
          accessibilityLabel="Open group ride"
          style={styles.groupRideToggle}
        >
          <Icon name="account-group" size={20} color={colors.primary} />
        </TouchableOpacity>
        <VoiceMuteToggle />
      </View>

      {startError ? (
        <View style={styles.warningBanner}>
          <Icon name="cloud-off-outline" size={16} color={colors.warning} />
          <Text style={styles.warningText}>{startError}</Text>
        </View>
      ) : null}

      <View
        style={styles.speedBlock}
        accessibilityLabel={`Speed ${speedLabel}`}
      >
        <Text style={styles.speedValue}>{Math.round(currentSpeed)}</Text>
        <Text style={styles.speedUnit}>km/h</Text>
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statBlock}>
          <Text style={styles.statLabel}>Distance</Text>
          <Text style={styles.statValue}>{distanceLabel}</Text>
        </View>
        <View style={styles.statBlock}>
          <Text style={styles.statLabel}>Duration</Text>
          <Text style={styles.statValue}>{durationLabel}</Text>
        </View>
      </View>

      <View
        style={[styles.qualityCard, { borderColor: qColor }]}
        accessibilityLabel={`Road quality ${qLabel}`}
      >
        <View
          style={[
            styles.qualityIconWrap,
            { backgroundColor: hasQuality ? qColor + "22" : colors.bgElevated },
          ]}
        >
          <Icon
            name={surfaceIcon(surface ?? "unknown") as IconName}
            size={32}
            color={qColor}
          />
        </View>
        <View style={styles.qualityBody}>
          <Text style={[styles.qualityLabel, { color: qColor }]}>{qLabel}</Text>
          {surface ? (
            <Text style={styles.qualitySurface}>{surfaceLabel(surface)}</Text>
          ) : (
            <Text style={styles.qualitySurface}>
              Waiting for the first reading…
            </Text>
          )}
        </View>
      </View>

      <View style={styles.segmentRow}>
        <Icon name="counter" size={18} color={colors.textTertiary} />
        <Text style={styles.segmentText}>
          {segmentCount} segment{segmentCount === 1 ? "" : "s"} recorded
        </Text>
      </View>

      <View style={styles.stopBtnSpacer} />

      <TouchableOpacity
        style={styles.stopBtn}
        onPress={confirmStop}
        accessibilityRole="button"
        accessibilityLabel="Stop ride"
        disabled={isStopping}
      >
        <Icon name="stop-circle" size={22} color={colors.textInverse} />
        <Text style={styles.stopLabel}>
          {isStopping ? "Stopping…" : "Stop ride"}
        </Text>
      </TouchableOpacity>

      <HazardReportFab
        onOpenReport={handleOpenReport}
        style={styles.hazardFab}
      />
    </View>
  );
}

function VoiceMuteToggle() {
  // Tracks the TTS singleton's mute flag locally so re-presses re-render
  // the icon. We don't subscribe to the service (it doesn't expose an
  // observable) — flipping our state in the same handler keeps the
  // local view in sync because nothing else can mutate it from this
  // screen.
  const [muted, setMuted] = useState<boolean>(() => ttsService.isMuted());
  const toggle = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      ttsService.setMuted(next);
      return next;
    });
  }, []);
  return (
    <TouchableOpacity
      onPress={toggle}
      accessibilityRole="button"
      accessibilityLabel={
        muted ? "Unmute voice guidance" : "Mute voice guidance"
      }
      accessibilityState={{ selected: muted }}
      style={styles.voiceToggle}
    >
      <Icon
        name={muted ? "volume-off" : "volume-high"}
        size={20}
        color={muted ? colors.textTertiary : colors.primary}
      />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.xl,
    gap: spacing.lg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingTop: spacing.md,
  },
  headerSpacer: {
    flex: 1,
  },
  voiceToggle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
  },
  groupRideToggle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerLabel: {
    color: colors.danger,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    letterSpacing: 1,
  },
  warningBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: borderRadius.md,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  warningText: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    flex: 1,
  },
  speedBlock: {
    alignItems: "center",
    paddingVertical: spacing.lg,
  },
  speedValue: {
    color: colors.textPrimary,
    fontSize: 120,
    fontWeight: fontWeight.black,
    lineHeight: 130,
  },
  speedUnit: {
    color: colors.textSecondary,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.semibold,
    letterSpacing: 1,
  },
  statsRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  statBlock: {
    flex: 1,
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statLabel: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  statValue: {
    color: colors.textPrimary,
    fontSize: fontSize.h2,
    fontWeight: fontWeight.bold,
    marginTop: spacing.xs,
  },
  qualityCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
  },
  qualityIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  qualityBody: {
    flex: 1,
    gap: 2,
  },
  qualityLabel: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
  },
  qualitySurface: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  segmentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  segmentText: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  stopBtnSpacer: {
    flex: 1,
  },
  stopBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.danger,
    ...shadows.button,
  },
  stopLabel: {
    color: colors.textInverse,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  hazardFab: {
    position: "absolute",
    right: spacing.lg,
    // Sit above the Stop-ride pill so a long-press on the FAB doesn't
    // overlap the destructive Stop-ride hitbox.
    bottom: spacing.section + spacing.lg,
  },
});
