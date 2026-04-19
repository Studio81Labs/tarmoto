/**
 * CarPlay bridge — US-17 AC #3 "Basic ride stats visible".
 *
 * Mirrors the active ride from `useRideStore` onto the CarPlay information
 * template so the rider sees current speed, distance, duration, and surface
 * classification on the bike's display while their phone is mounted in the
 * pocket. The template is the simplest CarPlay surface that satisfies the
 * AC — a richer map-template overlay (US-17 AC #1) and the maneuver pane
 * for turn-by-turn (US-17 AC #2 / US-16) are separate slices.
 *
 * Why a service module rather than calling react-native-carplay directly
 * from the hook:
 *
 *   1. The CarPlay singleton in `react-native-carplay` runs its constructor
 *      on import — it grabs `NativeModules.RNCarPlay` and starts a
 *      `NativeEventEmitter` that crashes in Jest and on platforms without
 *      the native binding (Android in this slice). Lazy + guarded
 *      require keeps the rest of the app importable.
 *
 *   2. The CarPlay scene only exists on iOS hardware and needs Apple-issued
 *      entitlements; we can't validate the live bridge in CI. Pulling the
 *      bridge behind an interface lets us inject a fake in tests and
 *      assert the template lifecycle without ever touching native code.
 *
 *   3. Formatting (m/s vs km/h, surface labels, duration) is shared with
 *      the on-phone HUD eventually — keeping it in one pure module avoids
 *      drift between what the rider sees on the bike display and what
 *      they'd see on the phone.
 *
 * Non-goals for this slice:
 *   - Android Auto template parity (separate native module surface in
 *     react-native-carplay; will land as a follow-up slice of US-17).
 *   - CarPlay map / navigation templates (US-17 AC #1, #2).
 *   - Voice control for hazard reporting (US-17 AC #4).
 */

import { Platform } from "react-native";
import { formatDurationSeconds, qualityLabel } from "@/theme";

// ── Public types ──

/**
 * Snapshot of the ride state we mirror to CarPlay. Pure data so tests can
 * assert template content without standing up the Zustand store.
 */
export interface RideStatusBoard {
  /** Speed in km/h, as stored by the ride store. Negative is treated as 0. */
  speedKmh: number;
  /** Distance ridden so far, in km. */
  distanceKm: number;
  /** Duration of the active ride, in seconds. */
  durationSeconds: number;
  /** Latest surface-classification quality score (1-5), or null pre-first window. */
  qualityScore: number | null;
  /** Latest surface-classification confidence (0-1), or null pre-first window. */
  qualityConfidence: number | null;
  /** Active ride type — used for the template title. */
  rideType: "free" | "commute" | "trip";
}

export interface InformationTemplateItem {
  title: string;
  detail: string;
}

/**
 * Minimal slice of the react-native-carplay surface this module needs.
 * Defining it locally rather than importing the package's class types means
 * the test fake doesn't have to construct real `InformationTemplate`
 * instances (which would re-trigger the singleton import side effects).
 */
export interface CarPlayBridge {
  isAvailable(): boolean;
  setRootInformationTemplate(config: {
    title: string;
    items: InformationTemplateItem[];
  }): void;
  updateInformationTemplateItems(items: InformationTemplateItem[]): void;
  clearRootTemplate(): void;
}

// ── Pure formatters ──

/**
 * Render the rider's current speed for the CarPlay row. Sub-1 km/h
 * (i.e. stationary GPS noise) collapses to "—" so the bike display
 * doesn't strobe "0/1/0/1 km/h" while waiting at a light.
 */
export function formatSpeedKmh(kmh: number): string {
  if (!Number.isFinite(kmh) || kmh < 1) return "—";
  return `${Math.round(kmh)} km/h`;
}

/**
 * Distance covered. Below 1 km we show one decimal so an early-ride
 * rider sees the counter ticking; above 1 km we still keep one decimal
 * (the ride store updates frequently enough that integer km would feel
 * stuck for minutes at cruising speed).
 */
export function formatDistanceKm(km: number): string {
  if (!Number.isFinite(km) || km <= 0) return "0.0 km";
  return `${km.toFixed(1)} km`;
}

