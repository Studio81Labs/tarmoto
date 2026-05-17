import { render, screen } from "@testing-library/react";
import { RouteCollectionFollowCta } from "./RouteCollectionFollowCta";
import { withQueryClient } from "@/hooks/test-utils";

vi.mock("@/stores/auth", () => ({
  useAuthStore: (
    selector: (state: {
      isAuthenticated: boolean;
      accessToken: string | null;
    }) => unknown,
  ) => selector({ isAuthenticated: false, accessToken: null }),
}));

describe("RouteCollectionFollowCta", () => {
  it("points anonymous visitors at the real login route with the collection callback", async () => {
    render(
      <RouteCollectionFollowCta
        collectionId="collection-1"
        slug="alpine-weekend"
        ownerName="Mira"
      />,
      { wrapper: withQueryClient() },
    );

    const signInLink = await screen.findByRole("link", { name: "Sign in" });

    expect(signInLink).toHaveAttribute(
      "href",
      "/login?callbackUrl=%2Fcommunity%2Fcollections%2Fshared%2Falpine-weekend",
    );
  });
});
