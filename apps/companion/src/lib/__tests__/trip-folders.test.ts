import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_FOLDER_NAME_LENGTH,
  clearLegacyFolders,
  legacyStorageKey,
  migrateLegacyFolders,
  readLegacyFolders,
  sortFoldersForDisplay,
  validateFolderName,
  type LegacyTripFolder,
  type TripFolder,
} from "../trip-folders";

const USER = "user_123";

vi.mock("@/lib/api", () => ({
  tripFoldersApi: {
    create: vi.fn(),
  },
}));

import { tripFoldersApi } from "@/lib/api";

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(tripFoldersApi.create).mockReset();
});

afterEach(() => {
  window.localStorage.clear();
});

function makeFolder(overrides: Partial<TripFolder> = {}): TripFolder {
  return {
    id: overrides.id ?? "11111111-1111-1111-1111-111111111111",
    user_id: overrides.user_id ?? USER,
    name: overrides.name ?? "Alps 2026",
    color: overrides.color ?? null,
    position: overrides.position ?? 0,
    created_at: overrides.created_at ?? "2026-04-01T00:00:00Z",
    updated_at: overrides.updated_at ?? "2026-04-01T00:00:00Z",
  };
}

function makeLegacyFolder(
  overrides: Partial<LegacyTripFolder> = {},
): LegacyTripFolder {
  return {
    id: overrides.id ?? "fld_legacy_1",
    name: overrides.name ?? "Summer Alps",
    createdAt: overrides.createdAt ?? "2026-04-01T00:00:00Z",
  };
}

describe("validateFolderName", () => {
  it("rejects empty names", () => {
    expect(validateFolderName("   ", [])).toMatch(/required/i);
  });

  it("rejects names over the length limit", () => {
    expect(
      validateFolderName("a".repeat(MAX_FOLDER_NAME_LENGTH + 1), []),
    ).toMatch(/characters or fewer/);
  });

  it("rejects duplicate names case-insensitively", () => {
    const existing = [makeFolder({ name: "Alps 2026" })];
    expect(validateFolderName("alps 2026", existing)).toMatch(/already exists/);
  });

  it("allows re-saving the same folder when excludeId is set", () => {
    const existing = [makeFolder({ id: "id-1", name: "Alps 2026" })];
    expect(validateFolderName("alps 2026", existing, "id-1")).toBeNull();
  });

  it("accepts a valid, unique name", () => {
    expect(validateFolderName("Iceland Ring", [])).toBeNull();
  });
});

describe("sortFoldersForDisplay", () => {
  it("sorts by position, then by name as a stable tiebreaker", () => {
    const folders = [
      makeFolder({ id: "b", name: "beskydy", position: 1 }),
      makeFolder({ id: "a", name: "Alps", position: 0 }),
      makeFolder({ id: "c", name: "Carpathians", position: 1 }),
    ];
    const sorted = sortFoldersForDisplay(folders);
    expect(sorted.map((f) => f.id)).toEqual(["a", "b", "c"]);
  });
});

describe("readLegacyFolders / clearLegacyFolders", () => {
  it("reads pre-existing localStorage rows for the given user", () => {
    const legacy = [makeLegacyFolder({ id: "fld_old", name: "Old folder" })];
    window.localStorage.setItem(legacyStorageKey(USER), JSON.stringify(legacy));
    expect(readLegacyFolders(USER)).toEqual(legacy);
  });

  it("returns an empty array when the storage entry is missing", () => {
    expect(readLegacyFolders("never-saved")).toEqual([]);
  });

  it("ignores malformed storage payloads", () => {
    window.localStorage.setItem(legacyStorageKey(USER), "not json");
    expect(readLegacyFolders(USER)).toEqual([]);

    window.localStorage.setItem(
      legacyStorageKey(USER),
      JSON.stringify([{ id: 123, name: "bad" }]),
    );
    expect(readLegacyFolders(USER)).toEqual([]);
  });

  it("clears the legacy entry and stamps the migrated flag", () => {
    window.localStorage.setItem(
      legacyStorageKey(USER),
      JSON.stringify([makeLegacyFolder()]),
    );
    clearLegacyFolders(USER);
    expect(window.localStorage.getItem(legacyStorageKey(USER))).toBeNull();
    expect(
      window.localStorage.getItem(`tarmoto:trip-folders-migrated:${USER}`),
    ).toBe("1");
  });
});

