/**
 * `sys_gamification` on the personal road map (#1170 C2).
 *
 * The registry scopes this switch to "badges, challenges, personal road map",
 * so exploration is part of it. With the subsystem off the backend answers the
 * exploration endpoints empty — so fetching would render "0% explored", a
 * number the rider reads as their own coverage rather than as a shutdown.
 *
 * Sharing is gated too: it MINTS and persists a coverage snapshot, which is
 * exactly the work the switch exists to stop, and the backend does not refuse
 * it yet (#1176).
 */
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// KEYED across both registries: this page reads the `road_quality_overlay`
// kill switch and the `sys_gamification` system switch, which have different
// blast radii. One boolean for both would let a gate on the wrong key pass
// (#1204).
const killSwitches = vi.hoisted(
  () => ({ road_quality_overlay: true }) as Record<string, boolean>,
);
const systemSwitches = vi.hoisted(
  () => ({ sys_gamification: true }) as Record<string, boolean>,
);
vi.mock("@/hooks/useEntitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useEntitlements")>()),
  useFeatureKillSwitch: (key: string) => ({
    enabled: killSwitches[key] ?? true,
    isResolved: true,
  }),
  useSystemSwitch: (key: string) => ({
    enabled: systemSwitches[key] ?? true,
    isResolved: true,
  }),
}));

const getStatsMock = vi.fn(async () => ({
  data: {
    ridden_segments: 4,
    total_segments: 10,
    percent_explored: 40,
    total_distance_km: 12,
  },
}));
// A ridden segment, so the page reaches its normal view (with the header and
// its Share button) rather than the empty state.
const getNearbyUnriddenMock = vi.fn(async () => ({ data: { segments: [] } }));
const getRiddenSegmentsMock = vi.fn(async () => ({
  data: {
    segments: [
      {
        id: "seg-1",
        last_ridden_at: new Date().toISOString(),
        last_quality_score: 4,
        ride_count: 2,
        geometry: {
          type: "LineString",
          coordinates: [
            [16.6, 49.2],
            [16.7, 49.3],
          ],
        },
      },
    ],
  },
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  explorationApi: {
    getStats: (...a: unknown[]) => getStatsMock(...(a as [])),
    getRiddenSegments: (...a: unknown[]) => getRiddenSegmentsMock(...(a as [])),
    getNearbyUnridden: (...a: unknown[]) => getNearbyUnriddenMock(...(a as [])),
  },
  roadsApi: { getSegmentsInBounds: vi.fn(async () => ({ data: [] })) },
}));

// `useSearchParams` returns null outside a Next router, and this page reads
// the time window from it.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/rides/road-map",
}));

// The map itself is not what this file is about; the real one needs a WebGL
// canvas. Its own behaviour is covered by `_components/PersonalRoadMap.test`.
vi.mock("../_components/PersonalRoadMap", () => ({
  PersonalRoadMap: () => <div data-testid="road-map" />,
}));
vi.mock("@/hooks/useUserRideTracks", () => ({
  // The full shape: a partial mock leaves `truncated`/`error` undefined and the
  // page's "tracks settled" logic reads them.
  useUserRideTracks: () => ({
    tracks: [],
    truncated: false,
    loading: false,
    error: false,
  }),
}));

import RoadMapPage from "./page";
import { useAuthStore } from "@/stores/auth";

describe("RoadMapPage — sys_gamification", () => {
  beforeEach(() => {
    killSwitches.road_quality_overlay = true;
    systemSwitches.sys_gamification = true;
    getStatsMock.mockClear();
    getRiddenSegmentsMock.mockClear();
    useAuthStore.setState({
      accessToken: "tok",
      isAuthenticated: true,
      user: { id: "user-1", email: "r@example.com", displayName: "Rider" },
    });
  });

  it("fetches exploration while the switch is live", async () => {
    render(<RoadMapPage />);
    // Positive precondition for the absence assertions below.
    await waitFor(() => expect(getStatsMock).toHaveBeenCalled());
  });

  it("NEVER FETCHES exploration when the subsystem is off", async () => {
    // Otherwise the page renders 0% explored, which the rider reads as their
    // own coverage rather than as an operator shutdown.
    systemSwitches.sys_gamification = false;
    render(<RoadMapPage />);

    await waitFor(() =>
      expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument(),
    );
    expect(getStatsMock).not.toHaveBeenCalled();
    expect(getRiddenSegmentsMock).not.toHaveBeenCalled();
  });

  it("says UNAVAILABLE rather than blaming a load failure", async () => {
    // With the subsystem off there is no `stats` — not because anything
    // failed, but because we deliberately did not ask. The generic error would
    // pin an operator shutdown on a network fault.
    systemSwitches.sys_gamification = false;
    render(<RoadMapPage />);

    expect(
      await screen.findByText(/temporarily unavailable/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Could not load exploration data/i),
    ).not.toBeInTheDocument();
  });

  // NOT COVERED, and worth stating precisely so it is not rediscovered:
  //
  // The surface gate is `!gamificationEnabled`, deliberately NOT
  // `!gamificationEnabled && !stats` — a rider already on the page when an
  // operator flips must lose the map too. The two forms differ only when
  // `stats` is already loaded, and this suite cannot reach that state: the
  // page renders its map only past an empty-state gate that needs ridden
  // segments surviving the time-window filter, which the mocks here do not
  // satisfy. The same blocks a test for the nearby-unridden query's gate,
  // which additionally requires the Coverage view — local state behind a UI
  // toggle on that same unreachable surface.
  //
  // Both gates stay: without them a live flip leaves the whole coverage map,
  // the exploration totals and every ridden segment on screen, and keeps
  // issuing exploration queries. Reaching them needs a fuller page harness
  // than this file has.

  it("is independent of road_quality_overlay", async () => {
    // Different registries: killing the overlay must not stop exploration.
    killSwitches.road_quality_overlay = false;
    render(<RoadMapPage />);
    await waitFor(() => expect(getStatsMock).toHaveBeenCalled());
  });
});
