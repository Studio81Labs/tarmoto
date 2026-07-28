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
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  PermissionsAndroid,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "@/components/Icon";
import ReactNativeHapticFeedback from "react-native-haptic-feedback";
import DeviceInfo from "react-native-device-info";
import HazardReportFab from "@/components/HazardReportFab";
import SurfaceTagFab from "@/components/SurfaceTagFab";
import { meetsQualityThreshold, qualityLabel } from "@/theme";
import {
  ACCENT,
  brandColorsDark,
  brandFonts,
  brandRadii,
  brandSpacing,
  qualityBrandColor,
  QUALITY_COLORS,
  statusFg,
} from "@/theme/brand";
import { useFormattedDuration, useKeepAwake } from "@/hooks";
import { api } from "@/services/api";
import { locationService } from "@/services/location";
import { requestWithRationale } from "@/services/permissions";
import { getActiveModelVersion } from "@/services/mlClassifier";
import { sensorService } from "@/services/sensors";
import { isSystemSwitchEnabled } from "@/services/systemSwitchCache";
import { ttsService } from "@/services/tts";
import { usePreferencesStore, useRideStore } from "@/stores";
import type { RideStackParamList } from "@/navigation/RootNavigator";
import type { Bike, HazardType, RideResponse } from "@/types";
import type { SurfaceLabel } from "@tarmoto/shared";
import {
  formatDistanceKm,
  formatSpeedKmh,
  qualityScoreFromClass,
  splitSpeedKmh,
  surfaceIcon,
  surfaceLabel,
} from "./RideScreens.helpers";
import { getUserFacingErrorMessage } from "@/i18n";
import { useTranslation } from "@/i18n/I18nProvider";

type RideActiveRoute = RouteProp<RideStackParamList, "RideActive">;
type RideActiveNav = NativeStackNavigationProp<
  RideStackParamList,
  "RideActive"
>;

