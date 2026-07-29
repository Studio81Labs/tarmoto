import type { NativeEventSubscription } from "react-native";
import { Platform } from "react-native";
import {
  formatDistanceKm,
  formatSpeedKmh,
  mountRideStatusBoard,
  resumeRideStatusBoard,
  suspendRideStatusBoard,
  type RideStatusBoard,
} from "@/services/carplay";
import {
  useVehicleDisplayStore,
  type VehicleDisplaySnapshot,
} from "@/stores/vehicleDisplay";
import { useRideStore } from "@/stores";
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";
import { MANEUVER_LABELS } from "@/services/navigation";
import { formatDurationSeconds } from "@/theme";
import type { HazardType, LatLng } from "@/types";
import VehicleDisplaySurface from "@/components/VehicleDisplaySurface";
import { t as translate, type EnglishMessageKey, type Translate } from "@/i18n";
import { getFormatters } from "@/format";
import {
  localeSearchIncludes,
  normalizeForLocaleSearch,
} from "@tarmoto/shared";

export type VehicleNavigationSnapshot = VehicleDisplaySnapshot;

export interface VehicleDisplayBridge {
  mountNavigation(): void;
  unmountNavigation(): void;
  /**
   * Push the latest navigation snapshot into the active map template
   * surface. iOS renders the snapshot through the React-component map
   * surface (`VehicleDisplaySurface` subscribes to the Zustand store
   * and re-renders), so this is a no-op there. On Android Auto the
   * Jetpack `MapTemplate` doesn't render React components — only
   * native Pane / Header / ItemList content — so this is the call
   * that actually paints the next maneuver and live ride stats onto
   * the head unit display.
   */
  syncNavigation(snapshot: VehicleNavigationSnapshot): void;
  openSearch(items: HazardSearchItem[]): void;
  updateSearch(items: HazardSearchItem[]): void;
  closeSearch(): void;
  showBanner(message: string, tone: "success" | "danger"): void;
}

export interface HazardSearchItem {
  id: HazardType;
  text: string;
  detailText: string;
}

const HAZARD_COPY: Record<
  HazardType,
  {
    label: EnglishMessageKey;
    detail: EnglishMessageKey;
    aliases: string[];
  }
> = {
  pothole: {
    label: "Pothole",
    detail: "Deep hole or broken asphalt",
    aliases: ["hole", "pothole", "crater"],
  },
  gravel: {
    label: "Gravel",
    detail: "Loose gravel or debris on the road",
    aliases: ["gravel", "loose", "stones", "pebbles"],
  },
  oil_spill: {
    label: "Oil spill",
    detail: "Oil, fuel, or slippery contamination",
    aliases: ["oil", "fuel", "diesel", "slippery", "spill"],
  },
  roadworks: {
    label: "Roadworks",
    detail: "Construction, lane closures, or cones",
    aliases: ["roadworks", "road works", "construction", "works", "cones"],
  },
  animals: {
    label: "Animals",
    detail: "Animals on or near the carriageway",
    aliases: ["animal", "animals", "deer", "dog", "cow"],
  },
  police: {
    label: "Police",
    detail: "Police checkpoint or speed enforcement",
    aliases: ["police", "cop", "speed trap", "checkpoint"],
  },
  flooding: {
    label: "Flooding",
    detail: "Standing water or flooded section",
    aliases: ["flood", "flooding", "water", "standing water"],
  },
  ice: {
    label: "Ice",
    detail: "Ice, black ice, or frozen patch",
    aliases: ["ice", "icy", "black ice", "frozen"],
  },
  other: {
    label: "Other",
    detail: "Something hazardous that doesn't fit the presets",
    aliases: ["other", "hazard", "danger", "obstacle"],
  },
};

