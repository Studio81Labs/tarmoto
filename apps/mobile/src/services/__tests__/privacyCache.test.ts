/**
 * Privacy preferences cache (#279 / #501).
 *
 * The cache is the synchronous source of truth the sensor uploader
 * consults before each upload. It defaults to canonical opt-IN
 * values when no row has landed yet (fresh install, MMKV cleared on
 * logout); after a successful refresh from `GET /account/privacy`
 * it returns the persisted toggles verbatim.
 */

import { DEFAULT_PRIVACY_PREFERENCES } from "@tarmoto/shared";
import {
  __setStorageForTest,
  canContributeRoadData,
  clearCachedPreferences,
  getCachedPreferences,
  setCachedPreferences,
} from "../privacyCache";

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

describe("privacyCache (#279 / #501)", () => {
  beforeEach(() => {
    __setStorageForTest(createMemoryStorage());
  });

  it("returns canonical defaults when no row has been persisted yet", () => {
    expect(getCachedPreferences()).toEqual(DEFAULT_PRIVACY_PREFERENCES);
    // Fresh install matches canonical opt-in — sensor uploads should
    // proceed until the rider explicitly opts out and we cache it.
    expect(canContributeRoadData()).toBe(true);
  });

  it("round-trips a cached row through set/get", () => {
    setCachedPreferences({
      ...DEFAULT_PRIVACY_PREFERENCES,
      profile_visibility: "private",
      road_data_contribution: false,
      analytics_consent: false,
    });

    const cached = getCachedPreferences();
    expect(cached.profile_visibility).toBe("private");
    expect(cached.road_data_contribution).toBe(false);
    expect(cached.analytics_consent).toBe(false);
  });

  it("canContributeRoadData reflects the persisted toggle", () => {
    setCachedPreferences({
      ...DEFAULT_PRIVACY_PREFERENCES,
      road_data_contribution: false,
    });
    expect(canContributeRoadData()).toBe(false);

    setCachedPreferences({
      ...DEFAULT_PRIVACY_PREFERENCES,
      road_data_contribution: true,
    });
    expect(canContributeRoadData()).toBe(true);
  });

  it("clearCachedPreferences resets reads to canonical defaults", () => {
    setCachedPreferences({
      ...DEFAULT_PRIVACY_PREFERENCES,
      road_data_contribution: false,
    });
    expect(canContributeRoadData()).toBe(false);

    clearCachedPreferences();

    expect(getCachedPreferences()).toEqual(DEFAULT_PRIVACY_PREFERENCES);
    expect(canContributeRoadData()).toBe(true);
  });

  it("falls back to defaults on a corrupt blob and drops the bad row", () => {
    const storage = createMemoryStorage();
    storage.set("preferences", "{not-json");
    __setStorageForTest(storage);

    expect(getCachedPreferences()).toEqual(DEFAULT_PRIVACY_PREFERENCES);
    // Bad blob should be evicted so the next read goes straight to
    // the default branch.
    expect(storage.raw.get("preferences")).toBeUndefined();
  });

  it("falls back to defaults on a wrong-shape blob (older schema)", () => {
    const storage = createMemoryStorage();
    storage.set("preferences", JSON.stringify({ road_data_contribution: 0 }));
    __setStorageForTest(storage);

    expect(getCachedPreferences()).toEqual(DEFAULT_PRIVACY_PREFERENCES);
  });
});
