import { render, screen, waitFor } from "@testing-library/react";
import TripsPage from "./page";
import { useTripStore } from "@/stores/trip";
import { useAuthStore } from "@/stores/auth";
import { tripsApi, tripFoldersApi } from "@/lib/api";
import { withQueryClient } from "@/hooks/test-utils";
import type { TripSummaryWire } from "@/lib/trip-from-detail";

// --- entitlement mocks (add alongside the existing page mocks) ---
const useLimitMock = vi.fn();
vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks")>()),
  useEntitlements: () => ({ tier: "free" }),
  useLimit: (key: string) => useLimitMock(key),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// Stub the trip + folder API surface the list page's mount effects hit.
// Spread the real module so ApiError / other exports the page (transitively)
// needs still resolve.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    tripsApi: {
      ...actual.tripsApi,
      list: vi.fn(),
      duplicate: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
    },
    tripFoldersApi: {
      ...actual.tripFoldersApi,
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
});

// One open (draft) trip owned by "me" — the exact shape the list endpoint
// returns (`TripSummaryDto`), adapted by the page's own `tripSummaryFromWire`.
function buildOpenOwnedTripWire(): TripSummaryWire {
  return {
    id: "trip-1",
    title: "Alpine loop",
    status: "draft",
    num_days: 3,
    member_count: 1,
    region: null,
    owner_id: "me",
    folder_id: null,
    created_at: "2026-04-23T09:00:00Z",
  } as TripSummaryWire;
}

describe("trips page — max_active_trips gate", () => {
  const tripsApiListMock = vi.mocked(tripsApi.list);
  const tripFoldersListMock = vi.mocked(tripFoldersApi.list);

  beforeEach(() => {
    useLimitMock.mockReset();
    tripsApiListMock.mockReset();
    tripFoldersListMock.mockReset();
    useTripStore.setState(useTripStore.getInitialState());
    useAuthStore.setState({
      user: { id: "me", email: "me@example.com", displayName: "Me" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    tripFoldersListMock.mockResolvedValue({ data: { items: [] } } as never);
    tripsApiListMock.mockResolvedValue({
      data: { data: [buildOpenOwnedTripWire()] },
    } as never);
  });

  it("blocks minting and shows the counter when at the limit", async () => {
    useLimitMock.mockReturnValue({ limit: 1, isLoading: false });

    render(<TripsPage />, { wrapper: withQueryClient() });

    expect(
      await screen.findByText(/1 of 1 trips used on the Free plan/i),
    ).toBeTruthy();
    // The "New trip" control is a disabled button (not an enabled link).
    const newTrip = screen.getByRole("button", { name: /New trip/i });
    expect(newTrip).toHaveProperty("disabled", true);
  });

  it("leaves minting enabled when the limit is unlimited", async () => {
    useLimitMock.mockReturnValue({ limit: null, isLoading: false });

    render(<TripsPage />, { wrapper: withQueryClient() });

    await waitFor(() =>
      expect(screen.getByText("Alpine loop")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/trips used on the/i)).toBeNull();
    expect(screen.getByRole("link", { name: /New trip/i })).toBeTruthy();
  });
});
