import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useClearStaleActiveTrip } from "./useClearStaleActiveTrip";
import { useTripStore } from "@/stores/trip";
import type { Trip } from "@/lib/types";

function savedTrip(): Trip {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    name: "Saved route",
    status: "planned",
    num_days: 1,
    createdAt: "2026-04-23T09:00:00Z",
    updatedAt: "2026-04-23T09:00:00Z",
    collaborators: [],
    parameters: {
      days: 1,
      dailyKmTarget: 250,
      roadPreference: "mixed",
      surfacePreference: ["asphalt"],
      avoidHighways: false,
      avoidTolls: false,
      avoidUnpaved: false,
      minQuality: 3,
    },
    days: [],
  };
}

describe("useClearStaleActiveTrip", () => {
  beforeEach(() => {
    useTripStore.getState().setActiveTrip(null);
  });

  it("clears a trip lingering in the planner store on mount", () => {
    useTripStore.getState().setActiveTrip(savedTrip());
    expect(useTripStore.getState().activeTrip).not.toBeNull();

    renderHook(() => useClearStaleActiveTrip());

    expect(useTripStore.getState().activeTrip).toBeNull();
  });

  it("is a no-op when the store is already empty", () => {
    renderHook(() => useClearStaleActiveTrip());
    expect(useTripStore.getState().activeTrip).toBeNull();
  });
});
