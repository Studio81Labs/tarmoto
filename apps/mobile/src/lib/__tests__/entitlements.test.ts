jest.mock("@/services/typedClient", () => ({
  client: {
    GET: jest.fn(),
    POST: jest.fn(),
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
  storeTokens: jest.fn(),
  rawFetch: jest.fn(),
}));

jest.mock("@/services/pushRegistration", () => ({
  registerForPush: jest.fn(),
  unregisterPush: jest.fn(),
}));

import { FEATURE_LIMIT_EXCEEDED } from "@tarmoto/shared";
import { ApiError } from "@/services/api";
import { isFeatureLimitError } from "@/lib/entitlements";

it("isFeatureLimitError is true only on a 403 with the FEATURE_LIMIT_EXCEEDED code", () => {
  expect(
    isFeatureLimitError(
      new ApiError("x", 403, { code: FEATURE_LIMIT_EXCEEDED }),
    ),
  ).toBe(true);
  expect(
    isFeatureLimitError(
      new ApiError("x", 403, { message: "Feature unavailable: gpx_export" }),
    ),
  ).toBe(false);
  expect(
    isFeatureLimitError(
      new ApiError("x", 404, { code: FEATURE_LIMIT_EXCEEDED }),
    ),
  ).toBe(false);
  expect(isFeatureLimitError(new Error("nope"))).toBe(false);
});