export function matchHazardTypeFromText(
  query: string,
  translateCopy: Translate = translate,
  locale: string = getFormatters().locale,
): HazardType | null {
  const normalized = normalizeForLocaleSearch(query, locale);
  if (!normalized) return null;

  let best: { type: HazardType; score: number } | null = null;
  for (const [type, copy] of Object.entries(HAZARD_COPY) as Array<
    [HazardType, (typeof HAZARD_COPY)[HazardType]]
  >) {
    let score = 0;
    const translatedLabel = normalizeForLocaleSearch(
      translateCopy(copy.label),
      locale,
    );
    if (translatedLabel) {
      if (normalized === translatedLabel) score = Math.max(score, 100);
      else if (normalized.includes(translatedLabel)) {
        score = Math.max(score, 80);
      } else if (translatedLabel.includes(normalized)) {
        score = Math.max(score, 60);
      }
    }
    for (const rawAlias of copy.aliases) {
      const alias = normalizeForLocaleSearch(rawAlias, locale);
      if (normalized === alias) score = Math.max(score, 100);
      else if (normalized.includes(alias)) score = Math.max(score, 80);
      else if (alias.includes(normalized)) score = Math.max(score, 60);
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { type, score };
    }
  }
  return best?.type ?? null;
}

export function buildHazardSearchItems(
  query: string,
  translateCopy: Translate = translate,
  locale: string = getFormatters().locale,
): HazardSearchItem[] {
  const normalized = normalizeForLocaleSearch(query, locale);
  if (!normalized) {
    return (
      Object.entries(HAZARD_COPY) as Array<
        [HazardType, (typeof HAZARD_COPY)[HazardType]]
      >
    ).map(([id, copy]) => ({
      id,
      text: translateCopy(copy.label),
      detailText: translateCopy(copy.detail),
    }));
  }
  const scored = (
    Object.entries(HAZARD_COPY) as Array<
      [HazardType, (typeof HAZARD_COPY)[HazardType]]
    >
  ).map(([id, copy]) => {
    const translatedLabel = translateCopy(copy.label);
    let score = 0;
    for (const rawAlias of copy.aliases) {
      const alias = normalizeForLocaleSearch(rawAlias, locale);
      if (normalized === alias) score = Math.max(score, 100);
      else if (alias.startsWith(normalized)) score = Math.max(score, 80);
      else if (
        alias.includes(normalized) ||
        localeSearchIncludes(copy.label, normalized, locale) ||
        localeSearchIncludes(translatedLabel, normalized, locale)
      ) {
        score = Math.max(score, 60);
      }
    }
    return {
      id,
      text: translatedLabel,
      detailText: translateCopy(copy.detail),
      score,
    };
  });

  return scored
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.text.localeCompare(b.text, locale, { sensitivity: "base" }),
    )
    .map(({ id, text, detailText }) => ({ id, text, detailText }));
}

/**
 * One row of head-unit pane content. Mirrors the StatusBoardItem shape
 * from `services/carplay` so the same row primitive flows through both
 * the navigation surface (this module) and the idle status board.
 */
export interface NavigationPaneItem {
  title: string;
  detail: string;
}

/**
 * Distance to the next maneuver, in metres. Distinct from
 * `formatDistanceKm` (in `services/carplay`) because the navigation
 * snapshot expresses upcoming-maneuver distance in metres rather than
 * cumulative ride distance in kilometres — switching units below 1 km
 * keeps "320 m to turn" readable on the bike display.
 *
 * The 10-m rounding is applied before the unit threshold so a 995 m
 * input snaps to "1.0 km" rather than briefly rendering "1000 m" and
 * then dropping to "990 m" a tick later — that backwards-looking
 * discontinuity is jarring at a glance from the bike.
 */
export function formatNavDistanceMeters(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) {
    return getFormatters().distanceM(0);
  }
  const rounded = Math.round(meters / 10) * 10;
  return rounded >= 1000
    ? getFormatters().distanceKm(rounded / 1000)
    : getFormatters().distanceM(rounded);
}

