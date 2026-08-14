import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// The quality tier is gated on `road_quality_overlay`; the real hook needs a
// QueryClientProvider this suite does not render. Defaults to ENABLED, which
// is both the production steady state and the hook's fail-safe direction.
const killSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/hooks/useEntitlements", () => ({
  useFeatureKillSwitch: () => ({
    enabled: killSwitch.enabled,
    isResolved: true,
  }),
}));

import { SharedRidesSection } from "./SharedRidesSection";
import { fetchSharedRides, type UserSharedRide } from "@/lib/shared-rides";

vi.mock("@/lib/shared-rides", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/shared-rides")>(
      "@/lib/shared-rides",
    );
  return {
    ...actual,
    fetchSharedRides: vi.fn(),
  };
});

const fetchMock = vi.mocked(fetchSharedRides);

function ride(overrides: Partial<UserSharedRide> = {}): UserSharedRide {
  return {
    id: overrides.id ?? "ride-1",
    share_token: overrides.share_token ?? "tok-1",
    name: overrides.name ?? "Sunday switchbacks",
    ride_type: overrides.ride_type ?? "free",
    is_public: overrides.is_public ?? true,
    started_at: overrides.started_at ?? "2026-04-14T09:00:00.000Z",
    ended_at: overrides.ended_at ?? "2026-04-14T10:30:00.000Z",
    distance_km: overrides.distance_km ?? 42.5,
    avg_speed: overrides.avg_speed ?? 65.3,
    avg_road_quality: overrides.avg_road_quality ?? 4.2,
    avg_curviness: overrides.avg_curviness ?? 3.1,
    duration_min: overrides.duration_min ?? 90,
    view_count: overrides.view_count ?? 7,
    shared_at: overrides.shared_at ?? "2026-04-14T11:00:00.000Z",
    route_geometry: overrides.route_geometry ?? null,
  };
}

function payload(items: UserSharedRide[]) {
  return {
    items,
    total: items.length,
    total_views: items.reduce((sum, r) => sum + r.view_count, 0),
    limit: 5,
    offset: 0,
  };
}

describe("SharedRidesSection", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("renders the rider's shared rides with distance, duration, view count and a link to the ride detail", async () => {
    fetchMock.mockResolvedValueOnce(payload([ride()]));

    render(
      <SharedRidesSection userId="user-2" isSelf={false} displayName="Other" />,
    );

    expect(
      await screen.findByRole("heading", { name: /shared rides/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "user-2",
        expect.objectContaining({ limit: 5 }),
      ),
    );
    expect(screen.getByText("Sunday switchbacks")).toBeInTheDocument();
    expect(screen.getByText("1 public ride")).toBeInTheDocument();
    expect(screen.getByText("7 total views")).toBeInTheDocument();
    expect(screen.getByText("42.5 km")).toBeInTheDocument();
    expect(screen.getByText("1h 30m")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    const link = screen.getByRole("link");
    // Opens the full ride detail under the community route (consistent with
    // the feed), not the standalone public share page.
    expect(link).toHaveAttribute("href", "/community/rides/ride-1");
  });

  it("treats a 404 as 'no rides to show' and renders the third-person empty hint", async () => {
    // fetchSharedRides collapses 404 to null (private profile / soft-deleted
    // / no such id) so the section renders the empty state instead of an
    // error block, mirroring the mobile semantic.
    fetchMock.mockResolvedValueOnce(null);

    render(
      <SharedRidesSection userId="user-2" isSelf={false} displayName="Other" />,
    );

    expect(
      await screen.findByText("Other hasn't shared any rides yet."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/error|fail/i)).not.toBeInTheDocument();
  });

  it("uses a self empty hint when the rider has no shared rides", async () => {
    fetchMock.mockResolvedValueOnce(payload([]));

    render(<SharedRidesSection userId="user-1" isSelf displayName="Me" />);

    expect(
      await screen.findByText("You haven't shared any rides yet."),
    ).toBeInTheDocument();
  });

  it("shows the Private pill for the rider's own private shares", async () => {
    fetchMock.mockResolvedValueOnce(payload([ride({ is_public: false })]));

    render(<SharedRidesSection userId="user-1" isSelf displayName="Me" />);

    expect(await screen.findByText("Private")).toBeInTheDocument();
  });

  it("hides the Private pill on other riders' profiles even if a private share leaked through", async () => {
    // Defensive — the backend already filters non-self viewers down to
    // public shares, but the UI shouldn't expose `is_public=false` if it
    // ever sees one for a non-self viewer.
    fetchMock.mockResolvedValueOnce(payload([ride({ is_public: false })]));

    render(
      <SharedRidesSection userId="user-2" isSelf={false} displayName="Other" />,
    );

    await screen.findByText("42.5 km");
    expect(screen.queryByText("Private")).not.toBeInTheDocument();
  });

  it("renders an inline error message when the fetch fails for non-404 reasons", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));

    render(
      <SharedRidesSection userId="user-2" isSelf={false} displayName="Other" />,
    );

    expect(
      await screen.findByText("Could not load shared rides."),
    ).toBeInTheDocument();
  });
  it("hides the quality tier when road_quality_overlay is killed", async () => {
    // A global operator kill covers signed-in riders' profiles too.
    fetchMock.mockResolvedValue({
      items: [ride()],
      total: 1,
      total_views: 10,
      limit: 20,
      offset: 0,
    });

    killSwitch.enabled = true;
    const { unmount } = render(
      <SharedRidesSection userId="user-2" isSelf={false} displayName="Other" />,
    );
    expect(
      await screen.findByLabelText(/^Quality \d of 5$/),
    ).toBeInTheDocument();
    unmount();

    killSwitch.enabled = false;
    render(
      <SharedRidesSection userId="user-2" isSelf={false} displayName="Other" />,
    );
    await waitFor(() =>
      expect(screen.getByText("Sunday switchbacks")).toBeInTheDocument(),
    );
    expect(
      screen.queryByLabelText(/^Quality \d of 5$/),
    ).not.toBeInTheDocument();
  });
});
