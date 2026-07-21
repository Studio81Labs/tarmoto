import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerUser } from "./auth";
import { api, ApiError } from "./client";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return {
    ...actual,
    api: { ...actual.api, POST: vi.fn() },
  };
});

const postMock = vi.mocked(api.POST);

describe("registerUser", () => {
  beforeEach(() => postMock.mockReset());

  it("maps an email conflict to cataloged registration-specific copy", async () => {
    const body = { message: "backend-authored conflict text" };
    postMock.mockResolvedValueOnce({
      error: body,
      response: new Response(null, { status: 409 }),
    } as Awaited<ReturnType<typeof api.POST>>);

    const request = registerUser("taken@example.com", "StrongPass1!", "Rider");

    await expect(request).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      message: "An account with that email already exists",
      body,
    } satisfies Partial<ApiError>);
  });
});
