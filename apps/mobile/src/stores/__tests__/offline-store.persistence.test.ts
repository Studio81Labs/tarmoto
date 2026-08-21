import type {
  OfflineRegion,
  OfflineRegionSpec,
} from "@/services/offlineRegions";

const mockMmkvStores = new Map<string, Map<string, unknown>>();

jest.mock("react-native-mmkv", () => ({
  createMMKV: ({ id }: { id: string }) => {
    let storage = mockMmkvStores.get(id);
    if (!storage) {
      storage = new Map();
      mockMmkvStores.set(id, storage);
    }
    return {
      getString: (key: string) => {
        const value = storage?.get(key);
        return typeof value === "string" ? value : undefined;
      },
      getNumber: (key: string) => {
        const value = storage?.get(key);
        return typeof value === "number" ? value : undefined;
      },
      set: (key: string, value: unknown) => {
        storage?.set(key, value);
      },
      remove: (key: string) => {
        storage?.delete(key);
      },
    };
  },
}));

const OFFLINE_STORAGE_ID = "tarmoto-offline-regions";
const OFFLINE_REGIONS_KEY = "regions";

function persistedRegion(
  overrides: Omit<Partial<OfflineRegion>, "lastError"> & {
    lastError?: unknown;
  } = {},
) {
  return {
    id: "region-persisted",
    name: "Persisted region",
    bbox: { west: 18.2, south: 49.78, east: 18.32, north: 49.85 },
    minZoom: 10,
    maxZoom: 11,
    createdAt: 1_700_000_000_000,
    ownerId: "rider-a",
    status: "failed",
    totalTiles: 100,
    downloadedTiles: 20,
    failedTiles: 1,
    bytesOnDisk: 4096,
    lastError: null,
    lastUpdatedAt: 1_700_000_001_000,
    ...overrides,
  };
}

function seedRegions(regions: unknown[]): void {
  mockMmkvStores.set(
    OFFLINE_STORAGE_ID,
    new Map<string, unknown>([[OFFLINE_REGIONS_KEY, JSON.stringify(regions)]]),
  );
}

function importOfflineStore(): typeof import("../index").useOfflineStore {
  let store!: typeof import("../index").useOfflineStore;
  jest.isolateModules(() => {
    // Re-evaluate the store to exercise its import-time MMKV hydration.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    store = require("../index").useOfflineStore;
  });
  return store;
}

describe("offline region persistence migration", () => {
  beforeEach(() => {
    mockMmkvStores.clear();
  });

  it("migrates a legacy persisted string error during module initialization", () => {
    seedRegions([
      persistedRegion({
        lastError: "Download failed after the app went offline",
      }),
    ]);

    const store = importOfflineStore();

    expect(store.getState().regions).toHaveLength(1);
    expect(store.getState().regions[0]?.lastError).toEqual({
      code: "download-failed",
    });
  });

  it("persists and reloads a structured tile-cap reason without losing its details", () => {
    const store = importOfflineStore();
    const spec: OfflineRegionSpec = {
      id: "region-structured",
      name: "Structured region",
      bbox: { west: 18.2, south: 49.78, east: 18.32, north: 49.85 },
      minZoom: 10,
      maxZoom: 13,
      createdAt: 1_700_000_000_000,
      ownerId: "rider-a",
    };
    store.getState().addRegion(spec, 6_001);
    store.getState().finishDownload(spec.id, {
      status: "failed",
      downloaded: 0,
      failed: 0,
      bytesOnDisk: 0,
      error: {
        code: "tile-cap-exceeded",
        limit: 5_000,
        count: 6_001,
      },
    });

    const reloadedStore = importOfflineStore();

    expect(reloadedStore.getState().getRegion(spec.id)?.lastError).toEqual({
      code: "tile-cap-exceeded",
      limit: 5_000,
      count: 6_001,
    });
  });
});

/**
 * #1279 — a pack's contents are shaped by its downloader's zoom cap, so the
 * device-global store has to say WHOSE each one is. Rows written before that
 * carry no owner; they are adopted rather than dropped, so an upgrading rider
 * keeps the downloads they already paid bandwidth for.
 */
describe("offline region ownership", () => {
  beforeEach(() => {
    mockMmkvStores.clear();
  });

  it("normalizes a row written before packs were attributed", () => {
    const legacy = persistedRegion();
    delete (legacy as { ownerId?: unknown }).ownerId;
    seedRegions([legacy]);

    const store = importOfflineStore();

    // Loaded, not dropped — and with one shape for readers to test against.
    expect(store.getState().regions).toHaveLength(1);
    expect(store.getState().regions[0]?.ownerId).toBeNull();
  });

  it("adopts unowned packs for the rider who signs in", () => {
    const legacy = persistedRegion();
    delete (legacy as { ownerId?: unknown }).ownerId;
    seedRegions([legacy]);
    const store = importOfflineStore();

    store.getState().adoptUnownedRegions("rider-a");

    expect(store.getState().regions[0]?.ownerId).toBe("rider-a");
    // Durable: a later rider must not inherit them on the next launch.
    expect(importOfflineStore().getState().regions[0]?.ownerId).toBe("rider-a");
  });

  it("never re-attributes a pack that already has an owner", () => {
    seedRegions([persistedRegion({ ownerId: "rider-a" })]);
    const store = importOfflineStore();

    store.getState().adoptUnownedRegions("rider-b");

    expect(store.getState().regions[0]?.ownerId).toBe("rider-a");
  });
});
