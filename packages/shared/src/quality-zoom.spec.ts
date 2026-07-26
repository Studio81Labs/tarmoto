import { describe, it, expect } from "vitest";
import {
  clampQualityMaxZoom,
  QUALITY_OVERLAY_FREE_CAP_ZOOM,
} from "./quality-zoom";

describe("clampQualityMaxZoom", () => {
  it("feeds a resolved finite cap directly, clamped to the source ceiling", () => {
    expect(clampQualityMaxZoom(12, true, 18)).toBe(12);
    expect(clampQualityMaxZoom(14, true, 18)).toBe(14);
    expect(clampQualityMaxZoom(20, true, 18)).toBe(18); // clamp to ceiling
  });
  it("maps a resolved unlimited (null) cap to the source ceiling", () => {
    expect(clampQualityMaxZoom(null, true, 18)).toBe(18);
    expect(clampQualityMaxZoom(null, true, 22)).toBe(22); // platform ceiling honoured
  });
  it("fails closed to the free cap while unresolved with no known cap", () => {
    expect(clampQualityMaxZoom(null, false, 18)).toBe(
      QUALITY_OVERLAY_FREE_CAP_ZOOM,
    );
  });
  it("preserves a stricter known finite cap while unresolved (never widens)", () => {
    expect(clampQualityMaxZoom(5, false, 18)).toBe(5);
    expect(clampQualityMaxZoom(20, false, 18)).toBe(
      QUALITY_OVERLAY_FREE_CAP_ZOOM,
    ); // >free → free
  });
});
