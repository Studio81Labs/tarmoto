import { describe, expect, it, vi } from "vitest";
import {
  legacyStorageKey,
  migrateLegacyCollections,
  migrationDoneKey,
  readLegacyCollections,
  validateCollectionName,
  type LegacyStoredRouteCollection,
} from "@/lib/route-collections";
import type { RouteCollectionDetail } from "@/lib/api";

function makeMemoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) ?? null) : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    snapshot: () => Object.fromEntries(map),
  };
}

function legacy(
  over: Partial<LegacyStoredRouteCollection> = {},
): LegacyStoredRouteCollection {
  return {
    id: "col_legacy_1",
    name: "Beskydy Loops",
    description: "Sunday rides",
    isPublic: false,
    tripIds: ["trip-1", "trip-2"],
    createdAt: "2026-04-01T10:00:00.000Z",
    updatedAt: "2026-04-15T10:00:00.000Z",
    ...over,
  };
}

function detail(
  over: Partial<RouteCollectionDetail> = {},
): RouteCollectionDetail {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    owner_id: "user-1",
    title: "Beskydy Loops",
    description: "Sunday rides",
    visibility: "private",
    slug: "abcDEF12345",
    item_count: 2,
    items: [
      {
        id: "item-1",
        trip_id: "trip-1",
        ride_id: null,
        position: 0,
        created_at: "2026-04-15T10:00:00.000Z",
      },
      {
        id: "item-2",
        trip_id: "trip-2",
        ride_id: null,
        position: 1,
        created_at: "2026-04-15T10:01:00.000Z",
      },
    ],
    owner_name: "Jane Rider",
    viewer_is_owner: true,
    viewer_is_following: false,
    created_at: "2026-04-15T10:00:00.000Z",
    updated_at: "2026-04-15T10:00:00.000Z",
    ...over,
  };
}

function makeMockClient() {
  return {
    listMine: vi.fn(),
    listLibrary: vi.fn(),
    create: vi.fn().mockResolvedValue({ data: detail() }),
    get: vi.fn().mockResolvedValue({ data: detail() }),
    getBySlug: vi.fn(),
    getPreviewBySlug: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    follow: vi.fn(),
    unfollow: vi.fn(),
    addItem: vi.fn().mockResolvedValue({
      data: {
        id: "item-new",
        trip_id: "trip-1",
        ride_id: null,
        position: 0,
        created_at: "2026-04-15T10:00:00.000Z",
      },
    }),
    removeItem: vi.fn(),
    reorderItems: vi.fn(),
  };
}

describe("readLegacyCollections", () => {
  it("returns empty when storage is empty", () => {
    const storage = makeMemoryStorage();
    expect(readLegacyCollections("user-1", storage)).toEqual([]);
  });

  it("filters out malformed entries", () => {
    const storage = makeMemoryStorage({
      [legacyStorageKey("user-1")]: JSON.stringify([
        legacy(),
        { id: "bogus" },
        { ...legacy(), tripIds: "not-an-array" },
      ]),
    });
    const result = readLegacyCollections("user-1", storage);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("col_legacy_1");
  });

  it("returns empty when JSON is unparseable", () => {
    const storage = makeMemoryStorage({
      [legacyStorageKey("user-1")]: "{not-json",
    });
    expect(readLegacyCollections("user-1", storage)).toEqual([]);
  });
});

