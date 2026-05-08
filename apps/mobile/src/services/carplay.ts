/**
 * Vehicle ride-status board — US-17 AC #3.
 *
 * Mirrors the active ride from `useRideStore` onto the connected head
 * unit so the rider sees current speed, distance, duration, and surface
 * classification while their phone is in the pocket. Backed by Apple
 * CarPlay on iOS and Android Auto on Android, fronted by a single
 * platform-agnostic API the calling hook (`useCarPlayRideMirror`) drives
 * regardless of which head unit the rider plugs in.
 *
 * Why two native templates from one module:
 *
 *   - On iOS, CarPlay's `CPInformationTemplate` is the right surface for
 *     a four-row stats panel. The package exposes it as
 *     `InformationTemplate` and supports incremental item updates via
 *     `updateInformationTemplateItems` so we don't flicker the bike
 *     display every tick.
 *   - On Android, the Jetpack `androidx.car.app.model.PaneTemplate` is
 *     the equivalent — same shape (title + rows), but the package's
 *     `InformationTemplate` has no Android template parser case (see
 *     `node_modules/react-native-carplay/android/.../TemplateParser.kt`),
 *     so on Android we synthesize the same content into a `PaneTemplate`
 *     and refresh it via the base-class `updateTemplate` call.
 *
 * Why the bridge module rather than calling `react-native-carplay`
 * directly from the hook:
 *
 *   1. The CarPlay singleton in `react-native-carplay` runs its
 *      constructor on import — it grabs `NativeModules.RNCarPlay` and
 *      starts a `NativeEventEmitter` that crashes in Jest and on
 *      platforms without the native binding. A guarded require in this
 *      module keeps the rest of the app importable.
 *   2. Hardware testing requires Apple-issued entitlements (CarPlay)
 *      and an actual Android Auto host or Desktop Head Unit (DHU). We
 *      can't validate the live bridge in CI. Hiding the bridge behind
 *      an interface lets us inject a fake in tests and assert the
 *      template lifecycle without touching native code.
 *   3. Formatting (km/h, surface labels, duration) is shared between
 *      the head-unit template and the on-phone HUD — keeping it pure
 *      avoids drift across surfaces.
 *
 * Voice-trigger to start a hazard report (US-17 AC #5) lives outside
 * this module — see `android/app/src/main/res/xml/shortcuts.xml` and
 * the `MapTab > HazardReport` linking entry in
 * `navigation/RootNavigator.tsx` (#343). The Google Assistant
 * capability fires a `tarmoto://hazard/report?preselectedType=<type>`
 * deep link aimed at MainActivity, which routes through React
 * Navigation's linking config rather than the CarPlay/AA template
 * surface — the head unit's voice model is the entry point, not the
 * Pane/Map template.
 */

import { Platform } from "react-native";
import { formatDurationSeconds, qualityLabel } from "@/theme";

// ── Public types ──

/**
 * Snapshot of the ride state we mirror to the head unit. Pure data so
 * tests can assert template content without standing up the Zustand
 * store or native bridge.
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

/**
 * One row on the head-unit status board. Maps 1:1 to a CarPlay
 * `InformationItem` (title/detail) and a Jetpack `Row` (title/text).
 */
export interface StatusBoardItem {
  title: string;
  detail: string;
}

/**
 * Minimal slice of the underlying native bridge needed by this module.
 * Defining it locally rather than importing the package's class types
 * means the test fake doesn't have to construct real native templates,
 * which would re-trigger the singleton import side effects.
 *
 * The implementation chosen at runtime is platform-aware:
 *
 *   - iOS uses `CPInformationTemplate` via the package's
 *     `InformationTemplate` class.
 *   - Android uses `PaneTemplate` (Jetpack PaneTemplate), refreshed via
 *     the base-class `updateTemplate` call rather than per-item updates.
 *
 * Both implementations are interchangeable behind this interface, so
 * the controller below doesn't need to branch on platform.
 */
export interface VehicleStatusBridge {
  isAvailable(): boolean;
  mountStatusBoard(config: { title: string; items: StatusBoardItem[] }): void;
  updateStatusBoard(items: StatusBoardItem[]): void;
  clearStatusBoard(): void;
  /**
   * Subscribe to head-unit disconnect events.
   *
   * When the bike head unit disconnects mid-ride, the native template
   * scene is destroyed — any subsequent update would target a vanished
   * template and the rider would see a blank display until the ride
   * ends. The controller uses this hook to clear its mount-tracking
   * flags so the next ride-tick after a reconnect re-mounts cleanly.
   *
   * Returns an unsubscribe function for symmetry with the package API;
   * the no-op bridge returns a no-op unsubscriber.
   */
  subscribeDisconnect(callback: () => void): () => void;
  /**
   * Subscribe to head-unit connect events.
   *
   * Android Auto's lifecycle does not reliably emit a disconnect event
   * when the rider unplugs the head unit (the package's
   * `CarPlaySession.onDestroy` is a no-op), but every fresh connection
   * fires `didConnect`. Watching the connect side too lets the
   * controller treat a reconnect as "discard local mount state, the
   * previous template is gone" — guaranteeing the next ride-tick
   * re-issues `setRootTemplate` instead of trying to update an
   * orphaned template id.
   */
  subscribeConnect(callback: () => void): () => void;
}

