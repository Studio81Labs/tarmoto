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
});
