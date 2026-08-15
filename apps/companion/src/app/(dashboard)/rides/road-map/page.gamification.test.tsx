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
import userEvent from "@testing-library/user-event";

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
// `data` IS the list — the page spreads it straight into `nearbyByDistance`,
// so an envelope here throws "nearby is not iterable" mid-render.
const getNearbyUnriddenMock = vi.fn(async () => ({ data: [] }));
// A ridden segment, so the page reaches its normal view (with the header and
// its Share button) rather than the empty state.
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
vi.mock("./_components/PersonalRoadMap", () => ({
  PersonalRoadMap: () => <div data-testid="road-map" />,
}));
// Records the options the page passes: the query itself lives behind
// react-query's `enabled`, so what this page controls IS the argument.
const rideTracksOptions = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useUserRideTracks", () => ({
  // The full shape: a partial mock leaves `truncated`/`error` undefined and the
  // page's "tracks settled" logic reads them.
  useUserRideTracks: (options: unknown) => {
    rideTracksOptions(options);
    return {
      tracks: [],
      truncated: false,
      loading: false,
      error: false,
    };
  },
}));

import RoadMapPage from "./page";
import { useAuthStore } from "@/stores/auth";

describe("RoadMapPage — sys_gamification", () => {
  beforeEach(() => {
    killSwitches.road_quality_overlay = true;
    systemSwitches.sys_gamification = true;
    getStatsMock.mockClear();
    getRiddenSegmentsMock.mockClear();
    getNearbyUnriddenMock.mockClear();
    rideTracksOptions.mockClear();
    useAuthStore.setState({
      accessToken: "tok",
      isAuthenticated: true,
      user: { id: "user-1", email: "r@example.com", displayName: "Rider" },
    });
  });

  it("STOPS the ride-track download under the shutdown", async () => {
    // `useUserRideTracks` runs before the render branch that replaces the page,
    // so without an explicit `enabled` the shutdown still pulls up to 500 route
    // geometries for a map that never mounts.
    systemSwitches.sys_gamification = false;
    render(<RoadMapPage />);

    await waitFor(() => expect(rideTracksOptions).toHaveBeenCalled());
    expect(rideTracksOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("keeps downloading ride tracks while the switch is live", async () => {
    // The other half — the gate must not cost the routes view its data.
    render(<RoadMapPage />);
    await waitFor(() => expect(rideTracksOptions).toHaveBeenCalled());
    expect(rideTracksOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true }),
    );
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

  it("takes the ALREADY-LOADED map down on a live flip", async () => {
    // The surface gate is `!gamificationEnabled`, deliberately NOT
    // `!gamificationEnabled && !stats`: the two forms differ only once `stats`
    // is loaded, which is exactly the rider sitting on the page when an
    // operator flips. Under the weaker form the coverage map, the exploration
    // totals and every ridden segment stay on screen through the shutdown.
    const { rerender } = render(<RoadMapPage />);
    expect(await screen.findByTestId("road-map")).toBeInTheDocument();

    systemSwitches.sys_gamification = false;
    rerender(<RoadMapPage />);

    expect(
      await screen.findByText(/temporarily unavailable/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("road-map")).not.toBeInTheDocument();
  });

  it("STOPS the nearby-unridden query the flip re-triggers", async () => {
    // Effects run whatever the render branch above decides, and this one lists
    // `gamificationEnabled` in its deps — so the flip that removes the surface
    // also re-runs the query. Gating the surface alone would have the shutdown
    // itself issue a PostGIS nearby search, and every later centre change
    // another.
    const { rerender } = render(<RoadMapPage />);
    // The card lives in the Coverage view only, so the fetch is gated on it.
    await userEvent.click(
      await screen.findByRole("button", { name: "Coverage" }),
    );
    await waitFor(() => expect(getNearbyUnriddenMock).toHaveBeenCalledTimes(1));

    systemSwitches.sys_gamification = false;
    rerender(<RoadMapPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("road-map")).not.toBeInTheDocument(),
    );
    expect(getNearbyUnriddenMock).toHaveBeenCalledTimes(1);
  });

  it("clears a stale load error when the subsystem is restored", async () => {
    // fail → off → on. The restoration fetch succeeds, but the old `loadError`
    // survived and the error branch rendered over a page that had working
    // data.
    getStatsMock.mockRejectedValueOnce(new Error("boom"));
    const { rerender } = render(<RoadMapPage />);
    expect(
      await screen.findByText(/Could not load exploration data/i),
    ).toBeInTheDocument();

    systemSwitches.sys_gamification = false;
    rerender(<RoadMapPage />);
    expect(
      await screen.findByText(/temporarily unavailable/i),
    ).toBeInTheDocument();

    systemSwitches.sys_gamification = true;
    rerender(<RoadMapPage />);

    // Wait for the SETTLED page, not merely for the error text to go: the
    // loading branch renders ahead of the error branch, so an absence
    // assertion on its own is satisfied mid-fetch and holds even with the
    // stale error still in state.
    expect(await screen.findByTestId("road-map")).toBeInTheDocument();
    expect(
      screen.queryByText(/Could not load exploration data/i),
    ).not.toBeInTheDocument();
  });

  it("is independent of road_quality_overlay", async () => {
    // Different registries: killing the overlay must not stop exploration.
    killSwitches.road_quality_overlay = false;
    render(<RoadMapPage />);
    await waitFor(() => expect(getStatsMock).toHaveBeenCalled());
  });
});
