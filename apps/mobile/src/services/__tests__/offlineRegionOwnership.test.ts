/**
 * Offline packs are scoped to the rider who downloaded them (#1279).
 *
 * Since tile fetches carry identity, a pack's CONTENTS are shaped by its
 * downloader's `road_quality_max_zoom` — deep-zoom quality for a paying rider,
 * clamped empties for a free one. The store is device-global and survives
 * sign-out, so an unattributed pack would let a second rider on the same device
 * read straight past their own clamp.
 */

import { isRegionUsableBy } from "../offlineRegions";

describe("isRegionUsableBy", () => {
  it("lets a rider use their own pack", () => {
    expect(isRegionUsableBy({ ownerId: "rider-a" }, "rider-a")).toBe(true);
  });

  it("keeps another rider's pack out of reach", () => {
    expect(isRegionUsableBy({ ownerId: "rider-a" }, "rider-b")).toBe(false);
  });

  it("keeps an owned pack out of reach while signed out", () => {
    // Fail closed: no session, no attribution, no read.
    expect(isRegionUsableBy({ ownerId: "rider-a" }, null)).toBe(false);
  });

  it("still allows a pack from before packs were attributed", () => {
    // Excluding these would delete working offline maps out from under every
    // rider who upgrades. They are adopted on first sign-in instead — see the
    // store's `adoptUnownedRegions`.
    expect(isRegionUsableBy({ ownerId: null }, "rider-a")).toBe(true);
    expect(isRegionUsableBy({ ownerId: null }, null)).toBe(true);
  });
});