// ── Pure formatters ──

/**
 * Render the rider's current speed for the head-unit row. Sub-1 km/h
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
 * `formatDurationSeconds` in `@/theme` so the head-unit board and the
 * on-phone HUD always render durations the same way.
 */
export function formatDuration(totalSeconds: number): string {
  return formatDurationSeconds(totalSeconds);
}

/**
 * Human-readable label for the ride type — used as the head-unit
 * template title. Capitalised for the larger CarPlay/AA typography.
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
 * Build the four-row item list for the head-unit status board. Pure on
 * the inputs so tests can lock in the shape without touching the bridge.
 */
export function buildRideStatusItems(
  board: RideStatusBoard,
): StatusBoardItem[] {
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

/** Stable id so iOS / Android can find the same template across updates. */
const STATUS_TEMPLATE_ID = "tarmoto-vehicle-status-board";

type CarPlayLib = typeof import("react-native-carplay");

/**
 * Build the default `VehicleStatusBridge` backed by `react-native-carplay`.
 *
 * iOS uses the package's `InformationTemplate`; Android uses
 * `PaneTemplate` (the Jetpack equivalent). Other platforms (web, Jest
 * via the `react-native` mock) get a no-op bridge so the calling hook
 * can be installed unconditionally without platform guards.
 *
 * The require is wrapped in try/catch because the package's CarPlay
 * singleton instantiates a `NativeEventEmitter` on import, which throws
 * when the native module isn't linked (e.g. before a fresh
 * `pod install` on iOS or before the Android side autolinks the
 * library). A throw here would crash the whole RootNavigator render —
 * much better to silently degrade to no-op and surface the
 * misconfiguration via native logs that a platform dev can see in
 * Xcode / Logcat.
 */
export function createDefaultCarPlayBridge(): VehicleStatusBridge {
  if (Platform.OS === "ios") return createIosBridge();
  if (Platform.OS === "android") return createAndroidBridge();
  return createNoopBridge();
}

function createIosBridge(): VehicleStatusBridge {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const lib = require("react-native-carplay") as CarPlayLib;
    /* eslint-enable @typescript-eslint/no-require-imports */
    const { CarPlay, InformationTemplate } = lib;

    let template: InstanceType<typeof InformationTemplate> | null = null;

    return {
      isAvailable: () => CarPlay.connected,
      mountStatusBoard: ({ title, items }) => {
        template = new InformationTemplate({
          id: STATUS_TEMPLATE_ID,
          title,
          items,
          actions: [],
          onActionButtonPressed: () => undefined,
        });
        CarPlay.setRootTemplate(template, false);
      },
      updateStatusBoard: (items) => {
        if (!template) return;
        template.updateInformationTemplateItems(items);
      },
      clearStatusBoard: () => {
        if (!template) return;
        try {
          // CarPlay always shows a root template once one has been set;
          // there's no public "remove root" call. Replace with a minimal
          // idle template so the bike display stops showing the stale
          // ride board (last speed / distance frozen at ride end). The
          // next ride re-mounts the live board on top.
          const idle = new InformationTemplate({
            title: "Tarmoto",
            items: [],
            actions: [],
            onActionButtonPressed: () => undefined,
          });
          CarPlay.setRootTemplate(idle, false);
        } catch {
          // Native side may already have torn down (CarPlay disconnect
          // racing the unmount), in which case there's nothing to
          // clear — the disconnect handler already reset our flags.
        }
        template = null;
      },
      subscribeDisconnect: (callback) => {
        const handler = () => {
          template = null;
          callback();
        };
        CarPlay.registerOnDisconnect(handler);
        return () => CarPlay.unregisterOnDisconnect(handler);
      },
      subscribeConnect: (callback) => {
        const handler = () => {
          // Same intent as disconnect: a fresh connection means the
          // previous native template is gone. Reset local state so the
          // controller re-mounts on the next ride-tick.
          template = null;
          callback();
        };
        CarPlay.registerOnConnect(handler);
        return () => CarPlay.unregisterOnConnect(handler);
      },
    };
  } catch {
    return createNoopBridge();
  }
}

