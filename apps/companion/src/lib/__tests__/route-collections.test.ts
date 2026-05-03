import { describe, expect, it } from "vitest";
import {
  mapDetailToView,
  mapSummaryToView,
  moveItem,
  reorderPayload,
} from "@/lib/route-collections";
import type {
  RouteCollectionDetail,
  RouteCollectionItemResponse,
  RouteCollectionSummary,
} from "@/lib/api";

function detail(
  items: RouteCollectionItemResponse[],
  over: Partial<RouteCollectionDetail> = {},
): RouteCollectionDetail {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    owner_id: "user-1",
    title: "Beskydy Loops",
    description: "Sunday rides",
    visibility: "private",
    slug: "abcDEF12345",
    item_count: items.length,
    items,
    owner_name: "Jane Rider",
    viewer_is_owner: true,
    viewer_is_following: false,
    created_at: "2026-04-15T10:00:00.000Z",
    updated_at: "2026-04-15T10:00:00.000Z",
    ...over,
  };
}

function summary(
  over: Partial<RouteCollectionSummary> = {},
): RouteCollectionSummary {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    owner_id: "user-1",
    title: "Summary",
    description: null,
    visibility: "private",
    slug: "abcDEF12345",
    item_count: 0,
    owner_name: null,
    created_at: "2026-04-15T10:00:00.000Z",
    updated_at: "2026-04-15T10:00:00.000Z",
    ...over,
  };
}

const tripItem = (overrides: Partial<RouteCollectionItemResponse> = {}) => ({
  id: "item-trip",
  trip_id: "11111111-1111-1111-1111-111111111111",
  ride_id: null,
  position: 0,
  created_at: "2026-04-15T10:00:00.000Z",
  ...overrides,
});

const rideItem = (overrides: Partial<RouteCollectionItemResponse> = {}) => ({
  id: "item-ride",
  trip_id: null,
  ride_id: "22222222-2222-2222-2222-222222222222",
  position: 1,
  created_at: "2026-04-15T10:01:00.000Z",
  ...overrides,
});

describe("mapDetailToView", () => {
  it("splits trip and ride items into separate ref lists", () => {
    const view = mapDetailToView(
      detail([
        tripItem({ id: "i-t", position: 0 }),
        rideItem({ id: "i-r", position: 1 }),
      ]),
    );

    expect(view.tripRefs).toHaveLength(1);
    expect(view.rideRefs).toHaveLength(1);
    expect(view.tripRefs[0]).toMatchObject({
      itemId: "i-t",
      position: 0,
      tripId: "11111111-1111-1111-1111-111111111111",
    });
    expect(view.rideRefs[0]).toMatchObject({
      itemId: "i-r",
      position: 1,
      rideId: "22222222-2222-2222-2222-222222222222",
    });
    expect(view.tripIds).toEqual(["11111111-1111-1111-1111-111111111111"]);
    expect(view.rideIds).toEqual(["22222222-2222-2222-2222-222222222222"]);
  });

  it("orders each ref list by position even when items arrive out of order", () => {
    const view = mapDetailToView(
      detail([
        rideItem({
          id: "i-r2",
          ride_id: "22222222-2222-2222-2222-222222222002",
          position: 3,
        }),
        tripItem({
          id: "i-t2",
          trip_id: "11111111-1111-1111-1111-111111111002",
          position: 2,
        }),
        rideItem({
          id: "i-r1",
          ride_id: "22222222-2222-2222-2222-222222222001",
          position: 1,
        }),
        tripItem({
          id: "i-t1",
          trip_id: "11111111-1111-1111-1111-111111111001",
          position: 0,
        }),
      ]),
    );

    expect(view.tripIds).toEqual([
      "11111111-1111-1111-1111-111111111001",
      "11111111-1111-1111-1111-111111111002",
    ]);
    expect(view.rideIds).toEqual([
      "22222222-2222-2222-2222-222222222001",
      "22222222-2222-2222-2222-222222222002",
    ]);
  });

  it("ignores rows with neither trip_id nor ride_id (DB CHECK should prevent these)", () => {
    // Defensive — a malformed row from a future migration shouldn't crash the
    // page; the view should just drop it from both lists.
    const view = mapDetailToView(
      detail([
        { ...tripItem({ id: "ok" }) },
        {
          id: "bogus",
          trip_id: null,
          ride_id: null,
          position: 5,
          created_at: "2026-04-15T10:05:00.000Z",
        },
      ]),
    );

    expect(view.tripRefs).toHaveLength(1);
    expect(view.rideRefs).toHaveLength(0);
  });

  it("preserves item_count from the server even if it disagrees with items.length", () => {
    // `item_count` is the server's authoritative count (used by the listing
    // page summary). We must not silently overwrite it with the client-side
    // length — when the two diverge the user typically wants the server's
    // version surfaced.
    const view = mapDetailToView(
      detail([tripItem(), rideItem()], { item_count: 99 }),
    );
    expect(view.itemCount).toBe(99);
  });
});

