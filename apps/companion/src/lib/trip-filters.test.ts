import { describe, it, expect } from "vitest";
import { countOpenOwnedTrips } from "./trip-filters";
import type { TripSummary } from "@/lib/types";

const trip = (over: Partial<TripSummary>): TripSummary =>
  ({ id: "t", status: "draft", owner_id: "me", ...over }) as TripSummary;

describe("countOpenOwnedTrips", () => {
  it("counts owner-held draft/planned/active trips only", () => {
    const trips = [
      trip({ id: "a", status: "draft", owner_id: "me" }),
      trip({ id: "b", status: "planned", owner_id: "me" }),
      trip({ id: "c", status: "active", owner_id: "me" }),
      trip({ id: "d", status: "completed", owner_id: "me" }), // excluded
      trip({ id: "e", status: "draft", owner_id: "other" }), // not owner
    ];
    expect(countOpenOwnedTrips(trips, "me")).toBe(3);
  });
  it("returns 0 with no user", () => {
    expect(countOpenOwnedTrips([trip({})], null)).toBe(0);
  });
});
