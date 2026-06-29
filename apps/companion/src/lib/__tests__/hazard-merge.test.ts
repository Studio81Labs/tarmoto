import { describe, expect, it } from "vitest";
import type { HazardResponse } from "@/lib/api";
import {
  applyHazardWsEvent,
  mergeHazardsWithInFlightWsArrivals,
} from "../hazard-merge";

function hazard(id: string): HazardResponse {
  return {
    id,
    lat: 49.82,
    lng: 18.26,
    hazard_type: "pothole",
    severity: "medium",
    note: null,
    photo_url: null,
    confirmations: 0,
    reporter: null,
    road_name: null,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

describe("applyHazardWsEvent", () => {
  it("appends a normal hazard not yet in the list", () => {
    const result = applyHazardWsEvent([hazard("a")], hazard("b"));
    expect(result.action).toBe("append");
    if (result.action === "append") {
      expect(result.list.map((h) => h.id)).toEqual(["a", "b"]);
    }
  });

  it("ignores a normal hazard already in the list (deduplicate)", () => {
    const result = applyHazardWsEvent([hazard("a"), hazard("b")], hazard("a"));
    expect(result.action).toBe("ignore");
  });

  it("removes a dismissed hazard that is present in the list", () => {
    const dismissed = { ...hazard("a"), severity: "dismissed" };
    const result = applyHazardWsEvent([hazard("a"), hazard("b")], dismissed);
    expect(result.action).toBe("remove");
    if (result.action === "remove") {
      expect(result.list.map((h) => h.id)).toEqual(["b"]);
    }
  });

  it("ignores a dismissed event for a hazard NOT in the list", () => {
    const dismissed = { ...hazard("x"), severity: "dismissed" };
    const result = applyHazardWsEvent([hazard("a"), hazard("b")], dismissed);
    expect(result.action).toBe("ignore");
  });

  it("ignores a dismissed event when the list is empty", () => {
    const dismissed = { ...hazard("a"), severity: "dismissed" };
    const result = applyHazardWsEvent([], dismissed);
    expect(result.action).toBe("ignore");
  });
});

describe("mergeHazardsWithInFlightWsArrivals", () => {
  it("returns REST result verbatim when nothing arrived via WebSocket", () => {
    const wsArrivalAt = new Map<string, number>();
    const rest = [hazard("a"), hazard("b")];
    const merged = mergeHazardsWithInFlightWsArrivals(rest, [], wsArrivalAt, 0);
    expect(merged.map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("preserves WS arrivals that landed after the fetch started and aren't in REST", () => {
    const fetchStartedAt = 1_000;
    const wsArrivalAt = new Map<string, number>([["ws-late", 1_500]]);
    const current = [hazard("ws-late")];
    const restResult = [hazard("rest-1")];

    const merged = mergeHazardsWithInFlightWsArrivals(
      restResult,
      current,
      wsArrivalAt,
      fetchStartedAt,
    );

    expect(merged.map((h) => h.id)).toEqual(["rest-1", "ws-late"]);
  });

  it("drops WS arrivals that predate the fetch — REST is authoritative for those", () => {
    const fetchStartedAt = 1_000;
    const wsArrivalAt = new Map<string, number>([["ws-stale", 500]]);
    const current = [hazard("ws-stale")];
    const restResult = [hazard("rest-1")];

    const merged = mergeHazardsWithInFlightWsArrivals(
      restResult,
      current,
      wsArrivalAt,
      fetchStartedAt,
    );

    expect(merged.map((h) => h.id)).toEqual(["rest-1"]);
  });

  it("does not re-preserve a WS arrival once REST covers it", () => {
    const fetchStartedAt = 1_000;
    const wsArrivalAt = new Map<string, number>([["ws-1", 1_500]]);
    const current = [hazard("ws-1")];
    const restResult = [hazard("ws-1")];

    const merged = mergeHazardsWithInFlightWsArrivals(
      restResult,
      current,
      wsArrivalAt,
      fetchStartedAt,
    );

    // Present once (from REST), and the arrival entry is cleared so a
    // later REST that no longer returns it won't re-preserve it.
    expect(merged.map((h) => h.id)).toEqual(["ws-1"]);
    expect(wsArrivalAt.has("ws-1")).toBe(false);
  });

  it("ignores ref entries without a WS arrival timestamp", () => {
    const fetchStartedAt = 1_000;
    const wsArrivalAt = new Map<string, number>();
    const current = [hazard("orphan")];
    const restResult = [hazard("rest-1")];

    const merged = mergeHazardsWithInFlightWsArrivals(
      restResult,
      current,
      wsArrivalAt,
      fetchStartedAt,
    );

    expect(merged.map((h) => h.id)).toEqual(["rest-1"]);
  });
});