/**
 * Compose the next-maneuver row title for the Android Auto pane.
 *
 * AC #4 calls for "icon + distance + road name" on the AA navigation
 * template. Android Auto's MapTemplate pane shows a `Row` with a title
 * and a single secondary text line — combining the maneuver verb and
 * the distance into the title (e.g. "Turn left in 320 m") plus the
 * road name on the detail line is the closest analogue without
 * standing up the full `androidx.car.app.navigation.model.Maneuver`
 * machinery (which requires bundled bitmap icons and is overkill for
 * the polyline-derived turns we infer in `services/navigation`).
 *
 * Off-route state takes priority over the upcoming maneuver — when
 * the rider has drifted off the planned polyline, the maneuver index
 * is unreliable, so we surface that as the headline row instead.
 */
export function formatNextManeuverRow(
  snapshot: VehicleNavigationSnapshot,
): NavigationPaneItem {
  if (snapshot.offRoute) {
    return {
      title: translate("Off route"),
      detail: translate("{distance} from path", {
        distance: formatNavDistanceMeters(snapshot.offRouteDistanceM),
      }),
    };
  }
  if (!snapshot.nextManeuver) {
    return {
      title: translate("Continue"),
      detail: snapshot.title,
    };
  }
  const verb = translate(
    MANEUVER_LABELS[snapshot.nextManeuver.type] ?? "Continue",
  );
  const distance = formatNavDistanceMeters(snapshot.distanceToNextM);
  return {
    title: translate("{value0} in {value1}", {
      value0: verb,
      value1: distance,
    }),
    detail: snapshot.nextManeuver.roadName
      ? translate("onto {roadName}", {
          roadName: snapshot.nextManeuver.roadName,
        })
      : snapshot.title,
  };
}

/**
 * Build the four-row pane content shown on the Android Auto map
 * template — the next maneuver headline plus the same speed /
 * distance / duration triplet the iOS surface renders. Pure on the
 * snapshot so tests can lock in the wording without instantiating a
 * native template.
 *
 * AA's MapTemplate caps the pane at 4 rows, so we deliberately emit
 * exactly four. Adding a fifth would silently drop on the host.
 */
export function buildNavigationPaneItems(
  snapshot: VehicleNavigationSnapshot,
): NavigationPaneItem[] {
  // Reuse the carplay/theme formatters so the head-unit pane and the
  // CarPlay status board can never drift on edge cases (sub-1 km/h
  // jitter, NaN durations, negative km from a corrupt snapshot).
  return [
    formatNextManeuverRow(snapshot),
    {
      title: translate("Speed"),
      detail: formatSpeedKmh(snapshot.rideStats.speedKmh),
    },
    {
      title: translate("Distance"),
      detail: formatDistanceKm(snapshot.rideStats.distanceKm),
    },
    {
      title: translate("Duration"),
      detail: formatDurationSeconds(snapshot.rideStats.durationSeconds),
    },
  ];
}

interface VehicleDisplayControllerOptions {
  bridge: VehicleDisplayBridge;
  reportHazard: (location: LatLng, type: HazardType) => Promise<void>;
  translate?: Translate;
}

export class VehicleDisplayController {
  private snapshot: VehicleNavigationSnapshot | null = null;
  private searchItems: HazardSearchItem[] = [];
  private mounted = false;

  constructor(private readonly options: VehicleDisplayControllerOptions) {}

  private get translate(): Translate {
    return this.options.translate ?? translate;
  }

  sync(snapshot: VehicleNavigationSnapshot): void {
    this.snapshot = snapshot;
    if (!this.mounted) {
      this.options.bridge.mountNavigation();
      this.mounted = true;
    }
    // Push the new snapshot into the bridge whether or not we just
    // mounted. iOS no-ops this (the React-component surface
    // re-renders from the Zustand store automatically); Android Auto
    // uses it to refresh the next-maneuver pane natively, since the
    // Jetpack `MapTemplate` ignores the `component` prop and only
    // renders pane/header/itemList content set on the template.
    this.options.bridge.syncNavigation(snapshot);
  }

  stop(): void {
    this.searchItems = [];
    this.options.bridge.closeSearch();
    if (this.mounted) {
      this.options.bridge.unmountNavigation();
      this.mounted = false;
    }
    this.snapshot = null;
  }

