import { describe, it, expect } from "vitest";
import {
  canSelectQualityAtZoom,
  resolveQualityLayerMaxZoom,
  shouldPromptQualityZoom,
  QUALITY_OVERLAY_UNLIMITED_MAX_ZOOM,
  QUALITY_OVERLAY_FREE_CAP_ZOOM,
} from "./map-entitlements";

describe("resolveQualityLayerMaxZoom", () => {
  it("fails closed to the free cap while unresolved with no known cap", () => {
    // Per the spec the limit feeds maxzoom directly (overlay stops past the
    // cap) — free rider caps at zoom 12 while unresolved.
    expect(resolveQualityLayerMaxZoom(null, false)).toBe(
      QUALITY_OVERLAY_FREE_CAP_ZOOM,
    );
    expect(resolveQualityLayerMaxZoom(12, false)).toBe(
      QUALITY_OVERLAY_FREE_CAP_ZOOM,
    );
  });

  it("preserves a STRICTER known cap while unresolved (does not widen to the free cap)", () => {
    // /users/me supplied a below-free cap but /config/limits is failing (or the
    // rider is mid-hydration): keep the stricter finite value, never widen to 12.
    expect(resolveQualityLayerMaxZoom(5, false)).toBe(5);
    expect(resolveQualityLayerMaxZoom(0, false)).toBe(0); // cap 0 → overlay off
  });

  it("does not RAISE above the free cap while unresolved even if a higher limit is known", () => {
    // A known cap above the free tier can't be trusted until fully resolved —
    // clamp to the free cap during the outage (fail closed, never widen).
    expect(resolveQualityLayerMaxZoom(20, false)).toBe(
      QUALITY_OVERLAY_FREE_CAP_ZOOM,
    );
  });
  it("returns the source ceiling (18) for a resolved unlimited cap", () => {
    expect(resolveQualityLayerMaxZoom(null, true)).toBe(
      QUALITY_OVERLAY_UNLIMITED_MAX_ZOOM,
    );
  });
  it("feeds a resolved finite cap DIRECTLY into maxzoom (overlay stops past the cap)", () => {
    expect(resolveQualityLayerMaxZoom(12, true)).toBe(12);
    expect(resolveQualityLayerMaxZoom(14, true)).toBe(14);
  });

  it("clamps a finite cap at/above the source ceiling (18) so maxzoom stays valid", () => {
    // Beyond the vector source's max the overlay over-zooms anyway, and the cap
    // must stay in MapLibre's valid range even if an operator sets it very high.
    expect(resolveQualityLayerMaxZoom(18, true)).toBe(18);
    expect(resolveQualityLayerMaxZoom(20, true)).toBe(
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

describe("canSelectQualityAtZoom", () => {
  it("allows quality selection only below the overlay's exclusive maxzoom", () => {
    // Free rider (maxzoom 12): selectable up to <12, blocked at/above the cap so
    // a capped visitor can't pull gated quality detail past where the overlay
    // renders.
    expect(canSelectQualityAtZoom(true, 11.5, 12)).toBe(true);
    expect(canSelectQualityAtZoom(true, 12, 12)).toBe(false);
    expect(canSelectQualityAtZoom(true, 14, 12)).toBe(false);
  });

  it("blocks quality selection entirely for an at/below-floor cap (maxzoom 5)", () => {
    // The hit layer only exists at zoom >= 10, and 10 is already past a maxzoom
    // of 5 → never selectable (no leak on a low operator/per-user cap).
    expect(canSelectQualityAtZoom(true, 10, 5)).toBe(false);
    expect(canSelectQualityAtZoom(true, 12, 5)).toBe(false);
  });

  it("never selects when the quality overlay is off", () => {
    expect(canSelectQualityAtZoom(false, 8, 18)).toBe(false);
  });

  it("allows an unlimited rider up to the source ceiling (18)", () => {
    expect(canSelectQualityAtZoom(true, 16, 18)).toBe(true);
    expect(canSelectQualityAtZoom(true, 18, 18)).toBe(false);
  });
});