/**
 * mm:ss for short rides, h:mm:ss past the hour mark. Thin delegate to
 * `formatDurationSeconds` in `@/theme` so the CarPlay board and the
 * on-phone HUD always render durations the same way — see that helper
 * for the NaN / negative / sub-second edge cases.
 */
export function formatDuration(totalSeconds: number): string {
  return formatDurationSeconds(totalSeconds);
}

/**
 * Human-readable label for the ride type — used as the CarPlay template
 * title. Capitalised for the larger CarPlay typography.
 */
export function formatRideTypeTitle(
  rideType: RideStatusBoard["rideType"],
): string {
  switch (rideType) {
    case "commute":
      return "Commute";
    case "trip":
      return "Trip";
    default:
      return "Free ride";
  }
}

/**
 * Surface row content. We deliberately avoid showing a numeric score on
 * its own — at a glance from the bike, "Good · 92% conf" is more useful
 * than "3.7". When the classifier hasn't produced a window yet we say so
 * explicitly rather than rendering a misleading "Very Poor" default.
 */
export function formatQualityDetail(
  score: number | null,
  confidence: number | null,
): string {
  if (score == null) return "Reading surface…";
  const label = Number.isFinite(score) ? qualityLabel(score) : "Unknown";
  if (confidence == null || !Number.isFinite(confidence)) return label;
  const pct = Math.round(Math.max(0, Math.min(1, confidence)) * 100);
  return `${label} · ${pct}% conf`;
}

/**
 * Build the four-row item list for the CarPlay information template.
 * Pure on the inputs so tests can lock in the shape without touching
 * the bridge.
 */
export function buildRideStatusItems(
  board: RideStatusBoard,
): InformationTemplateItem[] {
  return [
    { title: "Speed", detail: formatSpeedKmh(board.speedKmh) },
    { title: "Distance", detail: formatDistanceKm(board.distanceKm) },
    { title: "Duration", detail: formatDuration(board.durationSeconds) },
    {
      title: "Surface",
      detail: formatQualityDetail(board.qualityScore, board.qualityConfidence),
    },
  ];
}

// ── Bridge resolution ──

/**
 * Build the default `CarPlayBridge` backed by `react-native-carplay`.
 *
 * iOS-only: returns a no-op bridge on every other platform (Android, Jest
 * via `react-native`'s `Platform` mock). The require is wrapped in
 * try/catch because the package's CarPlay singleton instantiates a
 * `NativeEventEmitter` on import, which throws when the native module
 * isn't linked (e.g. during a fresh install before a `pod install`).
 * A throw here would crash the whole RootNavigator render — much better
 * to silently degrade to no-op and surface the misconfiguration via
 * logs that an iOS dev can see in Xcode.
 */
