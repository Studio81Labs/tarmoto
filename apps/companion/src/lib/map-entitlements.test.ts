import { describe, it, expect } from "vitest";
import {
  resolveQualityMaxZoom,
  QUALITY_OVERLAY_CEILING_ZOOM,
  QUALITY_OVERLAY_FLOOR_ZOOM,
} from "./map-entitlements";

describe("resolveQualityMaxZoom", () => {
  it("uses the free floor while the cap is unresolved (fail closed)", () => {
    expect(resolveQualityMaxZoom(null, false)).toBe(QUALITY_OVERLAY_FLOOR_ZOOM);
    expect(resolveQualityMaxZoom(12, false)).toBe(QUALITY_OVERLAY_FLOOR_ZOOM);
  });
  it("maps a resolved unlimited cap (null) to the source ceiling", () => {
    expect(resolveQualityMaxZoom(null, true)).toBe(
      QUALITY_OVERLAY_CEILING_ZOOM,
    );
  });
  it("returns a resolved finite cap as-is", () => {
    expect(resolveQualityMaxZoom(12, true)).toBe(12);
  });
});
