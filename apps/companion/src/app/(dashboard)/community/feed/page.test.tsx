import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import CommunityFeedPage from "./page";
import { api, communityApi, type CommunityRidePage } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

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

  beforeEach(() => {
    geocodeMock.mockReset();
    listMock.mockReset();
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

    fireEvent.change(screen.getByLabelText("Sort feed"), {
      target: { value: "newest" },
    });

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

    fireEvent.change(screen.getByLabelText("Minimum popularity"), {
      target: { value: "250" },
    });

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({
        limit: 9,
        offset: 0,
        sort: "most_popular",
        min_popularity: 250,
      }),
    );
  });

  it("disables nearest sorting until a place is selected", async () => {
    listMock.mockResolvedValueOnce({ data: pageData() });

    render(<CommunityFeedPage />);

    expect(screen.getByRole("option", { name: "Nearest" })).toBeDisabled();
  });
});
