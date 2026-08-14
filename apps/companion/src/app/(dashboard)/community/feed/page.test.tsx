import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CommunityFeedPage from "./page";
import { api, communityApi, type CommunityRidePage } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { FormatProvider } from "@/format/FormatProvider";
import { fetchSuggestedRiders } from "@/lib/community-sidebar";

// Kill switches fail SAFE (enabled until a confirmed `force_off`); the real
// hook needs a QueryClientProvider this suite does not set up. Reached via the
// clone action on each `CommunityRideCard`.
const killSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/hooks/useEntitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useEntitlements")>()),
  useFeatureKillSwitch: () => ({
    enabled: killSwitch.enabled,
    isResolved: true,
  }),
}));

vi.mock("next/navigation", async () => {
  const actual =
    await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return { ...actual, useRouter: () => ({ push: vi.fn() }) };
});

// The shared CommunityScaffold tab badge fetches its own feed/collections
// totals (gated on auth). These tests cover the feed page's own fetch/filter
// behaviour, so stub the badge hooks out to keep them off the `communityApi`
// call counts asserted below.
vi.mock("../_useCommunityTotals", () => ({
  useCommunityFeedTotal: () => 1,
  useCommunityCollectionsTotal: () => 0,
}));

// The feed mounts CommunitySidebar; stub its independent data fetchers so
// the rail's follow/challenge widgets are deterministic (empty by default,
// overridden per-test). Keeps the sidebar reachable in the empty-feed case
// without pulling live gamification/suggestion calls into these tests.
vi.mock("@/lib/community-sidebar", () => ({
  fetchActiveChallengeCard: vi.fn(async () => null),
  fetchSuggestedRiders: vi.fn(async () => []),
}));
vi.mock("@/lib/gamification-fetch", () => ({
  fetchRegionalLeaderboards: vi.fn(async () => null),
}));
vi.mock("@/lib/rider-profile", () => ({
  followRider: vi.fn(async () => undefined),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: {
      GET: vi.fn().mockResolvedValue({ data: undefined, error: { status: 0 } }),
    },
    communityApi: {
      list: vi.fn(),
    },
  };
});

function pageData(): CommunityRidePage {
  return {
    items: [
      {
        id: "ride-1",
        share_token: "token-1",
        rider_id: "rider-1",
        rider_name: "John Rider",
        rider_avatar_url: null,
        name: "Three Passes Sunday",
        ride_type: "trip",
        started_at: "2026-04-22T10:00:00.000Z",
        distance_km: 242.6,
        avg_speed: 63.2,
        avg_road_quality: 4.4,
        avg_curviness: 6.1,
        duration_min: 215,
        view_count: 123,
        description: null,
        like_count: 142,
        viewer_has_liked: false,
        clone_count: 12,
        route_geometry: [
          { lat: 49.2, lng: 16.6 },
          { lat: 49.15, lng: 16.7 },
          { lat: 49.1, lng: 16.75 },
        ],
      },
    ],
    total: 1,
    limit: 9,
    offset: 0,
  };
}