describe("migrateLegacyCollections", () => {
  it("does nothing when no legacy data exists, but marks migration done", async () => {
    const storage = makeMemoryStorage();
    const client = makeMockClient();
    const result = await migrateLegacyCollections("user-1", {
      storage,
      client,
    });
    expect(result.attempted).toBe(0);
    expect(client.create).not.toHaveBeenCalled();
    // Empty case still marks done so we don't re-prompt.
    expect(storage.snapshot()[migrationDoneKey("user-1")]).toBe("1");
  });

  it("creates one collection per legacy row and adds each tripId", async () => {
    const storage = makeMemoryStorage({
      [legacyStorageKey("user-1")]: JSON.stringify([
        legacy({ id: "col_a", name: "A", tripIds: ["trip-1"] }),
        legacy({
          id: "col_b",
          name: "B",
          isPublic: true,
          tripIds: ["trip-2", "trip-3"],
        }),
      ]),
    });
    const client = makeMockClient();
    client.create
      .mockResolvedValueOnce({ data: detail({ title: "A", slug: "slug-a" }) })
      .mockResolvedValueOnce({
        data: detail({ title: "B", slug: "slug-b", visibility: "unlisted" }),
      });

    const result = await migrateLegacyCollections("user-1", {
      storage,
      client,
    });

    expect(result.attempted).toBe(2);
    expect(result.migrated).toBe(2);
    expect(result.failed).toBe(0);

    expect(client.create).toHaveBeenCalledTimes(2);
    expect(client.create).toHaveBeenNthCalledWith(1, {
      title: "A",
      description: "Sunday rides",
      visibility: "private",
    });
    expect(client.create).toHaveBeenNthCalledWith(2, {
      title: "B",
      description: "Sunday rides",
      // Legacy `isPublic: true` maps to `unlisted` (least surprising — link
      // sharing was the original intent, not full public listing).
      visibility: "unlisted",
    });

    // 1 + 2 trip adds = 3 calls total.
    expect(client.addItem).toHaveBeenCalledTimes(3);
  });

  it("marks the legacy key as migrated and removes the old data", async () => {
    const storage = makeMemoryStorage({
      [legacyStorageKey("user-1")]: JSON.stringify([legacy()]),
    });
    const client = makeMockClient();
    await migrateLegacyCollections("user-1", { storage, client });
    const snap = storage.snapshot();
    expect(snap[legacyStorageKey("user-1")]).toBeUndefined();
    expect(snap[migrationDoneKey("user-1")]).toBe("1");
  });

  it("preserves legacy data when every collection fails to create (e.g. offline)", async () => {
    const storage = makeMemoryStorage({
      [legacyStorageKey("user-1")]: JSON.stringify([legacy()]),
    });
    const client = makeMockClient();
    client.create.mockRejectedValue(new Error("Network error"));
    const result = await migrateLegacyCollections("user-1", {
      storage,
      client,
    });
    expect(result.failed).toBe(1);
    expect(result.errorMessage).toBe("Network error");
    // Legacy data must remain so the user can retry next session.
    expect(storage.snapshot()[legacyStorageKey("user-1")]).toBeDefined();
    expect(storage.snapshot()[migrationDoneKey("user-1")]).toBeUndefined();
  });

  it("clears legacy data once at least one collection migrates successfully", async () => {
    const storage = makeMemoryStorage({
      [legacyStorageKey("user-1")]: JSON.stringify([
        legacy({ id: "col_a", name: "A" }),
        legacy({ id: "col_b", name: "B" }),
      ]),
    });
    const client = makeMockClient();
    client.create
      .mockResolvedValueOnce({ data: detail({ title: "A" }) })
      .mockRejectedValueOnce(new Error("Boom"));

    const result = await migrateLegacyCollections("user-1", {
      storage,
      client,
    });

    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(1);
    // First failure is surfaced; later identical errors are not.
    expect(result.errorMessage).toBe("Boom");
    expect(storage.snapshot()[legacyStorageKey("user-1")]).toBeUndefined();
  });

  it("continues when adding individual trip items fails", async () => {
    const storage = makeMemoryStorage({
      [legacyStorageKey("user-1")]: JSON.stringify([
        legacy({ tripIds: ["trip-1", "trip-2"] }),
      ]),
    });
    const client = makeMockClient();
    client.addItem
      .mockRejectedValueOnce(new Error("Trip 1 missing"))
      .mockResolvedValueOnce({
        data: {
          id: "item-2",
          trip_id: "trip-2",
          ride_id: null,
          position: 0,
          created_at: "2026-04-15T10:00:00.000Z",
        },
      });

    const result = await migrateLegacyCollections("user-1", {
      storage,
      client,
    });

    // Collection-level success isn't blocked by item-level failures.
    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.collections).toHaveLength(1);
  });

  it("truncates legacy names that exceed the new max length", async () => {
    const longName = "x".repeat(200);
    const storage = makeMemoryStorage({
      [legacyStorageKey("user-1")]: JSON.stringify([
        legacy({ name: longName }),
      ]),
    });
    const client = makeMockClient();
    await migrateLegacyCollections("user-1", { storage, client });
    const createArg = client.create.mock.calls[0]?.[0] as { title: string };
    expect(createArg.title.length).toBeLessThanOrEqual(80);
  });
});

// Smoke test for the renamed validator that the page imports — it now
// works against the server-shaped `RouteCollectionView` (which uses `title`,
// not `name`), so this guards against drift if either side changes.
describe("validateCollectionName", () => {
  it("rejects empty/whitespace names", () => {
    expect(validateCollectionName("   ", [])).toBe(
      "Collection name is required",
    );
  });

  it("rejects duplicates by case-insensitive title comparison", () => {
    const collections = [{ id: "c1", title: "Beskydy Loops" }];
    expect(validateCollectionName("beskydy loops", collections)).toBe(
      "A collection with that name already exists",
    );
  });

  it("allows the same name when excluding the matching id (rename case)", () => {
    const collections = [{ id: "c1", title: "Beskydy Loops" }];
    expect(
      validateCollectionName("Beskydy Loops", collections, "c1"),
    ).toBeNull();
  });

  it("rejects names longer than the limit", () => {
    expect(validateCollectionName("x".repeat(81), [])).toMatch(/80 characters/);
  });
});
