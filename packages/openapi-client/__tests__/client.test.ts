import { describe, it, expect, vi, afterEach } from "vitest";
import { createTarmotoClient } from "../src/client";

// openapi-fetch captures globalThis.fetch at createClient() time, so we
// must stub the global before creating the client in each test that
// needs to inspect the outgoing request.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createTarmotoClient", () => {
  it("should create a client with the given baseUrl", () => {
    const client = createTarmotoClient({
      baseUrl: "http://localhost:3000/api/v1",
    });
    expect(client).toBeDefined();
    expect(client.GET).toBeDefined();
    expect(client.POST).toBeDefined();
  });

  it("should work without getToken option", () => {
    const client = createTarmotoClient({
      baseUrl: "http://localhost:3000/api/v1",
    });
    expect(client).toBeDefined();
  });

  it("should attach Bearer token when getToken returns a value", async () => {
    let capturedRequest: Request | undefined;

    // Stub fetch BEFORE creating the client so openapi-fetch picks it up
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        capturedRequest = input instanceof Request ? input : new Request(input);
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = createTarmotoClient({
      baseUrl: "http://localhost:3000/api/v1",
      getToken: () => "test-token-123",
    });

    await client.GET("/api/v1/rides" as never);

    expect(globalThis.fetch).toHaveBeenCalled();
    expect(capturedRequest?.headers.get("Authorization")).toBe(
      "Bearer test-token-123",
    );
  });

  it("should not attach auth header when getToken returns null", async () => {
    let capturedRequest: Request | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        capturedRequest = input instanceof Request ? input : new Request(input);
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = createTarmotoClient({
      baseUrl: "http://localhost:3000/api/v1",
      getToken: () => null,
    });

    await client.GET("/api/v1/rides" as never);

    expect(capturedRequest?.headers.get("Authorization")).toBeNull();
  });

  describe("401 handling", () => {
    function stubFetchSequence(
      responses: Array<{ status: number; body?: unknown }>,
    ) {
      const calls: Array<{
        url: string;
        method: string;
        authorization: string | null;
        body: string | null;
        bodyBytes: Uint8Array | null;
      }> = [];
      let i = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const req = input instanceof Request ? input : null;
          // openapi-fetch sends the original request as a Request
          // object with `body` set to its serialized stream. The
          // 401 replay path goes through bare `fetch(url, { body })`
          // with `body` set to the ArrayBuffer we cached in
          // onRequest — so handle both shapes.
          let bodyBytes: Uint8Array | null = null;
          if (req?.body) {
            bodyBytes = new Uint8Array(await req.clone().arrayBuffer());
          } else if (init?.body instanceof ArrayBuffer) {
            bodyBytes = new Uint8Array(init.body);
          } else if (typeof init?.body === "string") {
            bodyBytes = new TextEncoder().encode(init.body);
          }
          calls.push({
            url: req?.url ?? String(input),
            method: req?.method ?? init?.method ?? "GET",
            authorization:
              req?.headers.get("Authorization") ??
              (init?.headers instanceof Headers
                ? init.headers.get("Authorization")
                : (init?.headers as Record<string, string> | undefined)?.[
                    "Authorization"
                  ]) ??
              null,
            body: bodyBytes ? new TextDecoder().decode(bodyBytes) : null,
            bodyBytes,
          });
          const next = responses[i++] ?? responses[responses.length - 1];
          if (!next) {
            throw new Error("stubFetchSequence called with no responses");
          }
          return new Response(JSON.stringify(next.body ?? {}), {
            status: next.status,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );
      return calls;
    }

    it("calls onUnauthorized on 401 when no retry hook is configured", async () => {
      stubFetchSequence([{ status: 401, body: { message: "Unauthorized" } }]);
      const onUnauthorized = vi.fn();
      const client = createTarmotoClient({
        baseUrl: "http://localhost:3000/api/v1",
        getToken: () => "stale-token",
        onUnauthorized,
      });
      await client.GET("/api/v1/rides" as never);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("replays the request once with the fresh token when retry succeeds", async () => {
      const calls = stubFetchSequence([
        { status: 401, body: { message: "Unauthorized" } },
        { status: 200, body: { id: "trip-1" } },
      ]);
      const onUnauthorized = vi.fn();
      const onUnauthorizedRetry = vi.fn(async () => "fresh-token");

      const client = createTarmotoClient({
        baseUrl: "http://localhost:3000/api/v1",
        getToken: () => "stale-token",
        onUnauthorized,
        onUnauthorizedRetry,
      });

      const result = await client.GET("/api/v1/rides" as never);

      expect(onUnauthorizedRetry).toHaveBeenCalledTimes(1);
      expect(onUnauthorized).not.toHaveBeenCalled();
      expect(calls).toHaveLength(2);
      expect(calls[0]?.authorization).toBe("Bearer stale-token");
      expect(calls[1]?.authorization).toBe("Bearer fresh-token");
      // openapi-fetch wraps the replay response — `data` should reflect the 200 body.
      expect((result as { data?: { id: string } }).data?.id).toBe("trip-1");
    });

    it("preserves POST body across the retry", async () => {
      const calls = stubFetchSequence([
        { status: 401, body: { message: "Unauthorized" } },
        { status: 201, body: { id: "trip-1" } },
      ]);
      const onUnauthorizedRetry = vi.fn(async () => "fresh-token");

      const client = createTarmotoClient({
        baseUrl: "http://localhost:3000/api/v1",
        getToken: () => "stale-token",
        onUnauthorizedRetry,
      });

      await client.POST(
        "/api/v1/trips" as never,
        {
          body: { name: "Stelvio loop" },
        } as never,
      );

      expect(calls).toHaveLength(2);
      expect(calls[0]?.body).toBe(JSON.stringify({ name: "Stelvio loop" }));
      expect(calls[1]?.body).toBe(JSON.stringify({ name: "Stelvio loop" }));
      expect(calls[1]?.authorization).toBe("Bearer fresh-token");
    });

    it("preserves binary multipart body bytes across the retry without UTF-8 corruption", async () => {
      const calls = stubFetchSequence([
        { status: 401, body: { message: "Unauthorized" } },
        { status: 201, body: { id: "photo-1" } },
      ]);
      const onUnauthorizedRetry = vi.fn(async () => "fresh-token");

      // Bytes that are NOT valid UTF-8 (lone continuation, unpaired
      // surrogates encoded as raw bytes). Real photo uploads route
      // through `multipart/form-data` with a Blob payload — exactly
      // the shape that breaks if the replay path round-trips the
      // body through `.text()` and re-encodes the replacement
      // character back to bytes.
      const photoBytes = new Uint8Array([
        0xff, 0xfe, 0x80, 0x81, 0xc0, 0xc1, 0xed, 0xa0, 0x80, 0x00, 0x7f,
      ]);
      const formData = new FormData();
      formData.append(
        "photo",
        new Blob([photoBytes], { type: "image/jpeg" }),
        "hazard.jpg",
      );

      const client = createTarmotoClient({
        baseUrl: "http://localhost:3000/api/v1",
        getToken: () => "stale-token",
        onUnauthorizedRetry,
      });

      await client.POST(
        "/api/v1/hazards" as never,
        {
          body: formData,
        } as never,
      );

      expect(calls).toHaveLength(2);
      expect(calls[1]?.authorization).toBe("Bearer fresh-token");
      // The replay must send the EXACT same bytes the server saw on
      // the original 401 — including the binary payload embedded in
      // the multipart serialization. Comparing byte-for-byte catches
      // any UTF-8 round-trip corruption.
      expect(calls[0]?.bodyBytes).toBeTruthy();
      expect(calls[1]?.bodyBytes).toBeTruthy();
      expect(Array.from(calls[1]!.bodyBytes!)).toEqual(
        Array.from(calls[0]!.bodyBytes!),
      );
      // And sanity-check the binary bytes survived inside the
      // multipart payload — replacement characters (0xEF 0xBF 0xBD)
      // would mean we lost them.
      const haystack = calls[1]!.bodyBytes!;
      let found = false;
      for (let i = 0; i <= haystack.length - photoBytes.length; i++) {
        let match = true;
        for (let j = 0; j < photoBytes.length; j++) {
          if (haystack[i + j] !== photoBytes[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    });

    it("falls back to onUnauthorized when retry returns null", async () => {
      stubFetchSequence([{ status: 401, body: { message: "Unauthorized" } }]);
      const onUnauthorized = vi.fn();
      const onUnauthorizedRetry = vi.fn(async () => null);

      const client = createTarmotoClient({
        baseUrl: "http://localhost:3000/api/v1",
        getToken: () => "stale-token",
        onUnauthorized,
        onUnauthorizedRetry,
      });

      await client.GET("/api/v1/rides" as never);

      expect(onUnauthorizedRetry).toHaveBeenCalledTimes(1);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("calls onUnauthorized when the replay also 401s", async () => {
      stubFetchSequence([
        { status: 401, body: { message: "Unauthorized" } },
        { status: 401, body: { message: "Still unauthorized" } },
      ]);
      const onUnauthorized = vi.fn();
      const onUnauthorizedRetry = vi.fn(async () => "fresh-token");

      const client = createTarmotoClient({
        baseUrl: "http://localhost:3000/api/v1",
        getToken: () => "stale-token",
        onUnauthorized,
        onUnauthorizedRetry,
      });

      await client.GET("/api/v1/rides" as never);

      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("deduplicates concurrent refreshes so the refresh token is rotated once", async () => {
      // Three concurrent 401s should share a single refresh call.
      const fetchMock = vi.fn(async () => {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      // First three calls 401, next three (the replays) 200.
      fetchMock
        .mockImplementationOnce(
          async () =>
            new Response(JSON.stringify({}), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            }),
        )
        .mockImplementationOnce(
          async () =>
            new Response(JSON.stringify({}), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            }),
        )
        .mockImplementationOnce(
          async () =>
            new Response(JSON.stringify({}), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const onUnauthorizedRetry = vi.fn(async () => {
        // Simulate the async session refresh — important that all three
        // 401s `await` the same in-flight promise rather than each
        // kicking their own refresh.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "fresh-token";
      });

      const client = createTarmotoClient({
        baseUrl: "http://localhost:3000/api/v1",
        getToken: () => "stale-token",
        onUnauthorizedRetry,
      });

      await Promise.all([
        client.GET("/api/v1/rides" as never),
        client.GET("/api/v1/trips" as never),
        client.GET("/api/v1/passes" as never),
      ]);

      expect(onUnauthorizedRetry).toHaveBeenCalledTimes(1);
      // 3 original + 3 replays
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });
  });
});