describe("CommunityFeedPage", () => {
  const geocodeMock = vi.mocked(api.GET);
  const listMock = vi.mocked(communityApi.list);
  const suggestedRidersMock = vi.mocked(fetchSuggestedRiders);

  beforeEach(() => {
    killSwitch.enabled = true;
    geocodeMock.mockReset();
    listMock.mockReset();
    suggestedRidersMock.mockReset();
    suggestedRidersMock.mockResolvedValue([]);
    // The feed gates its fetch on a hydrated access token (so it doesn't race
    // AuthSync into an anonymous request); seed one for the test.
    useAuthStore.setState({
      accessToken: "test-token",
      isAuthenticated: true,
      user: { id: "user-1", email: "rider@example.com", displayName: "Rider" },
    });
  });

  it("loads and renders community ride cards from the API", async () => {
    listMock.mockResolvedValueOnce({ data: pageData() });

    render(<CommunityFeedPage />);

    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith({
        limit: 9,
        offset: 0,
        sort: "most_popular",
      }),
    );

    expect(await screen.findByText("John Rider")).toBeInTheDocument();
  });

  it("shows the empty-feed card and keeps the follow-suggestions rail reachable", async () => {
    // Pristine-empty feed (no filters, nothing shared yet) but sidebar data
    // still exists — the empty copy tells riders to follow others, so the
    // sidebar's Follow affordance must remain mounted alongside the card.
    listMock.mockResolvedValueOnce({
      data: { items: [], total: 0, limit: 9, offset: 0 },
    });
    suggestedRidersMock.mockResolvedValue([
      {
        id: "rider-9",
        display_name: "Jane Rider",
        avatar_url: null,
        home_region: "Bormio",
        ride_count: 12,
      },
    ]);

    render(<CommunityFeedPage />);

    expect(await screen.findByText("Quiet on the feed")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Follow" }),
    ).toBeInTheDocument();
  });

  it("waits for the access token before fetching, then loads once it arrives", async () => {
    // Mount anonymous — the feed must not race AuthSync into a token-less
    // request, which the optional-auth backend would filter to public owners.
    useAuthStore.setState({
      accessToken: null,
      isAuthenticated: false,
      user: null,
    });
    listMock.mockResolvedValue({ data: pageData() });

    render(<CommunityFeedPage />);

    // Give effects a chance to run; none should fetch while unauthenticated.
    await Promise.resolve();
    expect(listMock).not.toHaveBeenCalled();

    // Token hydrates — the effect's auth dependency must trigger the fetch.
    act(() => {
      useAuthStore.setState({
        accessToken: "test-token",
        isAuthenticated: true,
        user: {
          id: "user-1",
          email: "rider@example.com",
          displayName: "Rider",
        },
      });
    });

    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith({
        limit: 9,
        offset: 0,
        sort: "most_popular",
      }),
    );
    expect(await screen.findByText("John Rider")).toBeInTheDocument();
  });

  it("refetches from the first page when the sort changes", async () => {
    listMock
      .mockResolvedValueOnce({ data: pageData() })
      .mockResolvedValueOnce({ data: pageData() });

    render(<CommunityFeedPage />);

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByLabelText("Sort feed"));
    await userEvent.click(screen.getByRole("option", { name: "Newest" }));

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({
        limit: 9,
        offset: 0,
        sort: "newest",
      }),
    );
  });

  it("includes distance filters in the API query", async () => {
    listMock
      .mockResolvedValueOnce({ data: pageData() })
      .mockResolvedValueOnce({ data: pageData() })
      .mockResolvedValueOnce({ data: pageData() });

    render(<CommunityFeedPage />);

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Minimum distance"), {
      target: { value: "150" },
    });
    fireEvent.change(screen.getByLabelText("Maximum distance"), {
      target: { value: "320" },
    });

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({
        limit: 9,
        offset: 0,
        sort: "most_popular",
        min_distance_km: 150,
        max_distance_km: 320,
      }),
    );
  });

  it("includes the minimum popularity filter in the API query", async () => {
    listMock
      .mockResolvedValueOnce({ data: pageData() })
      .mockResolvedValueOnce({ data: pageData() });

    render(<CommunityFeedPage />);

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByLabelText("Minimum popularity"));
    await userEvent.click(screen.getByRole("option", { name: "250+ views" }));

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({
        limit: 9,
        offset: 0,
        sort: "most_popular",
        min_popularity: 250,
      }),
    );
  });

  it("removes the quality sort and filter when the overlay is killed", async () => {
    killSwitch.enabled = false;
    listMock.mockResolvedValue({ data: pageData() });

    render(<CommunityFeedPage />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    // The whole filter goes — its only axis is the killed dimension.
    expect(screen.queryByLabelText("Minimum quality")).not.toBeInTheDocument();
    // The sort stays, minus the option that orders by the killed dimension.
    await userEvent.click(screen.getByLabelText("Sort feed"));
    expect(
      screen.queryByRole("option", { name: "Highest quality" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Most popular" }),
    ).toBeInTheDocument();
  });

  it("stops SENDING min_quality when the switch is flipped mid-session", async () => {
    // The rider picks a quality floor while the feature is live, then an
    // operator kills it. Derived rather than reset through an effect, so the
    // stale state cannot put `min_quality` back on the wire.
    listMock.mockResolvedValue({ data: pageData() });
    const { rerender } = render(<CommunityFeedPage />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByLabelText("Minimum quality"));
    await userEvent.click(screen.getByRole("option", { name: "4.0+ / 5" }));
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ min_quality: 4 }),
      ),
    );

    killSwitch.enabled = false;
    rerender(<CommunityFeedPage />);

    await waitFor(() => {
      const last = listMock.mock.lastCall?.[0] as Record<string, unknown>;
      expect(last).not.toHaveProperty("min_quality");
    });
  });

  it("falls back from a killed highest_quality sort without sending it", async () => {
    listMock.mockResolvedValue({ data: pageData() });
    const { rerender } = render(<CommunityFeedPage />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByLabelText("Sort feed"));
    await userEvent.click(
      screen.getByRole("option", { name: "Highest quality" }),
    );
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: "highest_quality" }),
      ),
    );

    killSwitch.enabled = false;
    rerender(<CommunityFeedPage />);

    await waitFor(() => {
      const last = listMock.mock.lastCall?.[0] as { sort?: string };
      expect(last.sort).toBe("most_popular");
    });
    // The CONTROL must agree with the query. Filtering the option out while
    // leaving the raw value bound shows a placeholder over an applied sort.
    expect(screen.getByLabelText("Sort feed")).toHaveTextContent(
      "Most popular",
    );
  });

  it("shows the pristine empty state after a kill leaves the feed unfiltered", async () => {
    // The rider filters by quality, gets nothing, and the operator then kills
    // the overlay. The feed is now unfiltered, so telling them "no rides match
    // these filters" points at filters that are no longer applied.
    listMock.mockResolvedValue({
      data: { items: [], total: 0, limit: 9, offset: 0 },
    });
    const { rerender } = render(<CommunityFeedPage />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByLabelText("Minimum quality"));
    await userEvent.click(screen.getByRole("option", { name: "4.0+ / 5" }));
    await waitFor(() =>
      expect(screen.getByText("No rides match these filters")).toBeVisible(),
    );

    killSwitch.enabled = false;
    rerender(<CommunityFeedPage />);

    await waitFor(() =>
      expect(screen.getByText("Quiet on the feed")).toBeVisible(),
    );
    expect(
      screen.queryByText("No rides match these filters"),
    ).not.toBeInTheDocument();
  });

  it("disables nearest sorting until a place is selected", async () => {
    listMock.mockResolvedValueOnce({ data: pageData() });

    render(<CommunityFeedPage />);

    await userEvent.click(screen.getByLabelText("Sort feed"));
    expect(screen.getByRole("option", { name: "Nearest" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("uses the active unit in the selected-radius summary", async () => {
    listMock.mockResolvedValue({ data: pageData() });
    geocodeMock.mockResolvedValue({
      data: {
        results: [
          { label: "Tatra Mountains, Slovakia", lat: 49.17, lng: 20.13 },
        ],
      },
      error: undefined,
    } as never);

    render(
      <FormatProvider formatLocale="en-US" timeZone="UTC" units="imperial">
        <CommunityFeedPage />
      </FormatProvider>,
    );

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "tatra" },
    });
    await userEvent.click(
      await screen.findByRole("option", {
        name: "Tatra Mountains, Slovakia",
      }),
    );

    expect(
      screen.getByText((_content, element) =>
        Boolean(
          element?.tagName === "P" &&
          element.textContent ===
            "Filtering within 15.5 mi of Tatra Mountains, Slovakia.",
        ),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Tatra Mountains, Slovakia")).toHaveClass(
      "font-semibold",
      "text-ink",
    );
  });
});
