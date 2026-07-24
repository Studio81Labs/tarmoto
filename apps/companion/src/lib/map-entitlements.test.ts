import { describe, it, expect } from "vitest";
import {
  resolveQualityLayerMaxZoom,
  shouldPromptQualityZoom,
  QUALITY_OVERLAY_UNLIMITED_MAX_ZOOM,
  QUALITY_OVERLAY_FREE_CAP_ZOOM,
} from "./map-entitlements";

describe("resolveQualityLayerMaxZoom", () => {
  it("fails closed to the free cap + 1 while unresolved with no known cap (level 12 still visible)", () => {
    // MapLibre maxzoom is exclusive → cap+1 keeps the entitled level rendering.
    expect(resolveQualityLayerMaxZoom(null, false)).toBe(
      QUALITY_OVERLAY_FREE_CAP_ZOOM + 1,
    );
    expect(resolveQualityLayerMaxZoom(12, false)).toBe(
      QUALITY_OVERLAY_FREE_CAP_ZOOM + 1,
    );
  });

  it("preserves a STRICTER known cap while unresolved (does not widen to the free cap)", () => {
    // /users/me supplied a below-free cap but /config/limits is failing (or the
    // rider is mid-hydration): keep the stricter finite value, never widen to 12.
    expect(resolveQualityLayerMaxZoom(5, false)).toBe(6);
    expect(resolveQualityLayerMaxZoom(0, false)).toBe(1); // cap 0 → only level 0
  });

  it("does not RAISE above the free cap while unresolved even if a higher limit is known", () => {
    // A known cap above the free tier can't be trusted until fully resolved —
    // clamp to the free cap during the outage (fail closed, never widen).
    expect(resolveQualityLayerMaxZoom(20, false)).toBe(
      QUALITY_OVERLAY_FREE_CAP_ZOOM + 1,
    );
  });
  it("returns the render ceiling for a resolved unlimited cap (never hidden)", () => {
    expect(resolveQualityLayerMaxZoom(null, true)).toBe(
      QUALITY_OVERLAY_UNLIMITED_MAX_ZOOM,
    );
  });
  it("returns a resolved finite cap + 1 (exclusive — the capped level stays visible)", () => {
    expect(resolveQualityLayerMaxZoom(12, true)).toBe(13);
    expect(resolveQualityLayerMaxZoom(14, true)).toBe(15);
  });

  it("clamps a finite cap at/above the MapLibre ceiling (24) so maxzoom stays valid", () => {
    // MapLibre maxzoom is [0, 24]; the admin DTO allows caps ≥ 24, so cap+1
    // must not exceed 24.
    expect(resolveQualityLayerMaxZoom(23, true)).toBe(24);
    expect(resolveQualityLayerMaxZoom(24, true)).toBe(
      QUALITY_OVERLAY_UNLIMITED_MAX_ZOOM,
    );
    expect(resolveQualityLayerMaxZoom(100, true)).toBe(
      QUALITY_OVERLAY_UNLIMITED_MAX_ZOOM,
    );
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

  // The QualityMap effect re-evaluates this predicate against the CURRENT zoom
  // whenever `showQuality`/`capFinite`/`cap` change — not just on `moveend`.
  // These two transitions are the ones a move-only check misses.
  it("prompts when the overlay is toggled ON while the map already sits above the cap", () => {
    // showQuality flips false→true at zoom 14, cap 12 — no map move occurs.
    expect(shouldPromptQualityZoom({ ...base, showQuality: true })).toBe(true);
  });

  it("prompts when the cap RESOLVES finite while the map is already above it", () => {
    // capFinite flips false→true (async entitlement settles) at zoom 14 with no
    // move — the layer would clamp silently without this re-evaluation.
    expect(shouldPromptQualityZoom({ ...base, capFinite: true })).toBe(true);
  });
});
