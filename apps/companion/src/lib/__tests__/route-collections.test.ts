import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_COLLECTION_DESCRIPTION_LENGTH,
  MAX_COLLECTION_NAME_LENGTH,
  addTripsToCollection,
  createCollection,
  loadCollections,
  removeCollection,
  removeTripFromCollection,
  saveCollections,
  sortCollectionsByName,
  storageKey,
  updateCollection,
  validateCollectionDescription,
  validateCollectionName,
  type StoredRouteCollection,
} from "../route-collections";

const USER = "user_123";

beforeEach(() => {
  window.localStorage.clear();
});

function makeCollection(
  overrides: Partial<StoredRouteCollection> = {},
): StoredRouteCollection {
  return {
    id: overrides.id ?? "col_1",
    name: overrides.name ?? "Beskydy Loops",
    description: overrides.description,
    isPublic: overrides.isPublic ?? false,
    tripIds: overrides.tripIds ?? [],
    createdAt: overrides.createdAt ?? "2026-04-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-04-01T00:00:00Z",
  };
}

describe("validateCollectionName", () => {
  it("rejects empty names", () => {
    expect(validateCollectionName("   ", [])).toMatch(/required/i);
  });

  it("rejects names over the length limit", () => {
    expect(
      validateCollectionName("a".repeat(MAX_COLLECTION_NAME_LENGTH + 1), []),
    ).toMatch(/characters or fewer/);
  });

  it("rejects duplicate names case-insensitively", () => {
    const existing = [makeCollection({ name: "Beskydy Loops" })];
    expect(validateCollectionName("beskydy loops", existing)).toMatch(
      /already exists/,
    );
  });

  it("allows re-saving the same collection when excludeId is set", () => {
    const existing = [makeCollection({ id: "col_1", name: "Beskydy Loops" })];
    expect(
      validateCollectionName("beskydy loops", existing, "col_1"),
    ).toBeNull();
  });

  it("accepts a valid, unique name", () => {
    expect(validateCollectionName("Alpine Passes", [])).toBeNull();
  });
});

describe("validateCollectionDescription", () => {
  it("passes when undefined, empty, or whitespace only", () => {
    expect(validateCollectionDescription(undefined)).toBeNull();
    expect(validateCollectionDescription("")).toBeNull();
    expect(validateCollectionDescription("   ")).toBeNull();
  });

  it("rejects descriptions over the length limit", () => {
    expect(
      validateCollectionDescription(
        "a".repeat(MAX_COLLECTION_DESCRIPTION_LENGTH + 1),
      ),
    ).toMatch(/characters or fewer/);
  });

  it("measures length after trimming so pad whitespace doesn't trip the limit", () => {
    // The stored description is trimmed, so a value that fits after trimming
    // must not be rejected even if the raw string overflows.
    const padded = `   ${"a".repeat(MAX_COLLECTION_DESCRIPTION_LENGTH)}   `;
    expect(validateCollectionDescription(padded)).toBeNull();
  });

  it("accepts a valid description", () => {
    expect(validateCollectionDescription("My favourite loops")).toBeNull();
  });
});

describe("createCollection", () => {
  it("trims whitespace, normalises empty description, stamps timestamps", () => {
    const now = new Date("2026-04-01T12:00:00Z");
    const collection = createCollection(
      { name: "  Beskydy  ", description: "   ", isPublic: true },
      now,
    );
    expect(collection.name).toBe("Beskydy");
    expect(collection.description).toBeUndefined();
    expect(collection.isPublic).toBe(true);
    expect(collection.tripIds).toEqual([]);
    expect(collection.createdAt).toBe(now.toISOString());
    expect(collection.updatedAt).toBe(now.toISOString());
    expect(collection.id).toMatch(/^col_/);
  });

  it("keeps a non-empty description", () => {
    const collection = createCollection({
      name: "Alps",
      description: "  Big mountains  ",
      isPublic: false,
    });
    expect(collection.description).toBe("Big mountains");
  });
});

describe("updateCollection", () => {
  it("updates only the targeted collection and bumps updatedAt", () => {
    const now = new Date("2026-04-02T12:00:00Z");
    const collections = [
      makeCollection({ id: "col_1", name: "Alps" }),
      makeCollection({ id: "col_2", name: "Iceland" }),
    ];
    const updated = updateCollection(
      collections,
      "col_1",
      { name: "Western Alps", description: "Favourites", isPublic: true },
      now,
    );
    expect(updated[0]?.name).toBe("Western Alps");
    expect(updated[0]?.description).toBe("Favourites");
    expect(updated[0]?.isPublic).toBe(true);
    expect(updated[0]?.updatedAt).toBe(now.toISOString());
    expect(updated[1]?.name).toBe("Iceland");
    expect(updated[1]?.updatedAt).toBe(collections[1]!.updatedAt);
  });

  it("clears description when given whitespace only", () => {
    const collections = [
      makeCollection({ id: "col_1", description: "Existing" }),
    ];
    const updated = updateCollection(collections, "col_1", {
      name: "Renamed",
      description: "   ",
      isPublic: false,
    });
    expect(updated[0]?.description).toBeUndefined();
  });
});

