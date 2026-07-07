import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth";
import { SharedTripJoinCta } from "./SharedTripJoinCta";

const router = {
  push: vi.fn(),
};

const hoisted = vi.hoisted(() => ({
  joinByToken: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
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

  it("keeps legacy snapshot-only shares as read-only previews", () => {
    render(
      <SharedTripJoinCta
        token="legacy-token"
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
