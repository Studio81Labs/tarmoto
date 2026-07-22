import {
  challengeContentKeyForMetric,
  isDistanceChallengeMetric,
} from "./gamification";

describe("challenge metric compatibility", () => {
  it.each([
    ["total_distance", "total_distance"],
    ["roads_discovered", "roads_discovered"],
    ["total_km", "total_distance"],
    ["unique_segments", "roads_discovered"],
  ])("maps %s to the %s catalog key", (metric, contentKey) => {
    expect(challengeContentKeyForMetric(metric)).toBe(contentKey);
  });

  it("leaves unknown custom metrics without invented catalog copy", () => {
    expect(challengeContentKeyForMetric("future_metric")).toBeNull();
  });

  it("recognizes canonical and legacy distance metrics", () => {
    expect(isDistanceChallengeMetric("total_distance")).toBe(true);
    expect(isDistanceChallengeMetric("single_ride")).toBe(true);
    expect(isDistanceChallengeMetric("total_km")).toBe(true);
    expect(isDistanceChallengeMetric("unique_segments")).toBe(false);
  });
});