describe("removeCollection", () => {
  it("drops the collection with the given id", () => {
    const collections = [
      makeCollection({ id: "col_1" }),
      makeCollection({ id: "col_2" }),
    ];
    const updated = removeCollection(collections, "col_1");
    expect(updated.map((c) => c.id)).toEqual(["col_2"]);
  });
});

describe("addTripsToCollection", () => {
  it("appends trips and de-duplicates against existing ids", () => {
    const now = new Date("2026-04-03T12:00:00Z");
    const collections = [makeCollection({ id: "col_1", tripIds: ["trip_a"] })];
    const updated = addTripsToCollection(
      collections,
      "col_1",
      ["trip_a", "trip_b", "trip_c", "trip_b"],
      now,
    );
    expect(updated[0]?.tripIds).toEqual(["trip_a", "trip_b", "trip_c"]);
    expect(updated[0]?.updatedAt).toBe(now.toISOString());
  });

  it("does not bump updatedAt when nothing new was added", () => {
    const collections = [
      makeCollection({
        id: "col_1",
        tripIds: ["trip_a"],
        updatedAt: "2026-04-01T00:00:00Z",
      }),
    ];
    const updated = addTripsToCollection(collections, "col_1", ["trip_a"]);
    expect(updated[0]?.updatedAt).toBe("2026-04-01T00:00:00Z");
  });
});

describe("removeTripFromCollection", () => {
  it("removes a trip id and bumps updatedAt", () => {
    const now = new Date("2026-04-04T12:00:00Z");
    const collections = [
      makeCollection({ id: "col_1", tripIds: ["trip_a", "trip_b"] }),
    ];
    const updated = removeTripFromCollection(
      collections,
      "col_1",
      "trip_a",
      now,
    );
    expect(updated[0]?.tripIds).toEqual(["trip_b"]);
    expect(updated[0]?.updatedAt).toBe(now.toISOString());
  });

  it("is a no-op when the trip isn't in the collection", () => {
    const collections = [
      makeCollection({
        id: "col_1",
        tripIds: ["trip_a"],
        updatedAt: "2026-04-01T00:00:00Z",
      }),
    ];
    const updated = removeTripFromCollection(collections, "col_1", "trip_x");
    expect(updated[0]?.tripIds).toEqual(["trip_a"]);
    expect(updated[0]?.updatedAt).toBe("2026-04-01T00:00:00Z");
  });
});

describe("sortCollectionsByName", () => {
  it("sorts case-insensitively by name", () => {
    const collections = [
      makeCollection({ id: "b", name: "beskydy" }),
      makeCollection({ id: "a", name: "Alps" }),
      makeCollection({ id: "c", name: "Carpathians" }),
    ];
    const sorted = sortCollectionsByName(collections);
    expect(sorted.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});

describe("localStorage round-trip", () => {
  it("saves and loads collections scoped by user id", () => {
    const collections = [
      makeCollection({ id: "col_1", name: "Alps 2026", isPublic: true }),
    ];
    saveCollections(USER, collections);
    expect(loadCollections(USER)).toEqual(collections);
    expect(window.localStorage.getItem(storageKey(USER))).toBeTruthy();
  });

  it("returns an empty array when the storage entry is missing", () => {
    expect(loadCollections("never-saved")).toEqual([]);
  });

  it("ignores malformed storage payloads", () => {
    window.localStorage.setItem(storageKey(USER), "not json");
    expect(loadCollections(USER)).toEqual([]);

    window.localStorage.setItem(
      storageKey(USER),
      JSON.stringify([{ id: 123, name: "bad" }]),
    );
    expect(loadCollections(USER)).toEqual([]);
  });

  it("drops entries with non-string tripIds", () => {
    window.localStorage.setItem(
      storageKey(USER),
      JSON.stringify([
        {
          id: "col_1",
          name: "bad trips",
          isPublic: false,
          tripIds: ["ok", 42],
          createdAt: "2026-04-01T00:00:00Z",
          updatedAt: "2026-04-01T00:00:00Z",
        },
      ]),
    );
    expect(loadCollections(USER)).toEqual([]);
  });

  it("isolates storage between users", () => {
    saveCollections("user-a", [makeCollection({ id: "col_a" })]);
    saveCollections("user-b", [makeCollection({ id: "col_b" })]);
    expect(loadCollections("user-a").map((c) => c.id)).toEqual(["col_a"]);
    expect(loadCollections("user-b").map((c) => c.id)).toEqual(["col_b"]);
  });
});