// Always-dark immersive HUD → the brand night palette. On this near-black
// surface the Q1–Q5 ramp clears AA as text/icon, so the quality card keeps
// the ramp directly (rule #4) rather than the swatch-dot treatment that the
// cream surfaces need.
const t = brandColorsDark;
const RECORDING_RED = QUALITY_COLORS[0];

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
let pendingStartPromise: Promise<RideResponse> | null = null;

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
  const translate = useTranslation();
  // The ride-start effect is intentionally one-shot: restarting it on a
  // language change can duplicate telemetry or cancel an in-flight permission
  // gate. Async continuations still need the latest translator, so keep a
  // live ref instead of capturing the mount-time function.
  const translateRef = useRef(translate);
  useEffect(() => {
    translateRef.current = translate;
  }, [translate]);
  const { params } = useRoute<RideActiveRoute>();
  const navigation = useNavigation<RideActiveNav>();
  // The tab bar is hidden on this immersive route, so it no longer reserves
  // the device bottom inset; pad the HUD so the Stop-ride controls clear the
  // home indicator.
  const insets = useSafeAreaInsets();
  useKeepAwake(true);

  const currentSpeed = useRideStore((s) => s.currentSpeed);
  const currentQuality = useRideStore((s) => s.currentQuality);
  const distance = useRideStore((s) => s.distance);
  const duration = useRideStore((s) => s.duration);
  const segmentCount = useRideStore((s) => s.segmentCount);
  const maxLeanDeg = useRideStore((s) => s.maxLeanDeg);
  const leanCalibrating = useRideStore((s) => s.leanCalibrating);
  const stopRideAction = useRideStore((s) => s.stopRide);
  const minQuality = usePreferencesStore((s) => s.minQuality);

  const handleRecalibrateLean = useCallback(() => {
    // Re-enter the orientation filter's calibration window. The HUD's
    // lean tile flips back to "Calibrating…" until the next ~1.5 s of
    // upright readings settle the offset. The store mirror flips on
    // the next window callback (`reportLeanWindow`).
    sensorService.recalibrateLean();
    useRideStore.setState({ leanCalibrating: true });
  }, []);

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
  const [activeBike, setActiveBike] = useState<Bike | null>(null);
  // Surface tags are buffered inside the sensor session and only ship when it
  // records — so tagging is available exactly when the accel session is
  // running. `sys_accel_collection` force_off skips `sensorService.start`, so
  // the FAB must hide (rather than fire a success haptic then silently discard
  // the tag). Seed from the singleton so a resume mount — where a prior mount
  // already started the session — shows the FAB immediately. Refined by the
  // ride-start effect below.
  const [sensorSessionActive, setSensorSessionActive] = useState(
    () => sensorService.recording,
  );
  const startedRef = useRef(false);

  // ── Active bike chip (US-64). ──
  //
  // Surfaces "Honda · Africa Twin" so the rider can sanity-check which
  // bike the ride is being attributed to before they commit. The actual
  // attribution happens server-side in `/rides/start` (omitting bike_id
  // pins to the active bike), so a fetch failure here is non-fatal —
  // we just hide the chip and the ride proceeds.
  useEffect(() => {
    let cancelled = false;
    api
      .getActiveBike()
      .then((bike) => {
        if (!cancelled) setActiveBike(bike);
      })
      .catch(() => {
        // Hide the chip on transient network issues; the backend still
        // tags the ride with whichever bike is active in the rider's
        // garage.
        if (!cancelled) setActiveBike(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
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

    // Shared kick-off for `/rides/start`. Used by both the fresh-start
    // path (after the permission gate clears) and the resume-after-fail
    // path (telemetry is already running, we just need to retry the
    // POST so the backend has an id).
    const kickOffApiStart = () => {
      const promise = api.startRide(params.rideType);
      pendingStartPromise = promise;
      // Snapshot the local ride session so the success handler can
      // detect a stale resolve. Two scenarios this guards against:
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
      // `startedAtMs` is set inside `store.startRide(...)` and cleared /
      // replaced by every subsequent start/stop, so it's a reliable
      // session identifier.
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
            getUserFacingErrorMessage(
              err,
              translateRef.current("Couldn't sync ride to server"),
            ),
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
    };

    if (!isFreshStart) {
      // Resume after a failed start: telemetry is already running from
      // the prior mount; just retry the `/rides/start` POST. No
      // permission gate — the rider already cleared it on the first
      // attempt, and re-prompting mid-ride would be jarring.
      // Surface tagging follows the live session: the prior mount decided
      // whether to start the sensors (per `sys_accel_collection`), so mirror
      // its actual recording state rather than re-reading the switch.
      setSensorSessionActive(sensorService.recording);
      kickOffApiStart();
      return;
    }

    // Fresh start: gate on `ACCESS_FINE_LOCATION` (issue #280) before
    // touching the singletons. Without this the HUD pegs at 0 km/h on
    // Android (no permission → watchPosition emits nothing) and on iOS
    // riders saw an empty plist string before #280. If the rider
    // declines, pop the screen with no side effects.
    let cancelled = false;
    void (async () => {
      const status = await requestWithRationale({
        androidPermission: PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        rationale: {
          title: translateRef.current("Location for ride recording"),
          message: translateRef.current(
            "Tarmoto records GPS while you ride to track distance, surface quality, and hazards along the route.",
          ),
          whyOpenSettings: translateRef.current(
            "Location is currently blocked. Open Settings → Tarmoto and allow location to start recording rides.",
          ),
        },
      });
      if (cancelled) return;
      if (status !== "granted") {
        navigation.goBack();
        return;
      }

      store.startRide(params.rideType);
      // ── Telemetry capture ──
      // Without this the HUD stayed pegged at 0 km/h / 0 km / 0
      // segments even on a real ride: `sensorService` and
      // `locationService` are singletons that nothing else starts
      // on the ride path, so the store fields the screen renders
      // never receive any updates.
      //
      // `sys_accel_collection` is the operator kill switch for the raw
      // 50Hz accelerometer/gyro sampling this starts. Only the backend
      // can't stop the phone's sensors, so we gate here: when it's
      // force-disabled we skip sensor start entirely (no surface
      // quality, lean, or crash-detection input), while GPS recording
      // below is unaffected. The cache reads ON by default, so the
      // common path is unchanged.
      const accelCollectionEnabled = isSystemSwitchEnabled(
        "sys_accel_collection",
      );
      // Surface tagging lives inside the sensor session, so it's available
      // only when we actually start it — hide the FAB otherwise.
      setSensorSessionActive(accelCollectionEnabled);
      if (accelCollectionEnabled) {
        sensorService.start((features, classification) => {
          const s = useRideStore.getState();
          s.updateQuality(classification);
          s.incrementSegments();
          // US-19: roll up the per-window lean max into the running
          // per-ride max so the HUD's "Max lean" tile stays current.
          s.reportLeanWindow({
            maxAbsLeanDeg: features.max_abs_lean_deg,
            calibrating: sensorService.isLeanCalibrating(),
          });
        }, DeviceInfo.getModel());
      }
      locationService.start((update) => {
        const s = useRideStore.getState();
        s.updateLocation(update);
        s.updateSpeed(update.speed);
        // `locationService.getDistance()` is in metres; the store
        // and backend agree on kilometres for ride distance.
        s.updateDistance(locationService.getDistance() / 1000);
      });

      kickOffApiStart();
    })();

    return () => {
      // If the screen unmounts before the rationale resolves, suppress
      // the post-permission start so we don't `goBack` on an
      // already-unmounted screen or kick off telemetry that nothing
      // will tear down.
      cancelled = true;
    };
  }, [navigation, params.rideType]);

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
        const message = getUserFacingErrorMessage(
          err,
          translate("Unable to reach the server."),
        );
        Alert.alert(translate("Couldn't stop ride"), message, [
          { text: translate("Try again"), onPress: () => void stopAndExit() },
          {
            text: translate("Discard locally"),
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
          { text: translate("Keep riding"), style: "cancel" },
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
    const { readings, tagEvents, calibration } = sensorService.stop();
    if (id && (readings.length > 0 || tagEvents.length > 0)) {
      try {
        await api.submitSensorData(
          id,
          readings,
          DeviceInfo.getModel(),
          getActiveModelVersion(),
          tagEvents,
          calibration,
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
  }, [isStopping, stopRideAction, navigation, translate]);

  const confirmStop = useCallback(() => {
    Alert.alert(
      translate("Stop ride?"),
      translate("We'll save your stats and stop recording."),
      [
        { text: translate("Keep riding"), style: "cancel" },
        {
          text: translate("Stop ride"),
          style: "destructive",
          onPress: () => void stopAndExit(),
        },
      ],
      { cancelable: true },
    );
  }, [stopAndExit, translate]);

  const handleOpenReport = useCallback(
    (preselectedType?: HazardType) => {
      navigation.navigate(
        "HazardReport",
        preselectedType ? { preselectedType } : undefined,
      );
    },
    [navigation],
  );

  // Research issue #7 — rider taps a surface label on the
  // SurfaceTagFab. Wire straight through to the sensor service so the
  // tap is buffered alongside the raw readings and shipped together
  // on ride stop. The service drops taps that fire while recording is
  // off, so we don't need to gate this on `isRiding` here.
  const handleTagSurface = useCallback((label: SurfaceLabel) => {
    sensorService.tagSurface(label);
  }, []);

  // US-26 — entry into the group ride share screen. Opt-in: nothing
  // is broadcast until the rider explicitly creates or joins a ride
  // and starts publishing positions from there.
  const handleOpenGroupRide = useCallback(() => {
    navigation.navigate("GroupRide");
  }, [navigation]);

  const speedLabel = formatSpeedKmh(currentSpeed);
  const speedDisplay = splitSpeedKmh(currentSpeed);
  const distanceLabel = formatDistanceKm(distance);
  const hasQuality = currentQuality !== null;
  const qLabel = hasQuality
    ? qualityLabel(qualityScore)
    : translate("Listening…");
  const qColor = hasQuality ? qualityBrandColor(qualityScore) : t.dim;
  const surface = currentQuality?.surface_type ?? null;

  return (
    <View
      style={[
        styles.container,
        { paddingBottom: brandSpacing.s5 + insets.bottom },
      ]}
      accessibilityLabel={translate("Active ride HUD")}
    >
      <StatusBar barStyle="light-content" backgroundColor={t.bg} translucent />
      <View style={styles.header}>
        <Icon
          name="record-circle-outline"
          size={14}
          color={RECORDING_RED}
          accessibilityElementsHidden
        />
        <Text style={styles.headerLabel}>{translate("RECORDING")}</Text>
        <View style={styles.headerSpacer} />
        <TouchableOpacity
          onPress={handleOpenGroupRide}
          accessibilityRole="button"
          accessibilityLabel={translate("Open group ride")}
          style={styles.groupRideToggle}
        >
          <Icon name="account-group" size={20} color={ACCENT} />
        </TouchableOpacity>
        <VoiceMuteToggle />
      </View>

      {startError ? (
        <View style={styles.warningBanner}>
          <Icon name="cloud-off-outline" size={16} color={QUALITY_COLORS[1]} />
          <Text style={styles.warningText}>{startError}</Text>
        </View>
      ) : null}

      {activeBike ? (
        <View
          style={styles.bikeChip}
          accessibilityLabel={translate("Active bike {value0} {value1}", {
            value0: activeBike.make,
            value1: activeBike.model,
          })}
        >
          <Icon name="motorbike" size={16} color={t.dim} />
          <Text style={styles.bikeChipText} numberOfLines={1}>
            {`${activeBike.make} ${activeBike.model}`.trim()}
          </Text>
        </View>
      ) : null}

      <View
        style={styles.speedBlock}
        accessibilityLabel={translate("Speed {value0}", { value0: speedLabel })}
      >
        {speedDisplay.unitPosition === "before" ? (
          <Text style={styles.speedUnit}>{speedDisplay.unit}</Text>
        ) : null}
        <Text style={styles.speedValue}>{speedDisplay.value}</Text>
        {speedDisplay.unitPosition === "after" ? (
          <Text style={styles.speedUnit}>{speedDisplay.unit}</Text>
        ) : null}
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statBlock}>
          <Text style={styles.statLabel}>{translate("Distance")}</Text>
          <Text style={styles.statValue}>{distanceLabel}</Text>
        </View>
        <View style={styles.statBlock}>
          <Text style={styles.statLabel}>{translate("Duration")}</Text>
          <Text style={styles.statValue}>{durationLabel}</Text>
        </View>
      </View>

      <View
        style={[styles.qualityCard, { borderColor: qColor }]}
        accessibilityLabel={translate("Road quality {value0}", {
          value0: qLabel,
        })}
      >
        <View
          style={[
            styles.qualityIconWrap,
            { backgroundColor: hasQuality ? qColor + "22" : t.raised2 },
          ]}
        >
          <Icon
            name={surfaceIcon(surface ?? "unknown")}
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
              {translate("Waiting for the first reading…")}
            </Text>
          )}
        </View>
      </View>

      <View style={styles.leanRow}>
        <View style={styles.leanBlock}>
          <Text style={styles.leanLabel}>{translate("MAX LEAN")}</Text>
          <Text style={styles.leanValue}>
            {leanCalibrating
              ? "—"
              : translate("{value0}°", { value0: Math.round(maxLeanDeg) })}
          </Text>
          <Text style={styles.leanHint}>
            {leanCalibrating
              ? translate("Calibrating — keep the bike upright")
              : translate("Sit upright and tap to re-zero")}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.calibrateBtn}
          onPress={handleRecalibrateLean}
          accessibilityRole="button"
          accessibilityLabel={translate("Recalibrate lean angle")}
        >
          <Icon name="crosshairs-gps" size={18} color={ACCENT} />
          <Text style={styles.calibrateBtnLabel}>{translate("Calibrate")}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.segmentRow}>
        <Icon name="counter" size={18} color={t.mute} />
        <Text style={styles.segmentText}>
          {translate(
            "{count, plural, one {# segment recorded} other {# segments recorded}}",
            { count: segmentCount },
          )}
        </Text>
      </View>

      <View style={styles.stopBtnSpacer} />

      <TouchableOpacity
        style={styles.stopBtn}
        onPress={confirmStop}
        accessibilityRole="button"
        accessibilityLabel={translate("Stop ride")}
        disabled={isStopping}
      >
        <Icon name="stop-circle" size={22} color={t.fg} />
        <Text style={styles.stopLabel}>
          {isStopping ? translate("Stopping…") : translate("Stop ride")}
        </Text>
      </TouchableOpacity>

      <HazardReportFab
        onOpenReport={handleOpenReport}
        style={styles.hazardFab}
      />

      {/* Surface tagging only records inside an active sensor session, so hide
          the FAB when `sys_accel_collection` kept the sensors off — otherwise
          a tap would confirm (haptic) a tag the service silently discards. */}
      {sensorSessionActive && (
        <SurfaceTagFab onTag={handleTagSurface} style={styles.surfaceTagFab} />
      )}
    </View>
  );
}

function VoiceMuteToggle() {
  const translate = useTranslation();
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
        muted
          ? translate("Unmute voice guidance")
          : translate("Mute voice guidance")
      }
      accessibilityState={{ selected: muted }}
      style={styles.voiceToggle}
    >
      <Icon
        name={muted ? "volume-off" : "volume-high"}
        size={20}
        color={muted ? t.mute : ACCENT}
      />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: t.bg,
    padding: brandSpacing.s5,
    gap: brandSpacing.s4,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    paddingTop: brandSpacing.s3,
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
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
  },
  groupRideToggle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
  },
  headerLabel: {
    color: RECORDING_RED,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
  },
  warningBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    padding: brandSpacing.s3,
    borderRadius: brandRadii.md,
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: QUALITY_COLORS[1],
  },
  warningText: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    flex: 1,
  },
  bikeChip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: brandSpacing.s1,
    paddingHorizontal: brandSpacing.s3,
    paddingVertical: brandSpacing.s1,
    borderRadius: brandRadii.lg,
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
  },
  bikeChipText: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "600",
    maxWidth: 240,
  },
  speedBlock: {
    alignItems: "center",
    paddingVertical: brandSpacing.s4,
  },
  speedValue: {
    color: t.fg,
    fontFamily: brandFonts.mono,
    fontSize: 120,
    fontWeight: "800",
    lineHeight: 130,
  },
  speedUnit: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 18,
    fontWeight: "600",
    letterSpacing: 1,
  },
  statsRow: {
    flexDirection: "row",
    gap: brandSpacing.s3,
  },
  statBlock: {
    flex: 1,
    backgroundColor: t.raised,
    borderRadius: brandRadii.lg,
    padding: brandSpacing.s4,
    borderWidth: 1,
    borderColor: t.line,
  },
  statLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  statValue: {
    color: t.fg,
    fontFamily: brandFonts.mono,
    fontSize: 24,
    fontWeight: "700",
    marginTop: brandSpacing.s1,
  },
  qualityCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
    padding: brandSpacing.s4,
    borderRadius: brandRadii.lg,
    backgroundColor: t.raised,
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
    fontFamily: brandFonts.sans,
    fontSize: 18,
    fontWeight: "700",
  },
  qualitySurface: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  leanRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
    padding: brandSpacing.s4,
    borderRadius: brandRadii.lg,
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
  },
  leanBlock: {
    flex: 1,
    gap: 2,
  },
  leanLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.6,
  },
  leanValue: {
    color: t.fg,
    fontFamily: brandFonts.mono,
    fontSize: 24,
    fontWeight: "700",
  },
  leanHint: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  calibrateBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s1,
    minHeight: 44,
    paddingVertical: brandSpacing.s2,
    paddingHorizontal: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    borderWidth: 1,
    borderColor: ACCENT,
    backgroundColor: t.raised,
  },
  calibrateBtnLabel: {
    color: ACCENT,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "700",
  },
  segmentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
  },
  segmentText: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "500",
  },
  stopBtnSpacer: {
    flex: 1,
  },
  stopBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: brandSpacing.s2,
    minHeight: 48,
    paddingVertical: brandSpacing.s4,
    borderRadius: brandRadii.pill,
    backgroundColor: statusFg.danger,
    // The deep danger fill keeps the cream label readable (~6:1) but only
    // reaches ~2.86:1 against the night background, so the destructive pill
    // would recede on the dark HUD. A brighter Q1-red ring delineates the
    // control shape (~5.9:1 on the night surface).
    borderWidth: 2,
    borderColor: QUALITY_COLORS[0],
  },
  stopLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  hazardFab: {
    position: "absolute",
    right: brandSpacing.s4,
    // Sit above the Stop-ride pill so a long-press on the FAB doesn't
    // overlap the destructive Stop-ride hitbox.
    bottom: brandSpacing.s10 + brandSpacing.s4,
  },
  // Research issue #7 — second FAB stacked above the hazard FAB so
  // both are reachable with a thumb on a handlebar mount. Using a
  // 60+s3 offset matches the FAB diameter (60) plus the gap we want
  // between the two pills.
  surfaceTagFab: {
    position: "absolute",
    right: brandSpacing.s4,
    bottom: brandSpacing.s10 + brandSpacing.s4 + 60 + brandSpacing.s3,
  },
});
