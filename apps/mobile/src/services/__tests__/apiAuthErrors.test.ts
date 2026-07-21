const mockPost = jest.fn();
const mockStoreTokens = jest.fn();

jest.mock("../typedClient", () => ({
  client: {
    GET: jest.fn(),
    POST: (...args: unknown[]) => mockPost(...args),
    PATCH: jest.fn(),
    PUT: jest.fn(),
    DELETE: jest.fn(),
  },
  clearTokens: jest.fn(),
  getAccessToken: jest.fn(() => null),
  getAuthenticatedUserId: jest.fn(() => null),
  getCachedUser: jest.fn(() => null),
  isAuthenticated: jest.fn(() => false),
  setCachedUser: jest.fn(),
  setAuthenticatedUserId: jest.fn(),
  storeTokens: (...args: unknown[]) => mockStoreTokens(...args),
  rawFetch: jest.fn(),
}));

jest.mock("@/services/pushRegistration", () => ({
  registerForPush: jest.fn(),
  unregisterPush: jest.fn(),
}));

import { api, ApiError } from "../api";

function failure(status: number, body: unknown) {
  return {
    error: body,
    response: { status } as Response,
  };
}

describe("api auth errors", () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockStoreTokens.mockReset();
  });

  it("maps invalid login credentials to auth-specific catalog copy", async () => {
    const body = { message: "Invalid credentials" };
    mockPost.mockResolvedValueOnce(failure(401, body));

    await expect(
      api.login("rider@example.com", "wrong-password"),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      message: "Invalid email or password",
      body,
    } satisfies Partial<ApiError>);
    expect(mockStoreTokens).not.toHaveBeenCalled();
  });

  it("maps registration conflicts to endpoint-specific catalog copy", async () => {
    const body = { message: "backend-authored conflict text" };
    mockPost.mockResolvedValueOnce(failure(409, body));

    await expect(
      api.register("taken@example.com", "StrongPass1!", "Rider"),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      message: "An account with that email already exists",
      body,
    } satisfies Partial<ApiError>);
    expect(mockStoreTokens).not.toHaveBeenCalled();
  });
});
