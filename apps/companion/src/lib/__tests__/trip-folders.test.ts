import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_FOLDER_NAME_LENGTH,
  createFolder,
  loadFolders,
  removeFolder,
  renameFolder,
  saveFolders,
  sortFoldersByName,
  storageKey,
  validateFolderName,
  type TripFolder,
} from "../trip-folders";

const USER = "user_123";

beforeEach(() => {
  window.localStorage.clear();
});

function makeFolder(overrides: Partial<TripFolder> = {}): TripFolder {
  return {
    id: overrides.id ?? "fld_1",
    name: overrides.name ?? "Alps 2026",
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
    const existing = [makeFolder({ id: "fld_1", name: "Alps 2026" })];
    expect(validateFolderName("alps 2026", existing, "fld_1")).toBeNull();
  });

  it("accepts a valid, unique name", () => {
    expect(validateFolderName("Iceland Ring", [])).toBeNull();
  });
});

describe("createFolder", () => {
  it("trims whitespace and stamps createdAt", () => {
    const now = new Date("2026-04-01T12:00:00Z");
    const folder = createFolder("  Summer 2026 Alps  ", now);
    expect(folder.name).toBe("Summer 2026 Alps");
    expect(folder.createdAt).toBe(now.toISOString());
    expect(folder.id).toMatch(/^fld_/);
  });
});

describe("renameFolder", () => {
  it("updates only the targeted folder and trims whitespace", () => {
    const folders = [
      makeFolder({ id: "fld_1", name: "Alps" }),
      makeFolder({ id: "fld_2", name: "Iceland" }),
    ];
    const updated = renameFolder(folders, "fld_1", "  Western Alps  ");
    expect(updated[0]?.name).toBe("Western Alps");
    expect(updated[1]?.name).toBe("Iceland");
  });
});

describe("removeFolder", () => {
  it("drops the folder with the given id", () => {
    const folders = [makeFolder({ id: "fld_1" }), makeFolder({ id: "fld_2" })];
    const updated = removeFolder(folders, "fld_1");
    expect(updated.map((f) => f.id)).toEqual(["fld_2"]);
  });
});

describe("sortFoldersByName", () => {
  it("sorts case-insensitively by name", () => {
    const folders = [
      makeFolder({ id: "b", name: "beskydy" }),
      makeFolder({ id: "a", name: "Alps" }),
      makeFolder({ id: "c", name: "Carpathians" }),
    ];
    const sorted = sortFoldersByName(folders);
    expect(sorted.map((f) => f.id)).toEqual(["a", "b", "c"]);
  });
});

describe("localStorage round-trip", () => {
  it("saves and loads folders scoped by user id", () => {
    const folders = [makeFolder({ id: "fld_1", name: "Alps 2026" })];
    saveFolders(USER, folders);
    expect(loadFolders(USER)).toEqual(folders);
    expect(window.localStorage.getItem(storageKey(USER))).toBeTruthy();
  });

  it("returns an empty array when the storage entry is missing", () => {
    expect(loadFolders("never-saved")).toEqual([]);
  });

  it("ignores malformed storage payloads", () => {
    window.localStorage.setItem(storageKey(USER), "not json");
    expect(loadFolders(USER)).toEqual([]);

    window.localStorage.setItem(
      storageKey(USER),
      JSON.stringify([{ id: 123, name: "bad" }]),
    );
    expect(loadFolders(USER)).toEqual([]);
  });

  it("isolates storage between users", () => {
    saveFolders("user-a", [makeFolder({ id: "fld_a" })]);
    saveFolders("user-b", [makeFolder({ id: "fld_b" })]);
    expect(loadFolders("user-a").map((f) => f.id)).toEqual(["fld_a"]);
    expect(loadFolders("user-b").map((f) => f.id)).toEqual(["fld_b"]);
  });
});