  handleTemplateAction(actionId: string): void {
    if (actionId !== "report-hazard") return;
    // Operator kill switch (`hazard_reporting`): don't even open the hazard
    // search on the head unit. The action is omitted from freshly-built
    // templates, but a template built before a mid-session kill can still
    // carry it — so gate the handler too, otherwise the rider gets an
    // apparently-working search that silently discards the report.
    if (!isFeatureKillSwitchActive("hazard_reporting")) return;
    this.searchItems = buildHazardSearchItems("", this.translate);
    this.options.bridge.openSearch(this.searchItems);
  }

  handleSearchTextChange(query: string): void {
    this.searchItems = buildHazardSearchItems(query, this.translate);
    this.options.bridge.updateSearch(this.searchItems);
  }

  async submitSearchQuery(query: string): Promise<boolean> {
    const type = matchHazardTypeFromText(query, this.translate);
    if (!type) {
      this.options.bridge.showBanner(
        this.translate(
          "Say pothole, gravel, oil spill, roadworks, animals, police, flooding, or ice.",
        ),
        "danger",
      );
      return false;
    }

    return this.reportHazard(type);
  }

  async selectSearchItem(index: number): Promise<boolean> {
    const item = this.searchItems[index];
    if (!item) return false;
    return this.reportHazard(item.id);
  }

  private async reportHazard(type: HazardType): Promise<boolean> {
    const location = this.snapshot?.currentLocation;
    if (!location) {
      this.options.bridge.showBanner(
        this.translate("Waiting for GPS before reporting a hazard."),
        "danger",
      );
      return false;
    }

    // Operator kill switch (`hazard_reporting`): silently drop head-unit
    // reports. Gating here (not just in the injected callback) is what stops
    // the "Hazard reported" success banner below from falsely confirming a
    // report that never sent — a bare callback no-op would still fall through
    // to it. Just dismiss the search; no POST, no banner.
    if (!isFeatureKillSwitchActive("hazard_reporting")) {
      this.options.bridge.closeSearch();
      return false;
    }

    await this.options.reportHazard(location, type);
    this.options.bridge.closeSearch();
    this.options.bridge.showBanner(
      this.translate("Hazard reported: {hazard}", {
        hazard: this.translate(HAZARD_COPY[type].label),
      }),
      "success",
    );
    return true;
  }
}

type CarPlayLib = typeof import("react-native-carplay");

let activeBridge: VehicleDisplayBridge | null = null;
let activeController: VehicleDisplayController | null = null;
let bannerClearTimeout: ReturnType<typeof setTimeout> | null = null;

function buildRideBoard(snapshot: VehicleNavigationSnapshot): RideStatusBoard {
  return {
    rideType: snapshot.rideStats.rideType,
    speedKmh: snapshot.rideStats.speedKmh,
    distanceKm: snapshot.rideStats.distanceKm,
    durationSeconds: snapshot.rideStats.durationSeconds,
    qualityScore: null,
    qualityConfidence: null,
  };
}

function clearBannerTimeout(): void {
  if (bannerClearTimeout !== null) {
    clearTimeout(bannerClearTimeout);
    bannerClearTimeout = null;
  }
}

export function showVehicleDisplayBanner(
  message: string,
  tone: "success" | "danger",
): void {
  clearBannerTimeout();
  const store = useVehicleDisplayStore.getState();
  store.setBanner({ message, tone });
  bannerClearTimeout = setTimeout(() => {
    const latest = useVehicleDisplayStore.getState();
    latest.setBanner(null);
    bannerClearTimeout = null;
  }, 3000);
}

function createNoopRuntimeBridge(): VehicleDisplayBridge {
  return {
    mountNavigation: () => undefined,
    unmountNavigation: () => undefined,
    syncNavigation: () => undefined,
    openSearch: () => undefined,
    updateSearch: () => undefined,
    closeSearch: () => undefined,
    showBanner: showVehicleDisplayBanner,
  };
}

