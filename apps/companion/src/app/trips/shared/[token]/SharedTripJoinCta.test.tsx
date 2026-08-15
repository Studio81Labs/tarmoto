import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth";
import { SharedTripJoinCta } from "./SharedTripJoinCta";

const tripPlanningKill = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/hooks/useEntitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useEntitlements")>()),
  // Fails SAFE in production, so default ON and every existing case keeps its
  // path. Flip `tripPlanningKill.enabled` to simulate an operator.
  useFeatureKillSwitch: () => ({
    enabled: tripPlanningKill.enabled,
    isResolved: true,
  }),
}));

const router = {
  push: vi.fn(),
};

const hoisted = vi.hoisted(() => ({
  joinByToken: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: hoisted.toastError },
}));

vi.mock("@/lib/api", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api")>();
  return {
    ...actual,
    tripSharesApi: {
      ...actual.tripSharesApi,
      joinByToken: hoisted.joinByToken,
    },
  };
});

describe("SharedTripJoinCta", () => {
  beforeEach(() => {
    router.push.mockReset();
    hoisted.joinByToken.mockReset();
    hoisted.toastError.mockReset();
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      accessToken: null,
    });
  });

  it("prompts logged-out visitors to sign in and return to the shared trip", () => {
    render(
      <SharedTripJoinCta
        token="share-token"
        /* eslint-disable-next-line no-restricted-syntax -- `title` is the
           shared trip's dynamic display name (see share.title in
           app/trips/shared/[token]/page.tsx), not translatable UI copy. */
        title="Dolomites weekend"
        tripId="trip-1"
      />,
    );

    const login = screen.getByRole("link", { name: /sign in to collaborate/i });
    expect(login).toHaveAttribute(
      "href",
      "/login?callbackUrl=%2Ftrips%2Fshared%2Fshare-token",
    );
    expect(
      screen.getByRole("link", { name: /create an account/i }),
    ).toHaveAttribute(
      "href",
      "/register?callbackUrl=%2Ftrips%2Fshared%2Fshare-token",
    );
  });

  it("offers NO join action when trip planning is killed", async () => {
    // The backend has no `trip_planning` guard on `joinByToken`, so the client
    // is the enforcement point. The preview itself stays — killing trip PLANNING
    // does not mean hiding a trip someone chose to share.
    tripPlanningKill.enabled = false;
    try {
      render(<SharedTripJoinCta token="tok" title="Alps" tripId="t1" />);
      expect(
        screen.queryByRole("button", { name: /join/i }),
      ).not.toBeInTheDocument();
      // Says WHY, and that the link is fine. It used to reuse the read-only
      // copy, which tells the visitor to ask the owner for a fresh link — an
      // action the owner cannot take while planning is paused, and one that
      // sent a real tester chasing a link problem that did not exist.
      expect(
        screen.getByText(/Joining is temporarily unavailable/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/The link still works/i)).toBeInTheDocument();
      expect(
        screen.queryByText(/ask the trip owner for a fresh/i),
      ).not.toBeInTheDocument();
    } finally {
      tripPlanningKill.enabled = true;
    }
  });

  it("accepts the share token and opens the trip preview for authenticated visitors", async () => {
    useAuthStore.setState({
      user: {
        id: "user-2",
        email: "member@example.com",
        displayName: "Group Member",
      },
      isAuthenticated: true,
      accessToken: "access-token",
    });
    hoisted.joinByToken.mockResolvedValueOnce({
      data: {
        trip_id: "trip-1",
        planner_url: "/trips/planner?tripId=trip-1",
      },
    });

    render(
      <SharedTripJoinCta
        token="share-token"
        /* eslint-disable-next-line no-restricted-syntax -- `title` is the
           shared trip's dynamic display name (see share.title in
           app/trips/shared/[token]/page.tsx), not translatable UI copy. */
        title="Dolomites weekend"
        tripId="trip-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /join trip/i }));

    await waitFor(() => {
      expect(hoisted.joinByToken).toHaveBeenCalledWith("share-token");
      expect(router.push).toHaveBeenCalledWith("/trips/trip-1");
    });
  });

  it("shows the owner-cap message (not 'fresh link') on a FEATURE_LIMIT_EXCEEDED join 403", async () => {
    const { ApiError } = await import("@/lib/api");
    const { FEATURE_LIMIT_EXCEEDED } = await import("@tarmoto/shared");
    useAuthStore.setState({
      user: {
        id: "user-2",
        email: "member@example.com",
        displayName: "Group Member",
      },
      isAuthenticated: true,
      accessToken: "access-token",
    });
    hoisted.joinByToken.mockRejectedValueOnce(
      new ApiError("limit", 403, {
        code: FEATURE_LIMIT_EXCEEDED,
        feature: "max_trip_collaborators",
        limit: 5,
        current: 5,
      }),
    );

    render(
      <SharedTripJoinCta
        token="share-token"
        /* eslint-disable-next-line no-restricted-syntax -- dynamic share title */
        title="Dolomites weekend"
        tripId="trip-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /join trip/i }));

    await waitFor(() =>
      expect(hoisted.toastError).toHaveBeenCalledWith(
        "The trip owner has reached their collaborator limit.",
        expect.anything(),
      ),
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it("keeps legacy snapshot-only shares as read-only previews", () => {
    render(
      <SharedTripJoinCta
        token="legacy-token"
        /* eslint-disable-next-line no-restricted-syntax -- `title` is the
           shared trip's dynamic display name (see share.title in
           app/trips/shared/[token]/page.tsx), not translatable UI copy. */
        title="Legacy share"
        tripId={null}
      />,
    );

    expect(
      screen.getByText(/this public preview is read-only/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /join trip/i }),
    ).not.toBeInTheDocument();
  });
});
