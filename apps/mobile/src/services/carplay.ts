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
import { haversineMeters } from "@tarmoto/shared";
import { formatDurationSeconds, qualityLabel } from "@/theme";
import type { Hazard, HazardType, LatLng } from "@/types";
import { t as translate } from "@/i18n";
import { getFormatters } from "@/format";

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
 * Snapshot of a single hazard projected onto the head-unit alert surface.
 * Pure data so tests can lock in the wording without instantiating a
 * native template.
 */
export interface HazardAlertSnapshot {
  /** Stable hazard id from the backend; drives dedupe across alerts. */
  id: string;
  hazard_type: HazardType;
  /** Distance from the rider's current location to the hazard, in metres. */
  distanceMeters: number;
  /** Optional user-supplied note from the original report. */
  note: string | null;
  /** Road name from the geocoded reverse lookup, when known. */
  roadName: string | null;
}

/** One quick-action row on the CarPlay/AA list template. */
export interface QuickActionItem {
  /** Stable id so the head-unit can dispatch the right callback when tapped. */
  id: "start-commute" | "stop-ride" | "report-hazard";
  text: string;
  detailText: string;
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
  /**
   * Mount a CPAlertTemplate (iOS) / AlertTemplate (Android Auto) for a
   * route hazard. The bridge owns the lifecycle: a fresh
   * `presentHazardAlert` call replaces the previously-presented alert
   * (if any) so the rider sees the closest hazard, never a stack of
   * stale ones queued behind each other on the bike display.
   *
   * Both platforms ship native alert templates via the package — iOS as
   * `AlertTemplate` (CPAlertTemplate), Android via the Jetpack
   * `AlertTemplate`. We wire confirm/dismiss callbacks so the rider can
   * acknowledge or hide the alert with one tap on the head unit.
   */
  presentHazardAlert(
    snapshot: HazardAlertSnapshot,
    callbacks: {
      onConfirm: () => void;
      onDismiss: () => void;
    },
  ): void;
  /** Hide whatever hazard alert is currently mounted; idempotent. */
  dismissHazardAlert(): void;
  /**
   * Mount a CarPlay list / Android Auto pane template that gives the
   * rider one-tap reach for the most common pre-ride / mid-ride
   * actions:
   *
   *   - Start Commute (US-21) — pre-ride, no active ride
   *   - Stop ride — mid-ride, idempotent if no ride is active
   *   - Report hazard — mid-ride, jumps into the SearchTemplate
   *
   * The bridge dispatches `onActionPressed(id)` when the rider taps a
   * row. The controller routes the id back into the right Zustand
   * action / deep link. Idempotent — re-mounting with the same items
   * just refreshes the template instead of re-issuing setRootTemplate.
   */
  mountQuickActions(
    items: QuickActionItem[],
    onActionPressed: (id: QuickActionItem["id"]) => void,
  ): void;
  /** Tear down the quick-actions template, if mounted. Idempotent. */
  unmountQuickActions(): void;
  /**
   * Replace WHATEVER root template is currently on the head unit (ride
   * board, quick-actions list, nav map) with a minimal inert idle template,
   * and dismiss any presented hazard alert. CarPlay/Android Auto keep a root
   * template once one is set — there's no public "remove root" — so an inert
   * root is the closest we can get to "no Tarmoto surface". Used by the
   * `carplay_android_auto` operator kill switch, where merely skipping future
   * mounts would leave the existing interactive surface (and its callbacks)
   * live on the bike display. Idempotent; a no-op when no head unit is
   * connected.
   */
  showInertRoot(): void;
}

// ── Pure formatters ──

/**
 * Render the rider's current speed for the head-unit row. Sub-1 km/h
 * (i.e. stationary GPS noise) collapses to "—" so the bike display
 * doesn't strobe "0/1/0/1 km/h" while waiting at a light.
 */
export function formatSpeedKmh(kmh: number): string {
  if (!Number.isFinite(kmh) || kmh < 1) return "—";
  return getFormatters().speed(kmh);
}

/**
 * Distance covered. Below 1 km we show one decimal so an early-ride
 * rider sees the counter ticking; above 1 km we still keep one decimal
 * (the ride store updates frequently enough that integer km would feel
 * stuck for minutes at cruising speed).
 */
export function formatDistanceKm(km: number): string {
  return getFormatters().distanceKm(!Number.isFinite(km) || km <= 0 ? 0 : km);
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
      return translate("Commute");
    case "trip":
      return translate("Trip");
    default:
      return translate("Free ride");
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
  if (score == null) return translate("Reading surface…");
  const label = Number.isFinite(score)
    ? qualityLabel(score)
    : translate("Unknown");
  if (confidence == null || !Number.isFinite(confidence)) return label;
  const percent = getFormatters().percent(Math.max(0, Math.min(1, confidence)));
  return translate("{label} · {percent} conf", { label, percent });
}