export function createDefaultCarPlayBridge(): CarPlayBridge {
  if (Platform.OS !== "ios") return createNoopBridge();

  try {
    // Lazy require so the singleton's `new NativeEventEmitter(RNCarPlay)`
    // runs only on iOS at runtime — never in Jest, never on Android.
    /* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
    const carplayModule =
      require("react-native-carplay") as typeof import("react-native-carplay");
    const { CarPlay, InformationTemplate } = carplayModule;
    /* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

    let template: InstanceType<typeof InformationTemplate> | null = null;

    return {
      isAvailable: () => CarPlay.connected,
      setRootInformationTemplate: ({ title, items }) => {
        template = new InformationTemplate({
          title,
          items,
          actions: [],
          // CarPlay always passes us a callback signature; we don't
          // expose actions yet, so the handler is a no-op. A future
          // slice (voice-control, end-ride) will wire it.
          onActionButtonPressed: () => undefined,
        });
        CarPlay.setRootTemplate(template, false);
      },
      updateInformationTemplateItems: (items) => {
        if (!template) return;
        template.updateInformationTemplateItems(items);
      },
      clearRootTemplate: () => {
        if (!template) return;
        // We deliberately don't call into native to "release" the
        // template here. The package's documented public surface
        // (setRootTemplate / pushTemplate / popTemplate) doesn't expose
        // a stable "destroy template" call, and the next ride's mount
        // will overwrite the root via `setRootTemplate(newTemplate,
        // false)` — that's the documented way to replace the current
        // root. Dropping the JS reference is enough on our side; the
        // previous template object becomes unreachable and the native
        // scene is replaced when the rider starts another ride.
        template = null;
      },
    };
  } catch {
    return createNoopBridge();
  }
}

function createNoopBridge(): CarPlayBridge {
  return {
    isAvailable: () => false,
    setRootInformationTemplate: () => undefined,
    updateInformationTemplateItems: () => undefined,
    clearRootTemplate: () => undefined,
  };
}

// ── Module-scoped controller ──

/**
 * The mounted-template flag lives at module scope (not inside the bridge
 * fake) so a hook can mount/update/unmount across renders without
 * threading a handle through React state. The bridge itself is also
 * module-scoped + lazily resolved: tests inject their fake before the
 * hook's first render via `__setCarPlayBridgeForTest`.
 */
let activeBridge: CarPlayBridge | null = null;
let templateMounted = false;
/**
 * Remember the title that's currently on-screen so a ride-type change
 * mid-mount remounts the template (setRootTemplate replaces the root and
 * picks up the new title) instead of pushing items-only updates that
 * would leave the old title stale.
 */
let mountedTitle: string | null = null;

function getBridge(): CarPlayBridge {
  if (!activeBridge) activeBridge = createDefaultCarPlayBridge();
  return activeBridge;
}

/**
 * Mount the CarPlay information template for the current ride and seed
 * it with the rider's first stats snapshot. Idempotent — if the template
 * is already mounted (e.g. the rider backgrounded and re-foregrounded
 * the app), the call falls through to an items update so the bike display
 * never blanks while we re-mount. If the rider's ride type changed
 * (different title), we re-issue `setRootInformationTemplate` so the
 * title refreshes too.
 *
 * Returns `true` when the bridge accepted the request, or `false` when
 * CarPlay isn't reachable (Android, no connection, missing native
 * module) — callers can use this to short-circuit subsequent ticks.
 */
export function mountRideStatusBoard(board: RideStatusBoard): boolean {
  const bridge = getBridge();
  // Skip the native round-trip when CarPlay isn't connected — saves
  // bridge traffic on every ride-store tick while the rider's phone
  // sits unmounted, and keeps the no-op iOS / Android path symmetric.
  if (!bridge.isAvailable()) return false;

  const items = buildRideStatusItems(board);
  const title = formatRideTypeTitle(board.rideType);

  if (templateMounted && title === mountedTitle) {
    bridge.updateInformationTemplateItems(items);
    return true;
  }

  // Fresh mount, or ride-type changed — setRootTemplate replaces the
  // current root (documented contract of the package), so this handles
  // both the first-mount and title-change paths.
  bridge.setRootInformationTemplate({ title, items });
  templateMounted = true;
  mountedTitle = title;
  return true;
}

/**
 * Push a fresh stats snapshot to the already-mounted template. No-op
 * when the template hasn't been mounted yet — that case is the natural
 * order of the ride lifecycle, so callers don't need to gate on it.
 */
export function updateRideStatusBoard(board: RideStatusBoard): void {
  if (!templateMounted) return;
  const bridge = getBridge();
  if (!bridge.isAvailable()) return;
  bridge.updateInformationTemplateItems(buildRideStatusItems(board));
}

/**
 * Tear down the template at the end of a ride. Idempotent so a stop
 * dispatched while the template was never mounted (offline, no CarPlay)
 * is safe.
 */
export function unmountRideStatusBoard(): void {
  if (!templateMounted) return;
  const bridge = getBridge();
  // Even if CarPlay disconnected mid-ride we still drop our local state
  // so the next ride mounts cleanly; the bridge is allowed to no-op on
  // its side when `isAvailable` is false.
  if (bridge.isAvailable()) bridge.clearRootTemplate();
  templateMounted = false;
  mountedTitle = null;
}

// ── Test seam ──

/**
 * Replace the bridge with a fake (or `null` to reset to the lazy
 * default). Tests should pair this with `__resetCarPlayStateForTest`
 * between cases so the `templateMounted` flag doesn't bleed across.
 */
export function __setCarPlayBridgeForTest(bridge: CarPlayBridge | null): void {
  activeBridge = bridge;
  templateMounted = false;
  mountedTitle = null;
}

/**
 * Force-reset the mount flag without touching the bridge — useful when a
 * test wants to assert mount-vs-update behavior twice in the same case.
 */
export function __resetCarPlayStateForTest(): void {
  templateMounted = false;
  mountedTitle = null;
}
