import type { NativeEventSubscription } from "react-native";
import { Platform } from "react-native";
import {
  mountRideStatusBoard,
  resumeRideStatusBoard,
  suspendRideStatusBoard,
  type RideStatusBoard,
} from "@/services/carplay";
import {
  useVehicleDisplayStore,
  type VehicleDisplaySnapshot,
} from "@/stores/vehicleDisplay";
import type { HazardType, LatLng } from "@/types";
import VehicleDisplaySurface from "@/components/VehicleDisplaySurface";

export type VehicleNavigationSnapshot = VehicleDisplaySnapshot;

export interface VehicleDisplayBridge {
  mountNavigation(): void;
  unmountNavigation(): void;
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
  { label: string; detail: string; aliases: string[] }
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

export function matchHazardTypeFromText(query: string): HazardType | null {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;

  let best: { type: HazardType; score: number } | null = null;
  for (const [type, copy] of Object.entries(HAZARD_COPY) as Array<
    [HazardType, (typeof HAZARD_COPY)[HazardType]]
  >) {
    let score = 0;
    for (const alias of copy.aliases) {
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

export function buildHazardSearchItems(query: string): HazardSearchItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return (
      Object.entries(HAZARD_COPY) as Array<
        [HazardType, (typeof HAZARD_COPY)[HazardType]]
      >
    ).map(([id, copy]) => ({
      id,
      text: copy.label,
      detailText: copy.detail,
    }));
  }
  const scored = (
    Object.entries(HAZARD_COPY) as Array<
      [HazardType, (typeof HAZARD_COPY)[HazardType]]
    >
  ).map(([id, copy]) => {
    let score = 0;
    for (const alias of copy.aliases) {
      if (normalized === alias) score = Math.max(score, 100);
      else if (alias.startsWith(normalized)) score = Math.max(score, 80);
      else if (
        alias.includes(normalized) ||
        copy.label.toLowerCase().includes(normalized)
      ) {
        score = Math.max(score, 60);
      }
    }
    return {
      id,
      text: copy.label,
      detailText: copy.detail,
      score,
    };
  });

  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text))
    .map(({ id, text, detailText }) => ({ id, text, detailText }));
}

interface VehicleDisplayControllerOptions {
  bridge: VehicleDisplayBridge;
  reportHazard: (location: LatLng, type: HazardType) => Promise<void>;
}

export class VehicleDisplayController {
  private snapshot: VehicleNavigationSnapshot | null = null;
  private searchItems: HazardSearchItem[] = [];
  private mounted = false;

  constructor(private readonly options: VehicleDisplayControllerOptions) {}

  sync(snapshot: VehicleNavigationSnapshot): void {
    this.snapshot = snapshot;
    if (!this.mounted) {
      this.options.bridge.mountNavigation();
      this.mounted = true;
    }
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
    this.searchItems = buildHazardSearchItems("");
    this.options.bridge.openSearch(this.searchItems);
  }

  handleSearchTextChange(query: string): void {
    this.searchItems = buildHazardSearchItems(query);
    this.options.bridge.updateSearch(this.searchItems);
  }

  async submitSearchQuery(query: string): Promise<boolean> {
    const type = matchHazardTypeFromText(query);
    if (!type) {
      this.options.bridge.showBanner(
        "Say pothole, gravel, oil spill, roadworks, animals, police, flooding, or ice.",
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
        "Waiting for GPS before reporting a hazard.",
        "danger",
      );
      return false;
    }

    await this.options.reportHazard(location, type);
    this.options.bridge.closeSearch();
    this.options.bridge.showBanner(
      `Hazard reported: ${HAZARD_COPY[type].label}`,
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

function createRuntimeBridge(snapshotRef: {
  current: VehicleNavigationSnapshot | null;
}): VehicleDisplayBridge {
  const store = useVehicleDisplayStore.getState();

  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    return {
      mountNavigation: () => undefined,
      unmountNavigation: () => undefined,
      openSearch: () => undefined,
      updateSearch: () => undefined,
      closeSearch: () => undefined,
      showBanner: showVehicleDisplayBanner,
    };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const lib = require("react-native-carplay") as CarPlayLib;
    const { CarPlay, MapTemplate, SearchTemplate, InformationTemplate } = lib;

    const MAP_TEMPLATE_ID = "tarmoto-vehicle-map";
    const SEARCH_TEMPLATE_ID = "tarmoto-vehicle-hazard-search";
    let mapTemplate: InstanceType<typeof MapTemplate> | null = null;
    let searchTemplate: InstanceType<typeof SearchTemplate> | null = null;
    let listening = false;
    let searchVisible = false;
    const subscriptions: NativeEventSubscription[] = [];
    const clearSubscriptions = () => {
      for (const subscription of subscriptions) {
        subscription.remove();
      }
      subscriptions.length = 0;
      listening = false;
    };

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
      mapTemplate = new MapTemplate({
        id: MAP_TEMPLATE_ID,
        title: "Tarmoto Nav",
        component: VehicleDisplaySurface,
        leadingNavigationBarButtons:
          Platform.OS === "ios"
            ? [{ id: "report-hazard", type: "text", title: "Report" }]
            : undefined,
        actions:
          Platform.OS === "android"
            ? [{ id: "report-hazard", type: "custom", title: "Report" }]
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
      const snapshot = snapshotRef.current;
      if (snapshot) {
        resumeRideStatusBoard();
        mountRideStatusBoard(buildRideBoard(snapshot));
        return;
      }

      const idle = new InformationTemplate({
        title: "Tarmoto",
        items: [],
        actions: [],
        onActionButtonPressed: () => undefined,
      });
      if (!CarPlay.connected) return;
      CarPlay.setRootTemplate(idle, false);
    };

    return {
      mountNavigation: () => {
        if (!CarPlay.connected) return;
        ensureListeners();
        store.setVisible(true);
        suspendRideStatusBoard();
        CarPlay.setRootTemplate(ensureMapTemplate(), false);
      },
      unmountNavigation: () => {
        searchVisible = false;
        removeListeners();
        clearBannerTimeout();
        store.setVisible(false);
        store.setSnapshot(null);
        store.setBanner(null);
        restoreFallbackRoot();
        clearSubscriptions();
      },
      openSearch: (items) => {
        if (!CarPlay.connected) return;
        if (!searchTemplate) {
          searchTemplate = new SearchTemplate({
            id: SEARCH_TEMPLATE_ID,
            title: "Report Hazard",
            items,
            searchHint: "Say pothole, gravel, oil spill…",
            showKeyboardByDefault: false,
          } as never);
        } else if (Platform.OS === "android") {
          searchTemplate.updateTemplate({
            title: "Report Hazard",
            items,
            searchHint: "Say pothole, gravel, oil spill…",
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
          title: "Report Hazard",
          items,
          searchHint: "Say pothole, gravel, oil spill…",
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
    return {
      mountNavigation: () => undefined,
      unmountNavigation: () => undefined,
      openSearch: () => undefined,
      updateSearch: () => undefined,
      closeSearch: () => undefined,
      showBanner: showVehicleDisplayBanner,
    };
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

export function stopVehicleNavigationDisplay(): void {
  activeController?.stop();
  activeController = null;
  activeBridge = null;
  runtimeSnapshotRef.current = null;
  clearBannerTimeout();
}