function createRuntimeBridge(snapshotRef: {
  current: VehicleNavigationSnapshot | null;
}): VehicleDisplayBridge {
  const store = useVehicleDisplayStore.getState();

  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    return createNoopRuntimeBridge();
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const lib = require("react-native-carplay") as CarPlayLib;
    const { CarPlay, MapTemplate, SearchTemplate, InformationTemplate } = lib;
    // PaneTemplate is the Android-Auto equivalent of InformationTemplate
    // — needed for the idle fallback root because AA's `TemplateParser`
    // has no `"information"` case (see node_modules/react-native-carplay/
    // android/.../TemplateParser.kt) and would build a "Template missing"
    // pane if we fed it an InformationTemplate. Resolved separately so
    // tests stubbing the package don't have to pay attention to it on
    // platforms that won't reach the Android branch below.
    const PaneTemplate =
      Platform.OS === "android"
        ? (lib as typeof import("react-native-carplay")).PaneTemplate
        : null;

    const MAP_TEMPLATE_ID = "tarmoto-vehicle-map";
    const SEARCH_TEMPLATE_ID = "tarmoto-vehicle-hazard-search";
    let mapTemplate: InstanceType<typeof MapTemplate> | null = null;
    let searchTemplate: InstanceType<typeof SearchTemplate> | null = null;
    let listening = false;
    let searchVisible = false;
    /**
     * Cache the last pane content we pushed to the Android map
     * template. The Jetpack host treats every `setTemplate` call as a
     * potential "screen invalidate" — re-pushing identical content
     * costs the rider's quota of 1 update / 5 s during navigation
     * (host-enforced rate limit) and can flicker the bike display.
     * Diff-skip the no-op pushes here so high-frequency ride-store
     * ticks (~1 Hz) only hit the host when something visibly changed.
     */
    let lastAndroidPaneSignature: string | null = null;
    const subscriptions: NativeEventSubscription[] = [];

    const ensureListeners = () => {
      if (listening) return;
      listening = true;

      subscriptions.push(
        CarPlay.emitter.addListener(
          "barButtonPressed",
          (e: { id: string; templateId?: string }) => {
            if (e.templateId === MAP_TEMPLATE_ID) {
              activeController?.handleTemplateAction(e.id);
            }
          },
        ),
      );
      subscriptions.push(
        CarPlay.emitter.addListener("buttonPressed", (e: { id: string }) => {
          activeController?.handleTemplateAction(e.id);
        }),
      );
      subscriptions.push(
        CarPlay.emitter.addListener(
          "updatedSearchText",
          (e: { searchText: string; templateId?: string }) => {
            if (!searchVisible) return;
            if (e.templateId && e.templateId !== SEARCH_TEMPLATE_ID) return;
            activeController?.handleSearchTextChange(e.searchText ?? "");
          },
        ),
      );
      subscriptions.push(
        CarPlay.emitter.addListener(
          "searchButtonPressed",
          (e: { searchText?: string; templateId?: string }) => {
            if (!searchVisible) return;
            if (e.templateId && e.templateId !== SEARCH_TEMPLATE_ID) return;
            void activeController?.submitSearchQuery(e.searchText ?? "");
          },
        ),
      );
      subscriptions.push(
        CarPlay.emitter.addListener(
          "selectedResult",
          (e: { index: number; templateId?: string }) => {
            if (!searchVisible) return;
            if (e.templateId && e.templateId !== SEARCH_TEMPLATE_ID) return;
            void activeController?.selectSearchItem(e.index);
            if (Platform.OS === "ios") {
              CarPlay.bridge.reactToSelectedResult(true);
            }
          },
        ),
      );
    };

    const removeListeners = () => {
      while (subscriptions.length > 0) {
        subscriptions.pop()?.remove();
      }
      listening = false;
    };

    const ensureMapTemplate = () => {
      if (mapTemplate) return mapTemplate;
      // The Report action is ALWAYS present in the template (never baked to the
      // switch state): the template is memoised and only rebuilt on unmount, so
      // omitting the action while killed would leave it missing for the rest of
      // the nav session even after the operator re-enables reporting. Instead
      // the `hazard_reporting` kill is enforced downstream — `handleTemplateAction`
      // refuses to open the hazard search, and `reportHazard` drops the report
      // without a POST or a success banner — so a killed tap is inert rather
      // than an apparently-working workflow.
      mapTemplate = new MapTemplate({
        id: MAP_TEMPLATE_ID,
        title: translate("Tarmoto Nav"),
        component: VehicleDisplaySurface,
        leadingNavigationBarButtons:
          Platform.OS === "ios"
            ? [
                {
                  id: "report-hazard",
                  type: "text",
                  title: translate("Report"),
                },
              ]
            : undefined,
        actions:
          Platform.OS === "android"
            ? [
                {
                  id: "report-hazard",
                  type: "custom",
                  title: translate("Report"),
                },
              ]
            : undefined,
      } as never);
      return mapTemplate;
    };

    const renderSearchItemsForIos = (items: HazardSearchItem[]) =>
      items.map((item) => ({
        id: item.id,
        text: item.text,
        detailText: item.detailText,
      }));

    const restoreFallbackRoot = () => {
      // `mountNavigation()` suspended the ride board on mount. ALWAYS lift that
      // suspension on teardown — even when we fall through to the idle root
      // (standalone navigation, no active ride) — otherwise `rideStatusSuspended`
      // stays set and a ride started LATER in the same session can never mount
      // its board (`mountRideStatusBoard` early-returns while suspended).
      resumeRideStatusBoard();

      const snapshot = snapshotRef.current;
      // Only fall back to the ride-status board when a ride is actually
      // recording. A standalone navigation (e.g. previewing a commute
      // alternative without starting a ride) has no active ride, so its
      // snapshot's zeroed/stale rideStats would render a bogus board — show the
      // idle root instead.
      if (snapshot && useRideStore.getState().isRiding) {
        mountRideStatusBoard(buildRideBoard(snapshot));
        return;
      }

      if (!CarPlay.connected) return;
      // The idle root is platform-specific: AA's `TemplateParser` has
      // no `"information"` case, so an `InformationTemplate` would
      // render as a "Template missing" pane on the head unit. Use the
      // Jetpack `PaneTemplate` on Android — same shape (title + zero
      // rows), parses cleanly. iOS keeps `InformationTemplate` so the
      // CarPlay idle look matches the active ride-status board.
      if (Platform.OS === "android" && PaneTemplate) {
        const idle = new PaneTemplate({
          title: translate("Tarmoto"),
          pane: { items: [] },
        });
        CarPlay.setRootTemplate(idle, false);
        return;
      }
      const idle = new InformationTemplate({
        title: translate("Tarmoto"),
        items: [],
        actions: [],
        onActionButtonPressed: () => undefined,
      });
      CarPlay.setRootTemplate(idle, false);
    };

    return {
      mountNavigation: () => {
        if (!CarPlay.connected) return;
        ensureListeners();
        store.setVisible(true);
        suspendRideStatusBoard();
        // Reset the diff cache so the first post-mount sync always
        // pushes its pane (the host has no carry-over from the
        // pre-mount template).
        lastAndroidPaneSignature = null;
        CarPlay.setRootTemplate(ensureMapTemplate(), false);
      },
      unmountNavigation: () => {
        searchVisible = false;
        removeListeners();
        clearBannerTimeout();
        store.setVisible(false);
        store.setSnapshot(null);
        store.setBanner(null);
        lastAndroidPaneSignature = null;
        mapTemplate = null;
        restoreFallbackRoot();
      },
      syncNavigation: (snapshot) => {
        if (!CarPlay.connected) return;
        // iOS path: the React-component map surface re-renders from
        // the Zustand store automatically when `store.setSnapshot`
        // fires (called by `syncVehicleNavigationDisplay` upstream of
        // this bridge call), so there's no native push needed here.
        if (Platform.OS !== "android") return;
        // Android path: the system MapTemplate ignores the React
        // `component` prop and only paints the pane / itemList /
        // header content set on the template. Push the latest pane
        // every tick so the rider sees current speed / distance /
        // duration / next-maneuver natively.
        const items = buildNavigationPaneItems(snapshot);
        const signature = items.map((i) => `${i.title}|${i.detail}`).join("\n");
        if (signature === lastAndroidPaneSignature) return;
        lastAndroidPaneSignature = signature;
        const template = ensureMapTemplate();
        template.updateConfig({
          ...template.config,
          pane: {
            items: items.map((item, index) => ({
              id: `nav-row-${index}`,
              text: item.title,
              detailText: item.detail,
            })),
          },
        } as never);
      },
      openSearch: (items) => {
        if (!CarPlay.connected) return;
        if (!searchTemplate) {
          searchTemplate = new SearchTemplate({
            id: SEARCH_TEMPLATE_ID,
            title: translate("Report Hazard"),
            items,
            searchHint: translate("Say pothole, gravel, oil spill…"),
            showKeyboardByDefault: false,
          } as never);
        } else if (Platform.OS === "android") {
          searchTemplate.updateTemplate({
            title: translate("Report Hazard"),
            items,
            searchHint: translate("Say pothole, gravel, oil spill…"),
          } as never);
        }

        searchVisible = true;
        CarPlay.pushTemplate(searchTemplate, true);
        if (Platform.OS === "ios") {
          CarPlay.bridge.reactToUpdatedSearchText(
            SEARCH_TEMPLATE_ID,
            renderSearchItemsForIos(items),
          );
        }
      },
      updateSearch: (items) => {
        if (!searchTemplate) return;
        if (Platform.OS === "ios") {
          CarPlay.bridge.reactToUpdatedSearchText(
            SEARCH_TEMPLATE_ID,
            renderSearchItemsForIos(items),
          );
          return;
        }
        searchTemplate.updateTemplate({
          title: translate("Report Hazard"),
          items,
          searchHint: translate("Say pothole, gravel, oil spill…"),
        } as never);
      },
      closeSearch: () => {
        if (!searchVisible) return;
        searchVisible = false;
        CarPlay.popTemplate(true);
      },
      showBanner: showVehicleDisplayBanner,
    };
  } catch {
    return createNoopRuntimeBridge();
  }
}