/**
 * Great-circle distance between two `LatLng` points in metres. Thin
 * wrapper over `haversineMeters` from `@tarmoto/shared` so the hazard
 * surface and the rest of the app share one implementation — the
 * shared package's signature is `(lat1, lon1, lat2, lon2)`, this
 * collapses the call sites into the local `LatLng` shape we already
 * thread everywhere else in the mobile app.
 */
export function distanceMetersBetween(a: LatLng, b: LatLng): number {
  return haversineMeters(a.lat, a.lng, b.lat, b.lng);
}

/** Human-readable label for the hazard alert title row. */
export function hazardTypeLabel(type: HazardType): string {
  switch (type) {
    case "pothole":
      return translate("Pothole");
    case "gravel":
      return translate("Loose gravel");
    case "oil_spill":
      return translate("Oil spill");
    case "roadworks":
      return translate("Roadworks");
    case "animals":
      return translate("Animals");
    case "police":
      return translate("Police");
    case "flooding":
      return translate("Flooding");
    case "ice":
      return translate("Ice");
    default:
      return translate("Hazard");
  }
}

/**
 * Distance line for the hazard-alert subtitle. We round to 50 m granularity
 * below 1 km (matching the haptic grain the rider experiences approaching the
 * hazard), then let the active formatter choose metric or imperial units.
 * Off-range / non-finite values collapse to "Nearby" so the rider always gets
 * a complete sentence on the bike display.
 */
export function formatHazardDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return translate("Nearby");
  const displayMeters =
    meters < 1000 ? Math.max(0, Math.round(meters / 50) * 50) : meters;
  if (displayMeters === 0) return translate("Right here");
  return translate("{distance} ahead", {
    distance: getFormatters().distanceM(displayMeters),
  });
}

/**
 * Pick the next hazard to alert the rider about — the one closest to
 * the rider's current location. Returns `null` when there are no
 * candidates or the rider has no fix yet.
 *
 * We deliberately don't filter by route polyline here — the hazard
 * store's `nearbyHazards` slice is already pruned to a sane radius,
 * and over-filtering at this layer would silently drop legitimate
 * cross-traffic alerts (e.g. a hazard 80 m off the route on a tight
 * urban street). The rider can dismiss anything irrelevant on the
 * head unit with one tap.
 */
export function selectClosestHazard(
  hazards: Hazard[],
  riderLocation: LatLng | null,
): { hazard: Hazard; distanceMeters: number } | null {
  if (!riderLocation || hazards.length === 0) return null;
  let best: { hazard: Hazard; distanceMeters: number } | null = null;
  for (const hazard of hazards) {
    const distance = distanceMetersBetween(riderLocation, {
      lat: hazard.lat,
      lng: hazard.lng,
    });
    if (!best || distance < best.distanceMeters) {
      best = { hazard, distanceMeters: distance };
    }
  }
  return best;
}

/**
 * Project the closest hazard into the head-unit alert snapshot. Pure
 * on the inputs so tests can lock in the projection without touching
 * the bridge.
 */
export function buildHazardAlertSnapshot(
  hazard: Hazard,
  distanceMeters: number,
): HazardAlertSnapshot {
  return {
    id: hazard.id,
    hazard_type: hazard.hazard_type,
    distanceMeters,
    note: hazard.note,
    roadName: hazard.road_name,
  };
}

/**
 * Build the quick-actions list shown on the head-unit pre-ride.
 *
 * Quick actions are deliberately pre-ride only — mid-ride the rider's
 * primary head-unit surface is the live ride status board (or the
 * navigation map template), and a quick-actions list-template would
 * call `setRootTemplate` and replace whichever ride surface is
 * currently mounted, leaving the rider stuck on a static menu while
 * the bike display can no longer show speed / next maneuver. The
 * mid-ride affordances (report hazard, stop ride) are reachable from
 * the navigation map template's leading bar buttons / from the phone
 * HUD directly, so this surface focuses on its unique pre-ride job:
 * one-tap launch into the rider's commute (US-17 AC #4 / US-21).
 */
export function buildQuickActionItems(state: {
  isRiding: boolean;
  hasCommuteRoute: boolean;
}): QuickActionItem[] {
  if (state.isRiding) return [];
  if (!state.hasCommuteRoute) return [];
  return [
    {
      id: "start-commute",
      text: translate("Start commute"),
      detailText: translate("Begin your saved route"),
    },
  ];
}

/**
 * Build the four-row item list for the head-unit status board. Pure on
 * the inputs so tests can lock in the shape without touching the bridge.
 */
export function buildRideStatusItems(
  board: RideStatusBoard,
): StatusBoardItem[] {
  return [
    { title: translate("Speed"), detail: formatSpeedKmh(board.speedKmh) },
    {
      title: translate("Distance"),
      detail: formatDistanceKm(board.distanceKm),
    },
    {
      title: translate("Duration"),
      detail: formatDuration(board.durationSeconds),
    },
    {
      title: translate("Surface"),
      detail: formatQualityDetail(board.qualityScore, board.qualityConfidence),
    },
  ];
}

