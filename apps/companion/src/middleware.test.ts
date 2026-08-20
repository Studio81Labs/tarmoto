const authMock = vi.hoisted(() =>
  vi.fn((handler: (req: MiddlewareRequest) => Response | undefined) => handler),
);

type MiddlewareRequest = {
  nextUrl: URL;
  headers: Headers;
  auth: { user: { id: string } } | null;
};

vi.mock("@/lib/auth", () => ({
  auth: authMock,
}));

import { middleware } from "./middleware";

function requestFor(
  pathname: string,
  options: { authenticated?: boolean; cookie?: string } = {},
): MiddlewareRequest {
  return {
    nextUrl: new URL(pathname, "https://companion.tarmoto.test"),
    headers: new Headers(options.cookie ? { cookie: options.cookie } : {}),
    auth: options.authenticated ? { user: { id: "rider-1" } } : null,
  };
}

async function runMiddleware(
  pathname: string,
  options: { authenticated?: boolean; cookie?: string } = {},
) {
  return await middleware(
    requestFor(pathname, options) as unknown as Parameters<
      typeof middleware
    >[0],
    {} as Parameters<typeof middleware>[1],
  );
}

// Every page response — pass-throughs included — now carries the
// per-request Content-Security-Policy, so the old "returns undefined"
// contract became "returns a pass-through with the policy". The nonce must
// ALSO be forwarded on the request (Next stamps it onto its framework
// inline scripts from there); forwarded request headers surface as
// x-middleware-request-* on the response meta.
function expectPassThroughWithCsp(response: Response | undefined | void) {
  expect(response).toBeInstanceOf(Response);
  expect(response?.headers.get("x-middleware-next")).toBe("1");
  expect(response?.headers.get("location")).toBeNull();
  const csp = response?.headers.get("content-security-policy");
  expect(csp).toContain("default-src 'self'");
  expect(csp).toMatch(
    /script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/,
  );
  expect(
    response?.headers.get("x-middleware-request-content-security-policy"),
  ).toBe(csp);
  expect(response?.headers.get("x-middleware-request-x-nonce")).toBeTruthy();
}

describe("companion middleware", () => {
  it.each(["/community/collections/shared/alpine-weekend"])(
    "allows logged-out visitors to public route %s",
    async (pathname) => {
      expectPassThroughWithCsp(await runMiddleware(pathname));
    },
  );

  it.each([
    "/rides/shared/share-token",
    "/rides/road-map/shared/map-token",
    "/trips/shared/trip-token",
  ])(
    "keeps existing public route %s accessible without auth",
    async (pathname) => {
      expectPassThroughWithCsp(await runMiddleware(pathname));
    },
  );

  it("redirects logged-out dashboard visitors to login with a callback", async () => {
    const response = await runMiddleware("/trips");

    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(
      "https://companion.tarmoto.test/login?callbackUrl=%2Ftrips",
    );
    // Redirects render nothing — no policy needed, and none is attached.
    expect(response?.headers.get("content-security-policy")).toBeNull();
  });

  it("lets unknown logged-out routes reach the app-level 404 (with the policy)", async () => {
    expectPassThroughWithCsp(await runMiddleware("/nonexistent"));
  });

  it("allows authenticated dashboard visitors through (with the policy)", async () => {
    expectPassThroughWithCsp(
      await runMiddleware("/trips", { authenticated: true }),
    );
  });

  it("guards the post-registration plan step and lets the new rider in", async () => {
    // #1173. Two things at once: the step reads the rider's own billing
    // snapshot, so a logged-out visit must bounce; and it must NOT be treated
    // as an auth page — a just-registered rider IS authenticated, so a route
    // under `/register` would have been redirected straight back to `/` by the
    // `isAuthPage` prefix rule below.
    const loggedOut = await runMiddleware("/welcome/plan");
    expect(loggedOut?.status).toBe(302);
    expect(loggedOut?.headers.get("location")).toBe(
      "https://companion.tarmoto.test/login?callbackUrl=%2Fwelcome%2Fplan",
    );

    expectPassThroughWithCsp(
      await runMiddleware("/welcome/plan", { authenticated: true }),
    );
  });

  it("stays out of API routes entirely — NextAuth owns those responses", async () => {
    expect(await runMiddleware("/api/auth/session")).toBeUndefined();
  });

  it("issues a fresh nonce per request", async () => {
    const first = await runMiddleware("/explore");
    const second = await runMiddleware("/explore");
    const nonceOf = (r: Response | undefined | void) =>
      r?.headers.get("content-security-policy")?.match(/'nonce-([^']+)'/)?.[1];
    expect(nonceOf(first)).toBeTruthy();
    expect(nonceOf(first)).not.toBe(nonceOf(second));
  });

  it("binds a valid public URL locale to the rewritten request and cookie", async () => {
    const response = await runMiddleware("/roads/best?lang=en");

    expectPassThroughWithCsp(response);
    expect(
      response?.headers.get("x-middleware-request-x-tarmoto-public-locale"),
    ).toBe("en");
    expect(response?.headers.get("set-cookie")).toContain("tarmoto-locale=en");
  });

  it.each(["/explore", "/roads/best", "/roads/best/AT/Tyrol"])(
    "binds clean localized public route %s to the default locale without changing the cookie",
    async (pathname) => {
      const response = await runMiddleware(pathname, {
        cookie: "tarmoto-locale=cs",
      });

      expectPassThroughWithCsp(response);
      expect(
        response?.headers.get("x-middleware-request-x-tarmoto-public-locale"),
      ).toBe("en");
      expect(response?.headers.get("set-cookie")).toBeNull();
    },
  );

  it("ignores unsupported public URL locales but still serves the policy", async () => {
    const response = await runMiddleware("/roads/best?lang=unsupported");

    expectPassThroughWithCsp(response);
    expect(
      response?.headers.get("x-middleware-request-x-tarmoto-public-locale"),
    ).toBeNull();
    expect(response?.headers.get("set-cookie")).toBeNull();
  });
});