function createAndroidBridge(): VehicleStatusBridge {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const lib = require("react-native-carplay") as CarPlayLib;
    /* eslint-enable @typescript-eslint/no-require-imports */
    const { CarPlay, PaneTemplate } = lib;

    let template: InstanceType<typeof PaneTemplate> | null = null;
    let mountedTitle: string | null = null;

    const buildPane = (items: StatusBoardItem[]) => ({
      // The Android `parseRowItem` reads `text` (title) + `detailText`
      // (subtitle) — matching the iOS InformationItem shape would put
      // our values on the wrong row, so we map at the boundary.
      items: items.map((item, index) => ({
        id: `status-row-${index}`,
        text: item.title,
        detailText: item.detail,
      })),
    });

    return {
      isAvailable: () => CarPlay.connected,
      mountStatusBoard: ({ title, items }) => {
        template = new PaneTemplate({
          id: STATUS_TEMPLATE_ID,
          title,
          pane: buildPane(items),
        });
        mountedTitle = title;
        CarPlay.setRootTemplate(template, false);
      },
      updateStatusBoard: (items) => {
        if (!template) return;
        // PaneTemplate has no per-row update API on the package
        // surface; the base-class `updateTemplate` re-pushes the full
        // config, which the Android module forwards to the existing
        // screen via `screen.invalidate()` — no flicker, no re-mount.
        template.updateTemplate({
          title: mountedTitle ?? "Tarmoto",
          pane: buildPane(items),
        });
      },
      clearStatusBoard: () => {
        if (!template) return;
        try {
          const idle = new PaneTemplate({
            title: "Tarmoto",
            pane: { items: [] },
          });
          CarPlay.setRootTemplate(idle, false);
        } catch {
          // AA host may have torn down the screen manager already.
        }
        template = null;
        mountedTitle = null;
      },
      subscribeDisconnect: (callback) => {
        const handler = () => {
          template = null;
          mountedTitle = null;
          callback();
        };
        CarPlay.registerOnDisconnect(handler);
        return () => CarPlay.unregisterOnDisconnect(handler);
      },
      subscribeConnect: (callback) => {
        const handler = () => {
          template = null;
          mountedTitle = null;
          callback();
        };
        CarPlay.registerOnConnect(handler);
        return () => CarPlay.unregisterOnConnect(handler);
      },
    };
  } catch {
    return createNoopBridge();
  }
}

