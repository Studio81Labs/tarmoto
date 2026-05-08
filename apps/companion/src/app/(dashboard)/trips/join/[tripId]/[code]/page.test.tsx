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

import TripInviteJoinPage from "./page";
import { ApiError, tripsApi } from "@/lib/api";

beforeEach(() => {
  vi.clearAllMocks();
  routeParams = { tripId: "trip-1", code: "ABCDEFGH" };
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
});
