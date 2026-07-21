/**
 * Pure formatting and classification helpers from lib/utils.ts.
 *
 * These are the first companion tests and establish the pattern:
 * - Unit tests for pure functions live next to source under __tests__/
 * - Vitest globals (describe/it/expect) available without imports
 */

import { confidenceLabel, rideTypeLabel, scoreToTier } from "../utils";

describe("scoreToTier", () => {
  it.each([
    [5.0, "excellent"],
    [4.5, "excellent"],
    [4.0, "good"],
    [3.5, "good"],
    [3.0, "fair"],
    [2.5, "fair"],
    [2.0, "poor"],
    [1.5, "poor"],
    [1.0, "very-poor"],
    [0.0, "very-poor"],
  ])('maps score %s to tier "%s"', (score, expected) => {
    expect(scoreToTier(score)).toBe(expected);
  });
});

describe("confidenceLabel", () => {
  it.each([
    [0.9, "High"],
    [0.8, "High"],
    [0.7, "Medium"],
    [0.5, "Medium"],
    [0.4, "Low"],
    [0.0, "Low"],
  ])('maps confidence %s to "%s"', (confidence, expected) => {
    expect(confidenceLabel(confidence)).toBe(expected);
  });
});

describe("rideTypeLabel", () => {
  it.each([
    ["free", "Free"],
    ["commute", "Commute"],
    ["trip", "Trip"],
    ["tracked", "Tracked"],
    ["future_backend_value", "Ride"],
  ])('maps ride type %s to the catalog key "%s"', (value, expected) => {
    expect(rideTypeLabel(value)).toBe(expected);
  });
});
