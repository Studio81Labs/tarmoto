import { afterEach, describe, expect, it, vi } from "vitest";
import { getUserFacingErrorMessage } from "@/i18n";
import { ApiError, openApiData, withDocumentLanguage } from "./client";

const { authState, getSessionSpy, translateSpy } = vi.hoisted(() => ({
  authState: {
    accessToken: "stale-token" as string | null,
    clearSession: vi.fn(),
    setSession: vi.fn(),
  },
  getSessionSpy: vi.fn(),
  translateSpy: vi.fn(),
}));

vi.mock("@/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/i18n")>();
  return {
    ...actual,
    t: (...args: Parameters<typeof actual.t>) => {
      translateSpy(...args);
      return actual.t(...args);
    },
  };
});

vi.mock("next-auth/react", () => ({ getSession: getSessionSpy }));

vi.mock("@/lib/config", () => ({
  API_HOST: "https://api.example.test",
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: {
    getState: () => authState,
  },
}));

afterEach(() => {
  authState.accessToken = "stale-token";
  authState.clearSession.mockClear();
  authState.setSession.mockClear();
  getSessionSpy.mockReset();
  translateSpy.mockClear();
  vi.unstubAllGlobals();
});

describe("openApiData", () => {
  it("returns the data on a 2xx result", async () => {
    const result = await openApiData(
      Promise.resolve({
        data: { id: "c1" },
        response: new Response(null, { status: 200 }),
      }),
    );
    expect(result).toEqual({ data: { id: "c1" } });
  });

  it("throws ApiError when openapi-fetch populates `error`", async () => {
    document.documentElement.lang = "en-GB";
    await expect(
      openApiData(
        Promise.resolve({
          error: { message: "nope" },
          response: new Response(null, { status: 400 }),
        }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: "Some information is invalid. Check it and try again.",
      localizedUserMessage: true,
    });
    expect(translateSpy).toHaveBeenCalledWith(
      "Some information is invalid. Check it and try again.",
      undefined,
      "en",
    );
  });

  it("throws on a non-2xx response even when `error` is empty (empty-body 5xx)", async () => {
    // openapi-fetch leaves `error` unset for a Content-Length: 0 error body.
    // openApiData must still throw so callers don't treat a failed write as a
    // phantom success (e.g. removing a collection from local cache).
    const promise = openApiData(
      Promise.resolve({
        data: undefined,
        error: undefined,
        response: new Response(null, { status: 502 }),
      }),
    );
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({
      status: 502,
      message: "The server is temporarily unavailable. Try again shortly.",
      localizedUserMessage: true,
    });
  });

  it("does not trust arbitrary ApiError messages by default", () => {
    expect(
      getUserFacingErrorMessage(
        new ApiError("raw server detail", 400, null),
        "Safe fallback",
      ),
    ).toBe("Safe fallback");
  });
});

describe("withDocumentLanguage", () => {
  it("binds backend requests to the active document language", () => {
    document.documentElement.lang = "en-GB";
    const original = new Request(
      "https://api.example.test/api/v1/auth/register",
    );
    const request = withDocumentLanguage(original);

    expect(request).toBe(original);
    expect(request.headers.get("Accept-Language")).toBe("en");
  });

  it("preserves an explicit per-request language", () => {
    document.documentElement.lang = "en";
    const request = withDocumentLanguage(
      new Request("https://api.example.test/api/v1/auth/register", {
        headers: { "Accept-Language": "cs-CZ" },
      }),
    );

    expect(request.headers.get("Accept-Language")).toBe("cs-CZ");
  });

  it("preserves a mutation body through the composed 401 refresh path", async () => {
    document.documentElement.lang = "en-GB";
    getSessionSpy.mockResolvedValue({
      accessToken: "fresh-token",
      error: undefined,
    });

    const calls: Array<{
      authorization: string | null;
      language: string | null;
      body: string | null;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : null;
        const headers =
          request?.headers ??
          (init?.headers instanceof Headers
            ? init.headers
            : new Headers(init?.headers));
        let body: string | null = null;
        if (request?.body) {
          body = await request.clone().text();
        } else if (init?.body instanceof ArrayBuffer) {
          body = new TextDecoder().decode(init.body);
        } else if (typeof init?.body === "string") {
          body = init.body;
        }
        calls.push({
          authorization: headers.get("Authorization"),
          language: headers.get("Accept-Language"),
          body,
        });
        return new Response(JSON.stringify({ id: "trip-1" }), {
          status: calls.length === 1 ? 401 : 201,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    // openapi-fetch captures global fetch when the client is created.
    vi.resetModules();
    const { api: composedApi } = await import("./client");
    await composedApi.POST(
      "/api/v1/trips" as never,
      { body: { name: "Stelvio loop" } } as never,
    );

    expect(calls).toEqual([
      {
        authorization: "Bearer stale-token",
        language: "en",
        body: JSON.stringify({ name: "Stelvio loop" }),
      },
      {
        authorization: "Bearer fresh-token",
        language: "en",
        body: JSON.stringify({ name: "Stelvio loop" }),
      },
    ]);
    expect(getSessionSpy).toHaveBeenCalledTimes(1);
    expect(authState.clearSession).not.toHaveBeenCalled();
  });
});