describe("migrateLegacyFolders", () => {
  it("posts each legacy folder to the API and clears localStorage on success", async () => {
    const legacy = [
      makeLegacyFolder({ id: "fld_a", name: "Summer Alps" }),
      makeLegacyFolder({ id: "fld_b", name: "Weekend Beskydy" }),
    ];
    window.localStorage.setItem(legacyStorageKey(USER), JSON.stringify(legacy));
    vi.mocked(tripFoldersApi.create).mockResolvedValue({
      data: makeFolder(),
    });

    const result = await migrateLegacyFolders(USER, []);

    expect(result).toEqual({ attempted: 2, succeeded: 2 });
    expect(tripFoldersApi.create).toHaveBeenCalledTimes(2);
    // Clearing localStorage on full success is what makes the migration
    // idempotent — subsequent loads short-circuit on the migrated flag.
    expect(window.localStorage.getItem(legacyStorageKey(USER))).toBeNull();
  });

  it("skips folders whose name already exists on the server (case-insensitive)", async () => {
    const legacy = [
      makeLegacyFolder({ id: "fld_a", name: "Summer Alps" }),
      makeLegacyFolder({ id: "fld_b", name: "Weekend Beskydy" }),
    ];
    window.localStorage.setItem(legacyStorageKey(USER), JSON.stringify(legacy));

    const server = [makeFolder({ name: "summer alps" })];
    vi.mocked(tripFoldersApi.create).mockResolvedValue({
      data: makeFolder(),
    });

    const result = await migrateLegacyFolders(USER, server);

    expect(result).toEqual({ attempted: 1, succeeded: 1 });
    expect(tripFoldersApi.create).toHaveBeenCalledTimes(1);
    expect(tripFoldersApi.create).toHaveBeenCalledWith({
      name: "Weekend Beskydy",
    });
  });

  it("does not clear localStorage when not all rows succeeded (so the next run retries)", async () => {
    const legacy = [
      makeLegacyFolder({ id: "fld_a", name: "Summer Alps" }),
      makeLegacyFolder({ id: "fld_b", name: "Weekend Beskydy" }),
    ];
    window.localStorage.setItem(legacyStorageKey(USER), JSON.stringify(legacy));

    vi.mocked(tripFoldersApi.create)
      .mockResolvedValueOnce({ data: makeFolder() })
      .mockRejectedValueOnce(new Error("network"));

    const result = await migrateLegacyFolders(USER, []);

    expect(result).toEqual({ attempted: 2, succeeded: 1 });
    // Local rows remain so the next load picks up the unmigrated names.
    expect(window.localStorage.getItem(legacyStorageKey(USER))).not.toBeNull();
  });

  it("returns null when the user has no legacy rows to migrate", async () => {
    const result = await migrateLegacyFolders(USER, []);
    expect(result).toBeNull();
    expect(tripFoldersApi.create).not.toHaveBeenCalled();
  });

  it("short-circuits once the migration flag is set", async () => {
    window.localStorage.setItem(
      legacyStorageKey(USER),
      JSON.stringify([makeLegacyFolder()]),
    );
    window.localStorage.setItem(`tarmoto:trip-folders-migrated:${USER}`, "1");

    const result = await migrateLegacyFolders(USER, []);

    expect(result).toBeNull();
    expect(tripFoldersApi.create).not.toHaveBeenCalled();
  });
});
