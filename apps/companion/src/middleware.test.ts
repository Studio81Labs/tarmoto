const authMock = vi.hoisted(() =>
  vi.fn((handler: (req: MiddlewareRequest) => Response | undefined) => handler),
);

type MiddlewareRequest = {
  nextUrl: URL;
  auth: { user: { id: string } } | null;
};

vi.mock("@/lib/auth", () => ({
  auth: authMock,
}));

import { middleware } from "./middleware";

function requestFor(
  pathname: string,
  options: { authenticated?: boolean } = {},
): MiddlewareRequest {
  return {
    nextUrl: new URL(pathname, "https://companion.tarmoto.test"),
    auth: options.authenticated ? { user: { id: "rider-1" } } : null,
  };
}

async function runMiddleware(
  pathname: string,
  options: { authenticated?: boolean } = {},
) {
  return await middleware(
    requestFor(pathname, options) as unknown as Parameters<
      typeof middleware
    >[0],
    {} as Parameters<typeof middleware>[1],
  );
}

describe("companion middleware", () => {
  it.each([
    "/embed/roads/CZ/Moravskoslezsky",
    "/community/collections/shared/alpine-weekend",
  ])("allows logged-out visitors to public route %s", async (pathname) => {
    expect(await runMiddleware(pathname)).toBeUndefined();
  });

  it.each([
    "/explore",
    "/discover",
    "/roads/best/AT/Tyrol",
    "/rides/shared/share-token",
    "/rides/road-map/shared/map-token",
    "/trips/shared/trip-token",
    "/embed/rides/ride-token",
  ])(
    "keeps existing public route %s accessible without auth",
    async (pathname) => {
      expect(await runMiddleware(pathname)).toBeUndefined();
    },
  );

  it("redirects logged-out dashboard visitors to login with a callback", async () => {
    const response = await runMiddleware("/trips");

    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(
      "https://companion.tarmoto.test/login?callbackUrl=%2Ftrips",
    );
  });

  it("allows authenticated dashboard visitors through", async () => {
    expect(
      await runMiddleware("/trips", { authenticated: true }),
    ).toBeUndefined();
  });
});
