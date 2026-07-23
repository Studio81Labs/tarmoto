import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api";
import { FEATURE_LIMIT_EXCEEDED } from "@tarmoto/shared";
import { isFeatureLimitError, tierLabel } from "./entitlements";

describe("isFeatureLimitError", () => {
  it("recognizes a 403 with the FEATURE_LIMIT_EXCEEDED code", () => {
    const err = new ApiError("limit exceeded", 403, {
      code: FEATURE_LIMIT_EXCEEDED,
    });
    expect(isFeatureLimitError(err)).toBe(true);
  });
  it("rejects other 403s and non-ApiError values", () => {
    expect(
      isFeatureLimitError(new ApiError("other", 403, { code: "OTHER" })),
    ).toBe(false);
    expect(isFeatureLimitError(new ApiError("server error", 500, {}))).toBe(
      false,
    );
    expect(isFeatureLimitError(new Error("nope"))).toBe(false);
  });
});

describe("tierLabel", () => {
  it("maps tiers to display names", () => {
    expect(tierLabel("free")).toBe("Free");
    expect(tierLabel("pro")).toBe("Pro");
    expect(tierLabel("premium")).toBe("Premium");
  });
});
