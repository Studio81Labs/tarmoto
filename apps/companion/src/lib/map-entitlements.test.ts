import { describe, it, expect } from "vitest";
import {
  resolveQualityMaxZoom,
  shouldPromptQualityZoom,
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

describe("shouldPromptQualityZoom", () => {
  const base = {
    showQuality: true,
    capFinite: true,
    zoom: 14,
    cap: 12,
    dismissed: false,
  };

  it("prompts when the overlay is on, the cap is finite, and the rider zoomed past it", () => {
    expect(shouldPromptQualityZoom(base)).toBe(true);
  });

  it("does not prompt when the overlay is off", () => {
    expect(shouldPromptQualityZoom({ ...base, showQuality: false })).toBe(
      false,
    );
  });

  it("does not prompt when the cap is unresolved / unlimited (not finite — pro/premium)", () => {
    expect(shouldPromptQualityZoom({ ...base, capFinite: false })).toBe(false);
  });

  it("does not prompt at or below the cap", () => {
    expect(shouldPromptQualityZoom({ ...base, zoom: 12 })).toBe(false);
    expect(shouldPromptQualityZoom({ ...base, zoom: 11 })).toBe(false);
  });

  it("does not re-prompt once dismissed this session", () => {
    expect(shouldPromptQualityZoom({ ...base, dismissed: true })).toBe(false);
  });
});