function createNoopBridge(): VehicleStatusBridge {
  return {
    isAvailable: () => false,
    mountStatusBoard: () => undefined,
    updateStatusBoard: () => undefined,
    clearStatusBoard: () => undefined,
    subscribeDisconnect: () => () => undefined,
    subscribeConnect: () => () => undefined,
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
let activeBridge: VehicleStatusBridge | null = null;
let templateMounted = false;
let rideStatusSuspended = false;
/**
 * Remember the title that's currently on-screen so a ride-type change
 * mid-mount remounts the template (setRootTemplate replaces the root and
 * picks up the new title) instead of pushing items-only updates that
 * would leave the old title stale.
 */
let mountedTitle: string | null = null;

function getBridge(): VehicleStatusBridge {
  if (!activeBridge) {
    activeBridge = createDefaultCarPlayBridge();
    attachLifecycleHandlers(activeBridge);
  }
  return activeBridge;
}

/**
 * Reset mount-tracking flags whenever the head unit's connection
 * lifecycle resets the native template scene — disconnect destroys the
 * scene, and on Android Auto a fresh connect after a host restart can
 * also drop the previous template id from the host's screen manager.
 * Watching both ensures the next ride-tick re-issues
 * `setRootTemplate` instead of trying to push items to a vanished
 * template.
 *
 * Called once when the lazy bridge is first resolved (and re-armed by
 * `__setCarPlayBridgeForTest` so injected fakes can simulate the
 * lifecycle paths the same way).
 */
function attachLifecycleHandlers(bridge: VehicleStatusBridge): void {
  const reset = () => {
    templateMounted = false;
    mountedTitle = null;
  };
  bridge.subscribeDisconnect(reset);
  bridge.subscribeConnect(reset);
}

/**
 * Mount the head-unit information board for the current ride and seed
 * it with the rider's first stats snapshot. Idempotent — if the
 * template is already mounted (e.g. the rider backgrounded and
 * re-foregrounded the app), the call falls through to an items update
 * so the bike display never blanks while we re-mount. If the rider's
 * ride type changed (different title), we re-issue `mountStatusBoard`
 * so the title refreshes too.
 *
 * Returns `true` when the bridge accepted the request, or `false` when
 * the head unit isn't reachable (no connection, missing native module,
 * Jest) — callers can use this to short-circuit subsequent ticks.
 */
export function mountRideStatusBoard(board: RideStatusBoard): boolean {
  const bridge = getBridge();
  if (rideStatusSuspended) return false;
  // Skip the native round-trip when no head unit is connected — saves
  // bridge traffic on every ride-store tick while the rider's phone
  // sits unmounted, and keeps the iOS / Android / no-op paths
  // symmetric.
  if (!bridge.isAvailable()) return false;

  const items = buildRideStatusItems(board);
  const title = formatRideTypeTitle(board.rideType);

  if (templateMounted && title === mountedTitle) {
    bridge.updateStatusBoard(items);
    return true;
  }

  // Fresh mount, or ride-type changed — `mountStatusBoard` replaces the
  // current root template (documented contract of the package on both
  // platforms), so this handles both the first-mount and title-change
  // paths.
  bridge.mountStatusBoard({ title, items });
  templateMounted = true;
  mountedTitle = title;
  return true;
}

/**
 * Tear down the template at the end of a ride. Idempotent so a stop
 * dispatched while the template was never mounted (offline, no head
 * unit connected) is safe.
 */
export function unmountRideStatusBoard(): void {
  if (!templateMounted) return;
  const bridge = getBridge();
  // Even if the head unit disconnected mid-ride we still drop our local
  // state so the next ride mounts cleanly; the bridge is allowed to
  // no-op on its side when `isAvailable` is false.
  if (bridge.isAvailable()) bridge.clearStatusBoard();
  templateMounted = false;
  mountedTitle = null;
}

// ── Test seam ──

/**
 * Replace the bridge with a fake (or `null` to reset to the lazy
 * default). Tests should pair this with `__resetCarPlayStateForTest`
 * between cases so the `templateMounted` flag doesn't bleed across.
 */
export function __setCarPlayBridgeForTest(
  bridge: VehicleStatusBridge | null,
): void {
  activeBridge = bridge;
  templateMounted = false;
  mountedTitle = null;
  // Re-arm the lifecycle handlers against the new fake so tests can
  // exercise the reconnect-after-disconnect path through the same
  // contract the production bridge uses.
  if (bridge) attachLifecycleHandlers(bridge);
}

/**
 * Force-reset the mount flag without touching the bridge — useful when
 * a test wants to assert mount-vs-update behavior twice in the same
 * case.
 */
export function __resetCarPlayStateForTest(): void {
  templateMounted = false;
  mountedTitle = null;
  rideStatusSuspended = false;
}

/**
 * Temporarily suppress ride-board mounts while another head-unit
 * surface owns the display (e.g. the full navigation map). The board
 * state is reset so the next post-resume mount re-issues the root
 * template instead of trying to update an off-screen template.
 */
export function suspendRideStatusBoard(): void {
  rideStatusSuspended = true;
  templateMounted = false;
  mountedTitle = null;
}

/**
 * Re-enable ride-board mounts after a different head-unit surface
 * yields control back to the root status board.
 */
export function resumeRideStatusBoard(): void {
  rideStatusSuspended = false;
  templateMounted = false;
  mountedTitle = null;
}

// ── Vehicle audio presence ──

/**
 * Subscribe to head-unit connection state for downstream consumers
 * (e.g. the TTS adapter) that need to know when an external surface is
 * presenting nav prompts. Fires immediately with the current state so
 * the caller doesn't have to poll on mount, and again on every connect
 * / disconnect event from the underlying bridge.
 *
 * Returns an unsubscribe function. Safe to call before the bridge has
 * been resolved — the lazy require runs as a side effect of the first
 * `getBridge()` call.
 *
 * Used by `useNavigationSession` (US-16) to pause local TTS while
 * CarPlay or Android Auto is the active prompt surface, so the rider
 * doesn't hear every cue twice (#498).
 */
export function subscribeVehicleAudioPresence(
  callback: (active: boolean) => void,
): () => void {
  const bridge = getBridge();
  // Fire once with the current state so a caller that mounts after a
  // connect event has already happened still sees the truth without
  // needing its own poll.
  callback(bridge.isAvailable());
  const offConnect = bridge.subscribeConnect(() => callback(true));
  const offDisconnect = bridge.subscribeDisconnect(() => callback(false));
  return () => {
    offConnect();
    offDisconnect();
  };
}

// ── Backwards-compatible aliases ──

/**
 * @deprecated Use `VehicleStatusBridge`. Kept as an alias because
 * older test fakes referenced the iOS-leaning name; will be removed
 * in a follow-up sweep.
 */
export type CarPlayBridge = VehicleStatusBridge;

/**
 * @deprecated Use `StatusBoardItem`.
 */
export type InformationTemplateItem = StatusBoardItem;
