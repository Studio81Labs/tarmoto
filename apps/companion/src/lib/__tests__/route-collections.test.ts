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
    follower_count: 0,
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

const rideItem = (overrides: Partial<RouteCollectionItemResponse> = {}) => ({
  id: "item-ride",
  ride_id: "22222222-2222-2222-2222-222222222222",
  position: 1,
  created_at: "2026-04-15T10:01:00.000Z",
  ...overrides,
});

describe("mapDetailToView", () => {
  it("maps ride items into the ride ref list", () => {
    const view = mapDetailToView(
      detail([rideItem({ id: "i-r", position: 1 })]),
    );

    expect(view.rideRefs).toHaveLength(1);
    expect(view.rideRefs[0]).toMatchObject({
      itemId: "i-r",
      position: 1,
      rideId: "22222222-2222-2222-2222-222222222222",
    });
    expect(view.rideIds).toEqual(["22222222-2222-2222-2222-222222222222"]);
  });

  it("orders the ride ref list by position even when items arrive out of order", () => {
    const view = mapDetailToView(
      detail([
        rideItem({
          id: "i-r2",
          ride_id: "22222222-2222-2222-2222-222222222002",
          position: 3,
        }),
        rideItem({
          id: "i-r1",
          ride_id: "22222222-2222-2222-2222-222222222001",
          position: 1,
        }),
      ]),
    );

    expect(view.rideIds).toEqual([
      "22222222-2222-2222-2222-222222222001",
      "22222222-2222-2222-2222-222222222002",
    ]);
  });

  it("preserves item_count from the server even if it disagrees with items.length", () => {
    // `item_count` is the server's authoritative count (used by the listing
    // page summary). We must not silently overwrite it with the client-side
    // length — when the two diverge the user typically wants the server's
    // version surfaced.
    const view = mapDetailToView(detail([rideItem()], { item_count: 99 }));
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
  it("emits the ride item ids in current view order", () => {
    const view = mapDetailToView(
      detail([
        rideItem({ id: "r-1", position: 0 }),
        rideItem({
          id: "r-2",
          ride_id: "22222222-2222-2222-2222-222222222002",
          position: 1,
        }),
      ]),
    );
    expect(reorderPayload(view)).toEqual(["r-1", "r-2"]);
  });

  it("reflects an in-place swap in the payload order", () => {
    const view = mapDetailToView(
      detail([
        rideItem({ id: "r-1", position: 0 }),
        rideItem({
          id: "r-2",
          ride_id: "22222222-2222-2222-2222-222222222002",
          position: 1,
        }),
      ]),
    );
    const swapped = {
      ...view,
      rideRefs: [view.rideRefs[1]!, view.rideRefs[0]!],
    };
    expect(reorderPayload(swapped)).toEqual(["r-2", "r-1"]);
  });
});

describe("mapSummaryToView", () => {
  it("seeds an empty ride ref list", () => {
    const view = mapSummaryToView(summary({ item_count: 4 }));
    expect(view.rideRefs).toEqual([]);
    expect(view.rideIds).toEqual([]);
    // The list endpoint doesn't return per-item rows, so the count is the
    // only signal we have for "non-empty" badges. Verify it round-trips.
    expect(view.itemCount).toBe(4);
  });
});
