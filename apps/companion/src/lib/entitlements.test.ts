import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api";
import { FEATURE_LIMIT_EXCEEDED } from "@tarmoto/shared";
import {
  isFeatureLimitError,
  parseFeatureLimitError,
  tierLabel,
} from "./entitlements";

const limitBody = {
  code: FEATURE_LIMIT_EXCEEDED,
  feature: "max_active_trips",
  limit: 1,
  current: 1,
};

describe("parseFeatureLimitError", () => {
  it("returns the authoritative feature/limit/current on a matching 403", () => {
    const err = new ApiError("limit exceeded", 403, limitBody);
    expect(parseFeatureLimitError(err)).toEqual({
      feature: "max_active_trips",
      limit: 1,
      current: 1,
    });
  });
  it("returns null for other 403s, missing detail fields, and non-ApiError values", () => {
    expect(
      parseFeatureLimitError(new ApiError("other", 403, { code: "OTHER" })),
    ).toBeNull();
    // Right code but the detail fields are absent → can't trust it as authoritative.
    expect(
      parseFeatureLimitError(
        new ApiError("partial", 403, { code: FEATURE_LIMIT_EXCEEDED }),
      ),
    ).toBeNull();
    expect(
      parseFeatureLimitError(new ApiError("server error", 500, limitBody)),
    ).toBeNull();
    expect(parseFeatureLimitError(new Error("nope"))).toBeNull();
  });
});

describe("isFeatureLimitError", () => {
  it("recognizes a matching 403 and rejects everything else", () => {
    expect(
      isFeatureLimitError(new ApiError("limit exceeded", 403, limitBody)),
    ).toBe(true);
    expect(
      isFeatureLimitError(new ApiError("other", 403, { code: "OTHER" })),
    ).toBe(false);
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
