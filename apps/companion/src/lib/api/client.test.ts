import { afterEach, describe, expect, it, vi } from "vitest";
import { getUserFacingErrorMessage } from "@/i18n";
import { ApiError, openApiData } from "./client";

const { translateSpy } = vi.hoisted(() => ({ translateSpy: vi.fn() }));

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

afterEach(() => translateSpy.mockClear());

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