describe("moveItem", () => {
  it("moves an element forward and returns a new array", () => {
    const source = ["a", "b", "c", "d"];
    const result = moveItem(source, 0, 2);
    expect(result).toEqual(["b", "c", "a", "d"]);
    // Don't mutate the input — components hold the previous list in state
    // and would re-render incorrectly if the underlying array shifted.
    expect(source).toEqual(["a", "b", "c", "d"]);
  });

  it("moves an element backward", () => {
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("returns the same array reference for a no-op", () => {
    // Reference identity is the React contract: dnd-kit fires `onDragEnd`
    // on every drag, even when nothing moved (drop on the same row). The
    // page state setter is keyed on the array, so handing back the same
    // ref skips a render.
    const source = ["a", "b", "c"];
    expect(moveItem(source, 1, 1)).toBe(source);
    expect(moveItem(source, -1, 0)).toBe(source);
    expect(moveItem(source, 0, 5)).toBe(source);
  });
});

describe("reorderPayload", () => {
  it("emits trip ids first, then ride ids, in current view order", () => {
    // The owner page renders trips above rides; the public page renders by
    // raw position. Concatenating in [trips, rides] order is what makes
    // both views agree after a reorder.
    const view = mapDetailToView(
      detail([
        tripItem({ id: "t-1", position: 0 }),
        tripItem({
          id: "t-2",
          trip_id: "11111111-1111-1111-1111-111111111002",
          position: 1,
        }),
        rideItem({ id: "r-1", position: 2 }),
        rideItem({
          id: "r-2",
          ride_id: "22222222-2222-2222-2222-222222222002",
          position: 3,
        }),
      ]),
    );
    expect(reorderPayload(view)).toEqual(["t-1", "t-2", "r-1", "r-2"]);
  });

  it("reflects an in-place trip swap in the payload order", () => {
    const view = mapDetailToView(
      detail([
        tripItem({ id: "t-1", position: 0 }),
        tripItem({
          id: "t-2",
          trip_id: "11111111-1111-1111-1111-111111111002",
          position: 1,
        }),
        rideItem({ id: "r-1", position: 2 }),
      ]),
    );
    const swapped = {
      ...view,
      tripRefs: [view.tripRefs[1]!, view.tripRefs[0]!],
    };
    expect(reorderPayload(swapped)).toEqual(["t-2", "t-1", "r-1"]);
  });
});

describe("mapSummaryToView", () => {
  it("seeds empty trip and ride ref lists", () => {
    const view = mapSummaryToView(summary({ item_count: 4 }));
    expect(view.tripRefs).toEqual([]);
    expect(view.rideRefs).toEqual([]);
    expect(view.tripIds).toEqual([]);
    expect(view.rideIds).toEqual([]);
    // The list endpoint doesn't return per-item rows, so the count is the
    // only signal we have for "non-empty" badges. Verify it round-trips.
    expect(view.itemCount).toBe(4);
  });
});
