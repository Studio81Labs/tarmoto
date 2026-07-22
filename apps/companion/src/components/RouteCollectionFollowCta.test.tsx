import { render, screen } from "@testing-library/react";
import { RouteCollectionFollowCta } from "./RouteCollectionFollowCta";
import { withQueryClient } from "@/hooks/test-utils";

const authState = vi.hoisted(() => ({
  isAuthenticated: false,
  accessToken: null as string | null,
}));

const getBySlug = vi.hoisted(() => vi.fn());

vi.mock("@/stores/auth", () => ({
  useAuthStore: (
    selector: (state: {
      isAuthenticated: boolean;
      accessToken: string | null;
    }) => unknown,
  ) => selector(authState),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    routeCollectionsApi: {
      ...actual.routeCollectionsApi,
      getBySlug,
    },
  };
});

describe("RouteCollectionFollowCta", () => {
  beforeEach(() => {
    authState.isAuthenticated = false;
    authState.accessToken = null;
    getBySlug.mockReset();
  });

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

  it("links owners back to the collection dashboard", async () => {
    authState.isAuthenticated = true;
    authState.accessToken = "owner-token";
    getBySlug.mockResolvedValue({
      data: { viewer_is_owner: true, viewer_is_following: false },
    });

    render(
      <RouteCollectionFollowCta
        collectionId="collection-1"
        slug="alpine-weekend"
        ownerName="Mira"
      />,
      { wrapper: withQueryClient() },
    );

    const dashboardLink = await screen.findByRole("link", {
      name: "Manage routes, visibility, and sharing from your dashboard.",
    });

    expect(dashboardLink).toHaveAttribute("href", "/community/collections");
  });
});
