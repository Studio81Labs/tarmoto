import { describe, expect, it } from "vitest";
import { hazardFadeOpacity } from "../utils";

// Helper: ISO string `offsetMs` ms before `now`.
function iso(now: number, offsetMs: number): string {
  return new Date(now + offsetMs).toISOString();
}

describe("hazardFadeOpacity", () => {
  const now = Date.UTC(2026, 3, 15, 12, 0, 0);
  const SPAN = 24 * 60 * 60 * 1000; // 24h

  it("returns 1.0 for a brand-new hazard", () => {
    const created = iso(now, 0);
    const expires = iso(now, SPAN);
    expect(hazardFadeOpacity(created, expires, now)).toBe(1);
  });

  it("returns the floor for an expired hazard", () => {
    const created = iso(now, -SPAN * 2);
    const expires = iso(now, -SPAN);
    expect(hazardFadeOpacity(created, expires, now)).toBe(0.35);
  });

  it("returns roughly halfway at the midpoint", () => {
    const created = iso(now, -SPAN / 2);
    const expires = iso(now, SPAN / 2);
    const opacity = hazardFadeOpacity(created, expires, now);
    expect(opacity).toBeCloseTo((1 + 0.35) / 2, 5);
  });

  it("stays within [min, 1] for any age", () => {
    const created = iso(now, -SPAN * 10);
    const expires = iso(now, -SPAN * 9);
    const opacity = hazardFadeOpacity(created, expires, now);
    expect(opacity).toBeGreaterThanOrEqual(0.35);
    expect(opacity).toBeLessThanOrEqual(1);
  });

  it("respects a different expiry window (shorter hazards fade faster in clock time)", () => {
    // 72h pothole at 36h old → 50% fade
    const longSpan = 72 * 60 * 60 * 1000;
    const longHazard = hazardFadeOpacity(
      iso(now, -longSpan / 2),
      iso(now, longSpan / 2),
      now,
    );
    // 24h oil_spill at 12h old → also 50% fade (same ratio)
    const shortSpan = 24 * 60 * 60 * 1000;
    const shortHazard = hazardFadeOpacity(
      iso(now, -shortSpan / 2),
      iso(now, shortSpan / 2),
      now,
    );
    expect(longHazard).toBeCloseTo(shortHazard, 5);
  });

  it("degrades gracefully on malformed timestamps", () => {
    expect(hazardFadeOpacity("not-a-date", "also-not", now)).toBe(1);
  });

  it("returns 1 when expires_at <= created_at (avoid divide-by-zero)", () => {
    const created = iso(now, 0);
    const expires = iso(now, 0);
    expect(hazardFadeOpacity(created, expires, now)).toBe(1);
  });

  it("honors a custom floor", () => {
    const created = iso(now, -SPAN * 2);
    const expires = iso(now, -SPAN);
    expect(hazardFadeOpacity(created, expires, now, 0.1)).toBe(0.1);
  });
});
