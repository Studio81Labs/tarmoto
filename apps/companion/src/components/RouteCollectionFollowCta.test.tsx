import { render, screen } from "@testing-library/react";
import { RouteCollectionFollowCta } from "./RouteCollectionFollowCta";
import { withQueryClient } from "@/hooks/test-utils";

const authState = vi.hoisted(() => ({
  isAuthenticated: false,
  accessToken: null as string | null,
}));

const getBySlug = vi.hoisted(() => vi.fn());

// Kill switches fail SAFE (enabled until a confirmed `force_off`).
const killSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/hooks/useEntitlements", () => ({
  useFeatureKillSwitch: () => ({
    enabled: killSwitch.enabled,
    isResolved: true,
  }),
}));

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
    killSwitch.enabled = true;
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

  it("renders nothing on the PUBLIC shared page when community access is killed", async () => {
    // This CTA sits outside the `(dashboard)/community` layout the switch
    // otherwise covers, so anyone holding the share link could keep mutating
    // follows during a kill. The preview around it stays readable; the CTA
    // goes entirely — the signed-OUT branch is just as dead, since it invites
    // a sign-in in order to perform the killed action.
    killSwitch.enabled = false;
    authState.isAuthenticated = true;
    authState.accessToken = "viewer-token";
    getBySlug.mockResolvedValue({
      data: { viewer_is_owner: false, viewer_is_following: false },
    });

    const { container } = render(
      <RouteCollectionFollowCta
        collectionId="collection-1"
        slug="alpine-weekend"
        ownerName="Mira"
      />,
      { wrapper: withQueryClient() },
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
