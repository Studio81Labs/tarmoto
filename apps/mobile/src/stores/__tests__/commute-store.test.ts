/**
 * Commute store — US-15 last-seen hazard tracking + diff helper.
 *
 * Focus: the diff returns IDs not yet acknowledged on that route, per-route
 * isolation of snapshots, and that `markHazardsSeen` subsequently dismisses
 * them. MMKV isn't linked in jest so persistence delegates to the in-memory
 * fallback — exercising only the logic the hook relies on.
 */

import { diffNewHazards, useCommuteStore } from "../index";

describe("diffNewHazards", () => {
  it("returns IDs that are in current but not in last-seen", () => {
    const seen = new Set(["a", "b"]);
    expect(diffNewHazards(["a", "b", "c"], seen)).toEqual(["c"]);
  });

  it("treats a missing hazard ID as already seen (not re-reported)", () => {
    // `a` was seen previously, it doesn't show up in `currentIds` — the
    // diff is bounded by currentIds, so this returns an empty list.
    const seen = new Set(["a"]);
    expect(diffNewHazards([], seen)).toEqual([]);
  });

  it("preserves input order", () => {
    const seen = new Set<string>();
    expect(diffNewHazards(["z", "y", "x"], seen)).toEqual(["z", "y", "x"]);
  });

  it("returns empty when every current hazard has been seen", () => {
    const seen = new Set(["a", "b", "c"]);
    expect(diffNewHazards(["b", "c"], seen)).toEqual([]);
  });
});

describe("useCommuteStore", () => {
  beforeEach(() => {
    useCommuteStore.setState({ seenHazardsByRoute: {} });
  });

  it("initially reports no seen hazards for a route", () => {
    const seen = useCommuteStore.getState().getSeenHazards("route-1");
    expect(seen.size).toBe(0);
  });

  it("markHazardsSeen replaces the set for that route", () => {
    useCommuteStore.getState().markHazardsSeen("route-1", ["h1", "h2"]);
    expect(
      Array.from(useCommuteStore.getState().getSeenHazards("route-1")),
    ).toEqual(["h1", "h2"]);

    useCommuteStore.getState().markHazardsSeen("route-1", ["h3"]);
    expect(
      Array.from(useCommuteStore.getState().getSeenHazards("route-1")),
    ).toEqual(["h3"]);
  });

  it("snapshots are isolated per route", () => {
    useCommuteStore.getState().markHazardsSeen("route-a", ["a1"]);
    useCommuteStore.getState().markHazardsSeen("route-b", ["b1", "b2"]);

    expect(
      Array.from(useCommuteStore.getState().getSeenHazards("route-a")),
    ).toEqual(["a1"]);
    expect(
      Array.from(useCommuteStore.getState().getSeenHazards("route-b")).sort(),
    ).toEqual(["b1", "b2"]);
  });

  it("after marking all current hazards seen, diff is empty", () => {
    const currentIds = ["h1", "h2", "h3"];
    useCommuteStore.getState().markHazardsSeen("r", currentIds);
    const seen = useCommuteStore.getState().getSeenHazards("r");
    expect(diffNewHazards(currentIds, seen)).toEqual([]);
  });

  it("a new hazard ID is flagged until explicitly acknowledged", () => {
    useCommuteStore.getState().markHazardsSeen("r", ["h1", "h2"]);
    const seenBefore = useCommuteStore.getState().getSeenHazards("r");
    expect(diffNewHazards(["h1", "h2", "h3"], seenBefore)).toEqual(["h3"]);

    useCommuteStore.getState().markHazardsSeen("r", ["h1", "h2", "h3"]);
    const seenAfter = useCommuteStore.getState().getSeenHazards("r");
    expect(diffNewHazards(["h1", "h2", "h3"], seenAfter)).toEqual([]);
  });

  it("clearRoute forgets a route's snapshot", () => {
    useCommuteStore.getState().markHazardsSeen("r", ["h1"]);
    useCommuteStore.getState().clearRoute("r");
    expect(useCommuteStore.getState().getSeenHazards("r").size).toBe(0);
  });
});
