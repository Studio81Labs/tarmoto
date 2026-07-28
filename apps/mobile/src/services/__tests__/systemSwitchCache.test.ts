/**
 * Operator system-switch cache.
 *
 * The synchronous source of truth the ride-start path consults before
 * spinning up the raw 50Hz accelerometer/gyro sampling. It fails SAFE:
 * every switch reads ENABLED until an operator `force_off` has been
 * pulled and cached, so a fresh install (or a cleared cache) never
 * disables a working subsystem just because it hasn't learned the
 * operator's state.
 */

import {
  __setStorageForTest,
  clearCachedSystemSwitchStates,
  getCachedSystemSwitchStates,
  isSystemSwitchEnabled,
  setCachedSystemSwitchStates,
} from "../systemSwitchCache";

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getString: (k: string) => store.get(k),
    set: (k: string, v: string) => {
      store.set(k, v);
    },
    remove: (k: string) => {
      store.delete(k);
    },
    raw: store,
  };
}

describe("systemSwitchCache", () => {
  beforeEach(() => {
    __setStorageForTest(createMemoryStorage());
  });

  it("returns an empty map and reads ENABLED when no row is persisted", () => {
    expect(getCachedSystemSwitchStates()).toEqual({});
    // Fail SAFE — a switch with no cached operator state defaults ON.
    expect(isSystemSwitchEnabled("sys_accel_collection")).toBe(true);
  });

  it("disables a switch the operator has force_off'd", () => {
    setCachedSystemSwitchStates({ sys_accel_collection: "force_off" });
    expect(isSystemSwitchEnabled("sys_accel_collection")).toBe(false);
    // Other switches stay ON — only the force_off'd key flips.
    expect(isSystemSwitchEnabled("sys_aerial_basemap")).toBe(true);
  });

  it("keeps a switch enabled on force_on and on absence", () => {
    setCachedSystemSwitchStates({ sys_accel_collection: "force_on" });
    expect(isSystemSwitchEnabled("sys_accel_collection")).toBe(true);

    setCachedSystemSwitchStates({});
    expect(isSystemSwitchEnabled("sys_accel_collection")).toBe(true);
  });

  it("round-trips a persisted override map through set/get", () => {
    setCachedSystemSwitchStates({
      sys_accel_collection: "force_off",
      sys_aerial_basemap: "force_on",
    });
    expect(getCachedSystemSwitchStates()).toEqual({
      sys_accel_collection: "force_off",
      sys_aerial_basemap: "force_on",
    });
  });

  it("clearCachedSystemSwitchStates resets reads to defaults (ON)", () => {
    setCachedSystemSwitchStates({ sys_accel_collection: "force_off" });
    expect(isSystemSwitchEnabled("sys_accel_collection")).toBe(false);

    clearCachedSystemSwitchStates();

    expect(getCachedSystemSwitchStates()).toEqual({});
    expect(isSystemSwitchEnabled("sys_accel_collection")).toBe(true);
  });

  it("fails safe on a corrupt blob and drops the bad row", () => {
    const storage = createMemoryStorage();
    storage.set("flags", "{not-json");
    __setStorageForTest(storage);

    expect(getCachedSystemSwitchStates()).toEqual({});
    // Bad blob evicted so the next read goes straight to the default branch.
    expect(storage.raw.get("flags")).toBeUndefined();
    expect(isSystemSwitchEnabled("sys_accel_collection")).toBe(true);
  });

  it("fails safe on a wrong-shape blob (unexpected state value)", () => {
    const storage = createMemoryStorage();
    storage.set("flags", JSON.stringify({ sys_accel_collection: "default" }));
    __setStorageForTest(storage);

    // "default" isn't a persisted override state — drop the whole map and
    // read ENABLED rather than trust a shape we don't recognise.
    expect(getCachedSystemSwitchStates()).toEqual({});
    expect(isSystemSwitchEnabled("sys_accel_collection")).toBe(true);
  });
});
