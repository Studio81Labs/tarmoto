import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";

const mockReplace = vi.fn();
let routeParams: { tripId?: string | null; code?: string | null } = {
  tripId: "trip-1",
  code: "ABCDEFGH",
};

vi.mock("next/navigation", () => ({
  useParams: () => routeParams,
  useRouter: () => ({ replace: mockReplace, push: vi.fn(), back: vi.fn() }),
}));

// Self-contained module mock — `vi.mock` is hoisted, so referencing a
// top-level identifier in the factory body would trip "cannot access
// X before initialization". We deliberately do NOT `vi.importActual`
// the real `@/lib/api`: it transitively pulls every endpoint surface
// (hazards, closures, exploration, poi, …), which OOMs jsdom on Node
// 22 under vitest 4 — `import 660ms, tests 0ms` is the symptom.
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
    tripsApi: { join: vi.fn() },
  };
});

// Mutable auth-store stub so individual tests can flip between
// "AuthSync hasn't hydrated yet" (`accessToken: null`) and "hydrated"
// (`accessToken: "..."`). The selector form mirrors the real zustand
// store so the page's `useAuthStore((s) => Boolean(s.accessToken))`
// hook works unchanged.
let authState: { accessToken: string | null } = { accessToken: "token" };
vi.mock("@/stores/auth", () => ({
  useAuthStore: <T,>(selector: (s: { accessToken: string | null }) => T): T =>
    selector(authState),
}));

import TripInviteJoinPage from "./page";
import { ApiError, tripsApi } from "@/lib/api";

beforeEach(() => {
  vi.clearAllMocks();
  routeParams = { tripId: "trip-1", code: "ABCDEFGH" };
  authState = { accessToken: "token" };
});

describe("TripInviteJoinPage", () => {
  it("posts the invite code to /trips/:id/join and redirects to the trip detail on success", async () => {
    vi.mocked(tripsApi.join).mockResolvedValue({ data: { id: "trip-1" } });
    render(<TripInviteJoinPage />);

    await waitFor(() => {
      expect(tripsApi.join).toHaveBeenCalledWith("trip-1", "ABCDEFGH");
    });
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/trips/trip-1");
    });
  });

  it("surfaces an actionable error when the invite code is rejected (403)", async () => {
    vi.mocked(tripsApi.join).mockRejectedValue(
      new ApiError("Invalid trip or invite code", 403, {}),
    );
    render(<TripInviteJoinPage />);

    await screen.findByText(/This invite link is invalid or has been revoked/i);
    expect(mockReplace).not.toHaveBeenCalled();
    // Recovery action: a "Go to my trips" link, since the user is
    // signed in (otherwise the middleware would have intercepted the
    // page before it loaded) but can't accept this particular invite.
    expect(
      screen.getByRole("link", { name: /Go to my trips/i }),
    ).toHaveAttribute("href", "/trips");
  });

  it("does not POST when the route params are missing", async () => {
    routeParams = { tripId: null, code: null };
    render(<TripInviteJoinPage />);

    await screen.findByText(/Missing trip id or invite code/i);
    expect(tripsApi.join).not.toHaveBeenCalled();
  });

  it("redirects to the trip detail under React StrictMode without sticking on the spinner (Bugbot #38db6ed2)", async () => {
    // Regression for the high-severity Bugbot finding on PR #489: the
    // earlier `joinedOnce` + `cancelled` pair deadlocked under
    // StrictMode (which next.config.ts has on by default) — the
    // second pass's early-exit left the first pass's resolved POST
    // gated behind `cancelled = true`, so setState never fired and
    // the page sat on the spinner forever. Wrapping the component in
    // `<StrictMode>` here forces the dev double-invoke that the bug
    // depended on, so a regression of the deadlock would time out the
    // `waitFor` instead of redirecting.
    vi.mocked(tripsApi.join).mockResolvedValue({ data: { id: "trip-1" } });

    render(
      <StrictMode>
        <TripInviteJoinPage />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/trips/trip-1");
    });
    // The dedupe ref must still gate StrictMode's double-invoke down
    // to a single backend POST — two `member_joined` activity rows
    // would litter the trip's collaboration timeline.
    expect(tripsApi.join).toHaveBeenCalledTimes(1);
  });

  it("waits for AuthSync to hydrate the bearer token before posting (Codex #r3207058516)", async () => {
    // Regression for the AuthSync race Codex flagged: on a hard
    // navigation right after login/register the NextAuth session is
    // mid-flight while the page already mounts. If the join effect
    // fired now, `apiFetch` would read `accessToken === null`, send
    // an unauthenticated POST, hit the global 401 handler, and
    // `clearSession` — wiping the just-issued credentials. The
    // `authReady` gate must hold the spinner until the token lands.
    authState = { accessToken: null };
    vi.mocked(tripsApi.join).mockResolvedValue({ data: { id: "trip-1" } });

    const { rerender } = render(<TripInviteJoinPage />);
    // Spinner is up but no POST has gone out yet.
    expect(screen.getByText(/Accepting your trip invite/i)).toBeInTheDocument();
    expect(tripsApi.join).not.toHaveBeenCalled();

    // AuthSync finishes — token lands in the store, page re-renders,
    // effect picks the change up via its `authReady` dep and posts.
    authState = { accessToken: "token" };
    rerender(<TripInviteJoinPage />);

    await waitFor(() => {
      expect(tripsApi.join).toHaveBeenCalledWith("trip-1", "ABCDEFGH");
    });
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/trips/trip-1");
    });
    expect(tripsApi.join).toHaveBeenCalledTimes(1);
  });
});
