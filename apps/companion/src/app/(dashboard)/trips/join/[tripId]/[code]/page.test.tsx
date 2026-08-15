import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockReplace = vi.fn();
let routeParams: { tripId?: string | null; code?: string | null } = {
  tripId: "trip-1",
  code: "ABCDEFGH",
};

vi.mock("next/navigation", () => ({
  useParams: () => routeParams,
  useRouter: () => ({ replace: mockReplace, push: vi.fn(), back: vi.fn() }),
}));

// Self-contained module mock — `vi.mock` is hoisted, so we can't reference a
// top-level identifier in the factory. We deliberately do NOT `vi.importActual`
// the real `@/lib/api`: it transitively pulls every endpoint surface, which
// OOMs jsdom under vitest.
vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    readonly status: number;
    readonly body: unknown;
    constructor(message: string, status: number, body: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
  }
  return {
    ApiError,
    tripsApi: { getInvitePreview: vi.fn(), join: vi.fn() },
  };
});

// Light stubs so the page test doesn't drag in the route-preview SVG math or
// the avatar's colour hashing — this test is about the preview→accept flow.
vi.mock("@/components/TripRouteOverview", () => ({
  TripRouteOverview: () => <div data-testid="route-overview" />,
}));
vi.mock("@/components/UserAvatar", () => ({
  UserAvatar: () => <span data-testid="avatar" />,
}));

let authState: { accessToken: string | null } = { accessToken: "token" };
vi.mock("@/stores/auth", () => ({
  useAuthStore: <T,>(selector: (s: { accessToken: string | null }) => T): T =>
    selector(authState),
}));

import TripInviteJoinPage from "./page";
import { ApiError, tripsApi } from "@/lib/api";

const killSwitches = vi.hoisted(() => ({}) as Record<string, boolean>);
vi.mock("@/hooks/useEntitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useEntitlements")>()),
  // Operator kill switches fail SAFE (enabled until a confirmed `force_off`),
  // mirroring production so every existing case keeps its path.
  // KEYED and mutable: this route gates on `trip_planning`, and hard-coding
  // every switch enabled means the gate itself can never be exercised.
  useFeatureKillSwitch: (key: string) => ({
    enabled: killSwitches[key] ?? true,
    isResolved: true,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  routeParams = { tripId: "trip-1", code: "ABCDEFGH" };
  authState = { accessToken: "token" };
});

function previewResponse(overrides = {}) {
  return {
    data: {
      trip_id: "trip-1",
      title: "Alps Loop",
      owner_name: "Jane Rider",
      invited_by_name: "Jane Rider",
      role: "editor" as const,
      region: "Tirol",
      num_days: 3,
      distance_km: 520,
      lines: [
        [
          [11, 46],
          [11.1, 46.1],
        ],
      ],
      already_member: false,
      ...overrides,
    },
  };
}

// The page ignores the join response (it just redirects), so a minimal stub is
// fine — cast past the full generated response type the mock's signature wants.
function joinedTripResponse() {
  return { data: { id: "trip-1" } } as Awaited<
    ReturnType<typeof tripsApi.join>
  >;
}

describe("TripInviteJoinPage", () => {
  it("renders the preview and only joins after an explicit accept", async () => {
    vi.mocked(tripsApi.getInvitePreview).mockResolvedValue(previewResponse());
    vi.mocked(tripsApi.join).mockResolvedValue(joinedTripResponse());
    render(<TripInviteJoinPage />);

    // Preview shows the trip title, the inviter + role, and the route overview.
    await screen.findByText("Alps Loop");
    expect(
      screen.getByText(/Jane Rider invited you to collaborate as an editor/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("route-overview")).toBeInTheDocument();
    // Crucially, no join has fired yet — accepting is an explicit action.
    expect(tripsApi.join).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Accept invitation/i }));

    await waitFor(() => {
      expect(tripsApi.join).toHaveBeenCalledWith("trip-1", "ABCDEFGH");
    });
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/trips/trip-1");
    });
  });

  it("redirects an existing member straight to the trip without an accept step", async () => {
    vi.mocked(tripsApi.getInvitePreview).mockResolvedValue(
      previewResponse({ already_member: true }),
    );
    render(<TripInviteJoinPage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/trips/trip-1");
    });
    expect(tripsApi.join).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /Accept invitation/i }),
    ).not.toBeInTheDocument();
  });

  it("catalogs the contract-valid owner role with complete grammar", async () => {
    vi.mocked(tripsApi.getInvitePreview).mockResolvedValue(
      previewResponse({ role: "owner" }),
    );
    render(<TripInviteJoinPage />);

    await screen.findByText(
      /Jane Rider invited you to collaborate as the owner/i,
    );
  });

  it("surfaces an actionable error when the invite is invalid/revoked (404)", async () => {
    vi.mocked(tripsApi.getInvitePreview).mockRejectedValue(
      new ApiError("Invite not found", 404, {}),
    );
    render(<TripInviteJoinPage />);

    await screen.findByText(/This invite link is invalid or has been revoked/i);
    expect(tripsApi.join).not.toHaveBeenCalled();
    expect(
      screen.getByRole("link", { name: /Go to my trips/i }),
    ).toHaveAttribute("href", "/trips");
  });

  it("does not call the API when the route params are missing", async () => {
    routeParams = { tripId: null, code: null };
    render(<TripInviteJoinPage />);

    await screen.findByText(/Missing trip id or invite code/i);
    expect(tripsApi.getInvitePreview).not.toHaveBeenCalled();
  });

  it("waits for AuthSync to hydrate the bearer token before fetching the preview", async () => {
    authState = { accessToken: null };
    vi.mocked(tripsApi.getInvitePreview).mockResolvedValue(previewResponse());

    const { rerender } = render(<TripInviteJoinPage />);
    expect(screen.getByText(/Loading your invite/i)).toBeInTheDocument();
    expect(tripsApi.getInvitePreview).not.toHaveBeenCalled();

    authState = { accessToken: "token" };
    rerender(<TripInviteJoinPage />);

    await screen.findByText("Alps Loop");
    expect(tripsApi.getInvitePreview).toHaveBeenCalledTimes(1);
  });

  it("fetches the preview once under React StrictMode", async () => {
    vi.mocked(tripsApi.getInvitePreview).mockResolvedValue(previewResponse());

    render(
      <StrictMode>
        <TripInviteJoinPage />
      </StrictMode>,
    );

    await screen.findByText("Alps Loop");
    expect(tripsApi.getInvitePreview).toHaveBeenCalledTimes(1);
  });
});

describe("TripInviteJoinPage — trip_planning killed", () => {
  beforeEach(() => {
    for (const key of Object.keys(killSwitches)) delete killSwitches[key];
  });

  it("replaces the WHOLE route with the paused screen, back to /trips", () => {
    // An invite link is a deep link from outside the app, so this is exactly
    // the "opened directly" case the reporter hit on /community.
    killSwitches.trip_planning = false;
    render(<TripInviteJoinPage />);

    expect(screen.getByText("This feature is paused")).toBeInTheDocument();
    const back = screen.getByRole("link", { name: "Back to trips" });
    expect(back).toHaveAttribute("href", "/trips");
  });
});