const runtimeSnapshotRef: { current: VehicleNavigationSnapshot | null } = {
  current: null,
};

export function syncVehicleNavigationDisplay(
  snapshot: VehicleNavigationSnapshot,
  reportHazard: (location: LatLng, type: HazardType) => Promise<void>,
): void {
  runtimeSnapshotRef.current = snapshot;
  const store = useVehicleDisplayStore.getState();
  store.setSnapshot(snapshot);
  if (!activeBridge) {
    activeBridge = createRuntimeBridge(runtimeSnapshotRef);
  }
  if (!activeController) {
    activeController = new VehicleDisplayController({
      bridge: activeBridge,
      reportHazard,
    });
  }
  activeController.sync(snapshot);
}

/**
 * Stop the head-unit navigation projection.
 *
 * `hard` distinguishes the two reasons a caller stops:
 *   - `false` (default) — normal end / `basic_navigation` kill. The
 *     controller's `restoreFallbackRoot` restores the ride-status board when a
 *     ride is still active (turn-by-turn off, ride continues).
 *   - `true` — `carplay_android_auto` whole-projection kill. Clear the snapshot
 *     BEFORE stopping so `restoreFallbackRoot` takes its inert idle-root branch
 *     instead of restoring the ride board — the head unit must show no Tarmoto
 *     nav surface.
 */
export function stopVehicleNavigationDisplay(hard = false): void {
  if (hard) {
    runtimeSnapshotRef.current = null;
    useVehicleDisplayStore.getState().setSnapshot(null);
  }
  activeController?.stop();
  activeController = null;
  activeBridge = null;
  runtimeSnapshotRef.current = null;
  clearBannerTimeout();
}
