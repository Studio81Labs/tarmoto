import { describe, it, expect } from "vitest";
import { ridesWithinDays } from "./utils";

describe("ridesWithinDays", () => {
  // Fixed "now" so the window boundary is deterministic.
  const now = new Date("2026-06-04T00:00:00Z").getTime();
  const ride = (started_at: string) => ({ id: started_at, started_at });

  it("keeps rides inside the window and drops older ones, preserving order", () => {
    const rides = [
      ride("2026-06-03T12:00:00Z"), // 1 day ago — in
      ride("2026-05-20T00:00:00Z"), // 15 days ago — in
      ride("2026-04-01T00:00:00Z"), // ~64 days ago — out
    ];
    const result = ridesWithinDays(rides, 30, now);
    expect(result.map((r) => r.id)).toEqual([
      "2026-06-03T12:00:00Z",
      "2026-05-20T00:00:00Z",
    ]);
  });

  it("includes a ride exactly on the boundary", () => {
    const exactly30dAgo = new Date(
      now - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(ridesWithinDays([ride(exactly30dAgo)], 30, now)).toHaveLength(1);
  });

  it("excludes future-dated rides (clock skew / GPX import)", () => {
    const tomorrow = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    const today = new Date(now - 60 * 60 * 1000).toISOString(); // 1h ago
    const result = ridesWithinDays([ride(tomorrow), ride(today)], 30, now);
    expect(result.map((r) => r.id)).toEqual([today]);
  });

  it("returns empty when every ride predates the window", () => {
    expect(ridesWithinDays([ride("2026-01-01T00:00:00Z")], 30, now)).toEqual(
      [],
    );
  });

  it("returns empty for an empty input", () => {
    expect(ridesWithinDays([], 30, now)).toEqual([]);
  });
});