// ── Bridge resolution ──

/** Stable id so iOS / Android can find the same template across updates. */
const STATUS_TEMPLATE_ID = "tarmoto-vehicle-status-board";
const HAZARD_ALERT_TEMPLATE_ID = "tarmoto-vehicle-hazard-alert";
const QUICK_ACTIONS_TEMPLATE_ID = "tarmoto-vehicle-quick-actions";

/**
 * Compose the title + subtitle the alert template renders. Pure on the
 * snapshot so the iOS / Android / test paths share a single source of
 * truth and the bike display can never disagree with what the test
 * suite asserts.
 */
export function formatHazardAlertText(snapshot: HazardAlertSnapshot): {
  title: string;
  subtitle: string;
} {
  const label = hazardTypeLabel(snapshot.hazard_type);
  const distance = formatHazardDistance(snapshot.distanceMeters);
  let subtitle = distance;
  if (snapshot.roadName && snapshot.note) {
    subtitle = translate("{distance} · on {roadName} · {note}", {
      distance,
      roadName: snapshot.roadName,
      note: snapshot.note,
    });
  } else if (snapshot.roadName) {
    subtitle = translate("{distance} · on {roadName}", {
      distance,
      roadName: snapshot.roadName,
    });
  } else if (snapshot.note) {
    subtitle = translate("{distance} · {note}", {
      distance,
      note: snapshot.note,
    });
  }
  return {
    title: label,
    subtitle,
  };
}

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
    const { CarPlay, InformationTemplate, AlertTemplate, ListTemplate } = lib;

    let template: InstanceType<typeof InformationTemplate> | null = null;
    let hazardAlertTemplate: InstanceType<typeof AlertTemplate> | null = null;
    // Quick-actions tracking lives in the module-level controller above
    // the bridge — the bridge just constructs the template and hands it
    // to the host. No need to hold a reference here.

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
            title: translate("Tarmoto"),
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
          hazardAlertTemplate = null;
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
          hazardAlertTemplate = null;
          callback();
        };
        CarPlay.registerOnConnect(handler);
        return () => CarPlay.unregisterOnConnect(handler);
      },
      presentHazardAlert: (snapshot, callbacks) => {
        if (!CarPlay.connected) return;
        // Pop any prior alert before pushing the new one — CarPlay's
        // alert templates stack rather than replace, and a stale
        // pothole alert behind a fresher gravel alert would hide the
        // closer hazard from the rider once they dismissed the new
        // one.
        if (hazardAlertTemplate) {
          try {
            CarPlay.dismissTemplate(true);
          } catch {
            // Ignore — the host may have torn the prior alert down on
            // its own (auto-dismiss timer, scene rebuild). Falling
            // through to construct the fresh one is the safer default.
          }
        }
        const { title, subtitle } = formatHazardAlertText(snapshot);
        const fresh = new AlertTemplate({
          id: HAZARD_ALERT_TEMPLATE_ID,
          // CPAlertTemplate accepts an array of title variants ordered
          // from richest to fallback. Surfacing the full subtitle as
          // the first variant lets the host pick it when the bike
          // display has the screen real estate; smaller cluster
          // displays fall back to the hazard label alone.
          titleVariants: [`${title} — ${subtitle}`, title],
          actions: [
            { id: "confirm", title: translate("Confirm"), style: "default" },
            { id: "dismiss", title: translate("Dismiss"), style: "cancel" },
          ],
          onActionButtonPressed: ({ id }) => {
            if (id === "confirm") callbacks.onConfirm();
            else if (id === "dismiss") callbacks.onDismiss();
          },
        });
        hazardAlertTemplate = fresh;
        try {
          CarPlay.presentTemplate(fresh, true);
        } catch {
          hazardAlertTemplate = null;
        }
      },
      dismissHazardAlert: () => {
        if (!hazardAlertTemplate) return;
        try {
          CarPlay.dismissTemplate(true);
        } catch {
          // Already gone on the native side.
        }
        hazardAlertTemplate = null;
      },
      mountQuickActions: (items, onActionPressed) => {
        if (!CarPlay.connected) return;
        const sections = [
          {
            items: items.map((item) => ({
              id: item.id,
              text: item.text,
              detailText: item.detailText,
            })),
          },
        ];
        const fresh = new ListTemplate({
          id: QUICK_ACTIONS_TEMPLATE_ID,
          title: translate("Tarmoto"),
          sections,
          onItemSelect: async ({ index }) => {
            const picked = items[index];
            if (picked) onActionPressed(picked.id);
          },
        });
        try {
          CarPlay.setRootTemplate(fresh, false);
        } catch {
          // Host already disposed — controller will re-attempt on the
          // next tick when isAvailable() flips back true.
        }
      },
      unmountQuickActions: () => {
        // The list template doesn't have a "pop self" affordance — the
        // controller handles the swap by calling `mountStatusBoard` /
        // `clearStatusBoard` next. No bridge state to clear here.
      },
      showInertRoot: () => {
        if (!CarPlay.connected) return;
        // Drop any hazard alert first so it doesn't sit on top of the idle
        // root, then replace whatever root is showing with the blank idle
        // template — the same idle used by `clearStatusBoard`, but issued
        // unconditionally (quick-actions / nav map are separate roots that
        // `clearStatusBoard` wouldn't touch).
        if (hazardAlertTemplate) {
          try {
            CarPlay.dismissTemplate(true);
          } catch {
            // Host may have torn it down already.
          }
          hazardAlertTemplate = null;
        }
        try {
          const idle = new InformationTemplate({
            title: translate("Tarmoto"),
            items: [],
            actions: [],
            onActionButtonPressed: () => undefined,
          });
          CarPlay.setRootTemplate(idle, false);
        } catch {
          // Native side may have torn down (disconnect racing the kill).
        }
        template = null;
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
    const { CarPlay, PaneTemplate, ListTemplate } = lib;
    // The package's `InternalCarPlay` type definition (in
    // `node_modules/react-native-carplay/src/CarPlay.ts`) declares
    // `alert` but not `dismissAlert`, even though the native Android
    // module (`CarPlayModule.kt:227`) exports it. Until the package's
    // typings catch up, route the dismiss call through this typed
    // shim so we don't sprinkle ad-hoc `as never` casts.
    const androidBridge = CarPlay.bridge as typeof CarPlay.bridge & {
      dismissAlert(alertId: number): void;
    };

    let template: InstanceType<typeof PaneTemplate> | null = null;
    let mountedTitle: string | null = null;
    /**
     * Monotonically-incremented integer id we hand to the AA host's
     * `Alert.Builder` (the host requires a numeric id, not a string).
     * Tracked so `dismissHazardAlert` can target the most recent alert
     * via `CarPlay.bridge.dismissAlert(id)`.
     */
    let activeAndroidAlertId: number | null = null;
    let nextAlertId = 1;
    /** Active alert callbacks routed via `buttonPressed` events. */
    let activeAlertCallbacks: {
      onConfirm: () => void;
      onDismiss: () => void;
    } | null = null;
    /** Subscription to the `buttonPressed` emitter — alive while an alert is mounted. */
    let alertButtonSubscription: { remove: () => void } | null = null;
    /**
     * Active quick-action rows keyed by row id, plus the host callback.
     * Held in a closure so the direct `didSelectListItem` listener can
     * dispatch without re-reading from the package's
     * `ListTemplate.onItemSelect` (which Android drops — see
     * `attachQuickActionsListener` below).
     */
    let activeQuickActions: {
      handler: (id: QuickActionItem["id"]) => void;
      ids: Set<string>;
    } | null = null;
    /** Subscription to the `didSelectListItem` emitter — alive while quick actions are mounted. */
    let quickActionsSubscription: { remove: () => void } | null = null;

    /**
     * Wire the Android-side alert action callbacks. The AA package
     * routes alert-action taps through the global `buttonPressed`
     * event (see `parseAction.setOnClickListener` →
     * `eventEmitter.buttonPressed(id)` in
     * `node_modules/react-native-carplay/android/.../RCTTemplate.kt`),
     * which is the same channel template-toolbar buttons use. We
     * filter on the action ids we registered so taps from other
     * surfaces don't bleed into the alert callbacks.
     *
     * Payload key differs by platform: the iOS `RNCarPlay.m` emits
     * `{ id, templateId }` while the Android `EventEmitter.kt`
     * (`fun buttonPressed(buttonId: String)`) puts the action id
     * under the key `buttonId`. Reading both is defensive — Android
     * is the platform that actually drives this bridge today, but a
     * future package version that normalises the shape will keep
     * working.
     */
    const attachAlertButtonListener = () => {
      detachAlertButtonListener();
      alertButtonSubscription = CarPlay.emitter.addListener(
        "buttonPressed",
        (e: { id?: string; buttonId?: string }) => {
          if (!activeAlertCallbacks) return;
          const actionId = e.buttonId ?? e.id;
          if (actionId === "confirm") activeAlertCallbacks.onConfirm();
          else if (actionId === "dismiss") activeAlertCallbacks.onDismiss();
        },
      );
    };
    const detachAlertButtonListener = () => {
      alertButtonSubscription?.remove();
      alertButtonSubscription = null;
    };

    /**
     * Subscribe to `didSelectListItem` directly on Android because the
     * package's `ListTemplate` JS wrapper filters with
     * `e.templateId === this.id`, but the AA native side
     * (`EventEmitter.kt`'s `fun didSelectListItem(id, index)`) only
     * puts `{ id, index }` on the wire — `templateId` is undefined,
     * so the wrapper drops every Android tap and `onItemSelect` is
     * never called. The direct listener bypasses that filter and
     * dispatches by row id, which `parseRowItem` *does* set to the
     * `id` field we passed when constructing the `ListTemplate`.
     */
    const attachQuickActionsListener = () => {
      detachQuickActionsListener();
      quickActionsSubscription = CarPlay.emitter.addListener(
        "didSelectListItem",
        (e: { id?: string; index?: number; templateId?: string }) => {
          if (!activeQuickActions) return;
          // Some package builds *do* set templateId for AA; if so, scope
          // to ours so a different list template's selection can't
          // bleed in.
          if (
            e.templateId !== undefined &&
            e.templateId !== QUICK_ACTIONS_TEMPLATE_ID
          ) {
            return;
          }
          if (e.id && activeQuickActions.ids.has(e.id)) {
            activeQuickActions.handler(e.id as QuickActionItem["id"]);
          }
        },
      );
    };
    const detachQuickActionsListener = () => {
      quickActionsSubscription?.remove();
      quickActionsSubscription = null;
    };

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
          title: mountedTitle ?? translate("Tarmoto"),
          pane: buildPane(items),
        });
      },
      clearStatusBoard: () => {
        if (!template) return;
        try {
          const idle = new PaneTemplate({
            title: translate("Tarmoto"),
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
          activeAndroidAlertId = null;
          activeAlertCallbacks = null;
          detachAlertButtonListener();
          activeQuickActions = null;
          detachQuickActionsListener();
          mountedTitle = null;
          callback();
        };
        CarPlay.registerOnDisconnect(handler);
        return () => CarPlay.unregisterOnDisconnect(handler);
      },
      subscribeConnect: (callback) => {
        const handler = () => {
          template = null;
          activeAndroidAlertId = null;
          activeAlertCallbacks = null;
          detachAlertButtonListener();
          activeQuickActions = null;
          detachQuickActionsListener();
          mountedTitle = null;
          callback();
        };
        CarPlay.registerOnConnect(handler);
        return () => CarPlay.unregisterOnConnect(handler);
      },
      presentHazardAlert: (snapshot, callbacks) => {
        if (!CarPlay.connected) return;
        // Android Auto's `presentTemplate` is a `// void` no-op in the
        // package's `CarPlayModule` (verified against
        // node_modules/react-native-carplay@2.4.1-beta.0/android/...).
        // The supported AA path is the imperative
        // `CarPlay.bridge.alert({ id, title, duration, actions })`
        // call, which forwards to `AppManager.showAlert` natively.
        // Tap callbacks come back via the global `buttonPressed`
        // event (one channel, all action ids), so we filter the ids
        // we registered.
        if (activeAndroidAlertId !== null) {
          try {
            androidBridge.dismissAlert(activeAndroidAlertId);
          } catch {
            // Host may have already auto-dismissed via timeout.
          }
        }
        const id = nextAlertId++;
        const { title, subtitle } = formatHazardAlertText(snapshot);
        activeAlertCallbacks = callbacks;
        attachAlertButtonListener();
        try {
          CarPlay.bridge.alert({
            id,
            title,
            subtitle,
            // Android requires a positive duration; pick a long
            // window so the rider has time to react without being
            // forced to dismiss instantly. The action callbacks
            // (Confirm / Dismiss) end the alert before the timeout
            // ever fires in practice.
            duration: 30_000,
            actions: [
              { id: "confirm", title: translate("Confirm") },
              { id: "dismiss", title: translate("Dismiss") },
            ],
          });
          activeAndroidAlertId = id;
        } catch {
          activeAndroidAlertId = null;
          activeAlertCallbacks = null;
          detachAlertButtonListener();
        }
      },
      dismissHazardAlert: () => {
        if (activeAndroidAlertId === null) return;
        try {
          androidBridge.dismissAlert(activeAndroidAlertId);
        } catch {
          // Already gone on the native side.
        }
        activeAndroidAlertId = null;
        activeAlertCallbacks = null;
        detachAlertButtonListener();
      },
      mountQuickActions: (items, onActionPressed) => {
        if (!CarPlay.connected) return;
        // Android Auto's `ListTemplate` parses a flat `items` array,
        // not the iOS `sections` shape. Both shapes are built so the
        // package's platform-specific parsers each see the field they
        // expect.
        //
        // `browsable: true` is required on every Android row — the
        // package's `parseRowItem` only attaches `setOnClickListener`
        // (which fires `didSelectListItem`) when this flag is set, so
        // omitting it would render the rows but swallow taps silently
        // (verified against node_modules/react-native-carplay@2.4.1-
        // beta.0/android/.../RCTTemplate.kt:170).
        const fresh = new ListTemplate({
          id: QUICK_ACTIONS_TEMPLATE_ID,
          title: translate("Tarmoto"),
          items: items.map((item) => ({
            id: item.id,
            text: item.text,
            detailText: item.detailText,
            browsable: true,
          })),
          // The package's `ListTemplate` wrapper installs an
          // `onItemSelect` listener that filters by `templateId`,
          // which Android never sets. We attach our own direct
          // listener below; this callback survives as a no-op on the
          // off chance a future package version starts filling
          // `templateId` so both paths can fire.
          onItemSelect: async ({ index }) => {
            const picked = items[index];
            if (picked) onActionPressed(picked.id);
          },
        });
        activeQuickActions = {
          handler: onActionPressed,
          ids: new Set(items.map((item) => item.id)),
        };
        attachQuickActionsListener();
        try {
          CarPlay.setRootTemplate(fresh, false);
        } catch {
          // Host already disposed — controller will re-attempt next tick.
          activeQuickActions = null;
          detachQuickActionsListener();
        }
      },
      unmountQuickActions: () => {
        activeQuickActions = null;
        detachQuickActionsListener();
      },
      showInertRoot: () => {
        if (!CarPlay.connected) return;
        // Dismiss any live alert, detach the quick-actions listener, then set
        // the idle blank pane as root — replacing whatever surface (board /
        // quick-actions / nav) was showing.
        if (activeAndroidAlertId !== null) {
          try {
            androidBridge.dismissAlert(activeAndroidAlertId);
          } catch {
            // Already gone on the native side.
          }
          activeAndroidAlertId = null;
          activeAlertCallbacks = null;
          detachAlertButtonListener();
        }
        activeQuickActions = null;
        detachQuickActionsListener();
        try {
          const idle = new PaneTemplate({
            title: translate("Tarmoto"),
            pane: { items: [] },
          });
          CarPlay.setRootTemplate(idle, false);
        } catch {
          // AA host may have torn down the screen manager already.
        }
        template = null;
        mountedTitle = null;
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
    presentHazardAlert: () => undefined,
    dismissHazardAlert: () => undefined,
    mountQuickActions: () => undefined,
    unmountQuickActions: () => undefined,
    showInertRoot: () => undefined,
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
 * Whole-projection kill (`carplay_android_auto` force_off). While true, every
 * mount path is blocked and the head unit shows the inert idle root — see
 * `disableCarPlayProjection`. The nav map (`vehicleDisplay.ts`) is a separate
 * subsystem gated by its own consumer; this flag governs the ride board,
 * quick actions, and hazard alert.
 */
let projectionDisabled = false;
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
    // The hazard alert / quick-actions templates also live in the same
    // CarPlay scene that just disconnected, so their handles are stale.
    // Drop them so the next ride-tick re-presents the alert and remounts
    // the quick-actions list cleanly. Dismissed-hazard ids deliberately
    // persist across reconnects: if the rider already explicitly told us
    // to stop nagging about hazard X, a head-unit reboot shouldn't undo
    // that decision.
    activeHazardAlertId = null;
    quickActionsMounted = false;
    lastQuickActionsSignature = null;
  };
  bridge.subscribeDisconnect(reset);
  bridge.subscribeConnect(() => {
    reset();
    // If projection was disabled by the `carplay_android_auto` kill switch
    // while NO head unit was connected, `disableCarPlayProjection` couldn't
    // issue `showInertRoot()` (no host scene) and later calls no-op (the flag
    // is already set). Reapply the inert root now that a scene exists, so the
    // freshly-connected head unit shows nothing rather than the crash-on-
    // connect surface the kill switch is meant to suppress.
    if (projectionDisabled) bridge.showInertRoot();
  });
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
  // Operator kill switch — no head-unit surface while projection is disabled.
  if (projectionDisabled) return false;
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
 *
 * Also clears the dismissed/confirmed hazard tracking sets — those
 * are scoped to a single ride. A commuter who waved off a pothole
 * alert this morning should still be alerted about the same pothole
 * on the evening commute (within the same app session); without this
 * reset the module-level sets would persist until the process is
 * killed and the rider would silently miss a known hazard.
 */
export function unmountRideStatusBoard(): void {
  // Always reset the per-ride hazard guards, even if the bike-display
  // template never mounted (rider rode without a head unit). The sets
  // are populated only by user interaction with the alert template,
  // so clearing them when no template ever mounted is a cheap no-op
  // — but skipping the clear after a paired ride would leak last
  // ride's state into the next one.
  dismissedHazardIds.clear();
  confirmedHazardIds.clear();

  if (!templateMounted) return;
  const bridge = getBridge();
  // Even if the head unit disconnected mid-ride we still drop our local
  // state so the next ride mounts cleanly; the bridge is allowed to
  // no-op on its side when `isAvailable` is false.
  if (bridge.isAvailable()) bridge.clearStatusBoard();
  templateMounted = false;
  mountedTitle = null;
}

/**
 * Whole-projection kill for `carplay_android_auto`. Merely skipping future
 * mounts would leave whatever surface is already on the head unit (a ride
 * board, the Start-Commute list with a live callback, a hazard alert), so this
 * actively swaps the root for the inert idle template and blocks every mount
 * path until {@link enableCarPlayProjection}. Idempotent. The nav map is a
 * separate subsystem torn down by its own consumer (`useVehicleNavigationDisplay`).
 */
export function disableCarPlayProjection(): void {
  if (projectionDisabled) return;
  projectionDisabled = true;
  const bridge = getBridge();
  if (bridge.isAvailable()) bridge.showInertRoot();
  // Drop mount-tracking so a later re-enable re-issues `setRootTemplate`
  // cleanly rather than assuming a live template it no longer owns.
  templateMounted = false;
  mountedTitle = null;
  rideStatusSuspended = false;
  quickActionsMounted = false;
  lastQuickActionsSignature = null;
  activeHazardAlertId = null;
}

/** Re-enable head-unit projection after a `carplay_android_auto` kill clears.
 *  The reactive band effects in `useCarPlayRideMirror` re-run and re-mount the
 *  appropriate surface; nothing to push here. */
export function enableCarPlayProjection(): void {
  projectionDisabled = false;
}

// ── Hazard alert controller ──

/** Last hazard id we presented, so we don't re-fire on every ride-tick. */
let activeHazardAlertId: string | null = null;
/** Hazards the rider explicitly dismissed — we won't re-present these. */
const dismissedHazardIds = new Set<string>();
/**
 * Hazards the rider just *confirmed* on the head unit. Distinct from
 * `dismissedHazardIds` because confirm is meant to be reversible: the
 * rider has acknowledged the hazard and we should stop nagging them
 * for *this* approach, but if they later exit the alert radius and
 * come back (e.g. a u-turn, or the same pothole appears on the
 * outbound and inbound legs of a commute), the alert is allowed to
 * re-fire. The orchestrator clears each entry from this set the moment
 * the hazard drops out of `radiusMeters`, so it never grows unbounded
 * and a rider's confirmation is effectively "snooze until I leave the
 * radius" rather than "permanently silence this one".
 */
const confirmedHazardIds = new Set<string>();

/**
 * Mount the hazard alert template for the given snapshot. Idempotent
 * across ride-store ticks: re-calling with the same hazard id is a
 * no-op so the rider doesn't see the alert flash every time the ride
 * store ticks (currently ~1 Hz).
 *
 * Returns `true` when the bridge accepted the request (head-unit
 * connected and the hazard isn't on the dismissed/confirmed list),
 * `false` otherwise. The cross-cutting hook uses the return value to
 * skip subsequent state updates while the bridge is unreachable.
 */
export function presentHazardAlertOnVehicleDisplay(
  snapshot: HazardAlertSnapshot,
  callbacks: { onConfirm?: () => void; onDismiss?: () => void } = {},
): boolean {
  // Operator kill switch — no head-unit surface while projection is disabled.
  if (projectionDisabled) return false;
  if (
    dismissedHazardIds.has(snapshot.id) ||
    confirmedHazardIds.has(snapshot.id)
  ) {
    return false;
  }
  const bridge = getBridge();
  if (!bridge.isAvailable()) return false;
  if (activeHazardAlertId === snapshot.id) return true;
  bridge.presentHazardAlert(snapshot, {
    onConfirm: () => {
      // Park the hazard in the confirmed set so the next ride-tick
      // (which calls `mirrorClosestHazardAlert` ~1 Hz with the same
      // hazard still in range) doesn't immediately re-present what
      // the rider just acknowledged. The orchestrator removes the
      // entry once the hazard exits the radius, leaving the alert
      // free to fire again on a future re-entry.
      confirmedHazardIds.add(snapshot.id);
      callbacks.onConfirm?.();
      activeHazardAlertId = null;
    },
    onDismiss: () => {
      // Remember the rider's explicit dismissal so the same hazard
      // can't bounce back on the next tick or the next time the rider
      // re-enters its radius — a rider who taps Dismiss is telling us
      // "I see it, stop nagging me about this one for the rest of
      // the ride".
      dismissedHazardIds.add(snapshot.id);
      callbacks.onDismiss?.();
      activeHazardAlertId = null;
    },
  });
  activeHazardAlertId = snapshot.id;
  return true;
}

/** Hide the active hazard alert template if any. Idempotent. */
export function dismissHazardAlertOnVehicleDisplay(): void {
  if (!activeHazardAlertId) return;
  const bridge = getBridge();
  if (bridge.isAvailable()) bridge.dismissHazardAlert();
  activeHazardAlertId = null;
}

/**
 * One-shot orchestrator the cross-cutting hook calls on every
 * ride/hazard-store tick. Picks the closest *non-dismissed,
 * non-confirmed* hazard within `radiusMeters` of the rider and
 * presents it; if none qualifies (no fix, all out of range, every
 * nearby hazard already dismissed/confirmed) folds any standing alert.
 * Returning `"presented" | "dismissed" | "noop"` lets tests assert
 * which branch ran without poking module state.
 *
 * Filtering dismissed and confirmed ids inside the selection step is
 * the fix for two regressions:
 *
 *   1. A still-in-range dismissed hazard masking a brand-new one —
 *      previously `selectClosestHazard` returned the dismissed-but-
 *      closer hazard, the alert call returned `false`, and the
 *      next-closest fresh hazard never got considered.
 *   2. A confirmed hazard immediately re-firing on the next ride-tick
 *      — `onConfirm` clears `activeHazardAlertId`, so the same-id
 *      dedupe guard wouldn't catch the re-call. The
 *      `confirmedHazardIds` set keeps the orchestrator from re-
 *      presenting until the rider has actually moved out of range.
 *
 * As a side effect this method also clears confirmed-id entries for
 * hazards that have left the alert radius, so a future re-entry (the
 * rider doubles back over the same road) gets a fresh alert. Dismissed
 * ids deliberately stay sticky for the rest of the ride.
 */
export function mirrorClosestHazardAlert(
  hazards: Hazard[],
  riderLocation: LatLng | null,
  radiusMeters: number,
): "presented" | "dismissed" | "noop" {
  // Compute distances once so we can both pick the closest eligible
  // hazard and clear confirmed ids that have left the alert radius in
  // the same pass.
  if (riderLocation && confirmedHazardIds.size > 0) {
    for (const hazard of hazards) {
      if (!confirmedHazardIds.has(hazard.id)) continue;
      const distance = distanceMetersBetween(riderLocation, {
        lat: hazard.lat,
        lng: hazard.lng,
      });
      if (distance > radiusMeters) confirmedHazardIds.delete(hazard.id);
    }
    // Hazards that vanished from the nearby list entirely (server
    // expired them) also lose their confirmed status — same logic as
    // "out of range" since they can't re-fire from a list they're not
    // in.
    const stillNearby = new Set(hazards.map((h) => h.id));
    for (const id of confirmedHazardIds) {
      if (!stillNearby.has(id)) confirmedHazardIds.delete(id);
    }
  }

  const eligible = hazards.filter(
    (h) => !dismissedHazardIds.has(h.id) && !confirmedHazardIds.has(h.id),
  );
  const closest = selectClosestHazard(eligible, riderLocation);
  if (!closest || closest.distanceMeters > radiusMeters) {
    if (activeHazardAlertId) {
      dismissHazardAlertOnVehicleDisplay();
      return "dismissed";
    }
    return "noop";
  }
  const snapshot = buildHazardAlertSnapshot(
    closest.hazard,
    closest.distanceMeters,
  );
  // If the active alert is for a *different* hazard than the new
  // closest one, dismiss the standing alert before presenting the new
  // one — otherwise on iOS the alert stack would queue both, and on
  // Android the host's single-alert slot would silently swap without
  // the rider ever seeing the original.
  if (activeHazardAlertId && activeHazardAlertId !== snapshot.id) {
    dismissHazardAlertOnVehicleDisplay();
  }
  const accepted = presentHazardAlertOnVehicleDisplay(snapshot);
  return accepted ? "presented" : "noop";
}

// ── Quick-actions controller ──

let quickActionsMounted = false;
let lastQuickActionsSignature: string | null = null;

/**
 * Mount the quick-actions list template on the head unit. Diff-skipped
 * across ride-store ticks: re-calling with the same items is a no-op
 * so we don't burn the AA host's update quota (1 update / 5 s during
 * navigation) on identical refreshes.
 *
 * Returns `true` when the bridge accepted the call.
 */
export function mountQuickActions(
  items: QuickActionItem[],
  onActionPressed: (id: QuickActionItem["id"]) => void,
): boolean {
  const bridge = getBridge();
  // Operator kill switch — no head-unit surface while projection is disabled.
  if (projectionDisabled) return false;
  if (!bridge.isAvailable()) return false;
  if (items.length === 0) {
    if (quickActionsMounted) {
      bridge.unmountQuickActions();
      quickActionsMounted = false;
      lastQuickActionsSignature = null;
    }
    return false;
  }
  const signature = items
    .map((i) => `${i.id}|${i.text}|${i.detailText}`)
    .join("\n");
  if (quickActionsMounted && signature === lastQuickActionsSignature)
    return true;
  bridge.mountQuickActions(items, onActionPressed);
  quickActionsMounted = true;
  lastQuickActionsSignature = signature;
  return true;
}

/** Tear down the quick-actions template. Idempotent. */
export function unmountQuickActions(): void {
  if (!quickActionsMounted) return;
  const bridge = getBridge();
  if (bridge.isAvailable()) bridge.unmountQuickActions();
  quickActionsMounted = false;
  lastQuickActionsSignature = null;
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
  rideStatusSuspended = false;
  projectionDisabled = false;
  activeHazardAlertId = null;
  dismissedHazardIds.clear();
  confirmedHazardIds.clear();
  quickActionsMounted = false;
  lastQuickActionsSignature = null;
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
  projectionDisabled = false;
  activeHazardAlertId = null;
  dismissedHazardIds.clear();
  confirmedHazardIds.clear();
  quickActionsMounted = false;
  lastQuickActionsSignature = null;
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
