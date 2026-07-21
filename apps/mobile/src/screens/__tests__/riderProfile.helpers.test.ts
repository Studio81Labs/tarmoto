import {
  formatCount,
  formatFollowedSince,
  formatJoinedLabel,
} from "../riderProfile.helpers";

describe("formatJoinedLabel", () => {
  const NOW = new Date("2026-05-01T10:00:00Z");

  it("returns 'Joined this month' for the same calendar month", () => {
    expect(formatJoinedLabel("2026-05-01T10:00:00Z", NOW)).toBe(
      "Joined this month",
    );
  });

  it("backs off a month when the day-of-month hasn't been reached yet", () => {
    // joined Apr 20 → now May 1 = 11 days, not a full month.
    expect(formatJoinedLabel("2026-04-20T10:00:00Z", NOW)).toBe(
      "Joined this month",
    );
  });

  it("renders months for sub-year diffs", () => {
    expect(formatJoinedLabel("2025-11-01T10:00:00Z", NOW)).toBe(
      "Joined 6 months ago",
    );
  });

  it("renders years past the 12-month threshold", () => {
    expect(formatJoinedLabel("2023-04-01T10:00:00Z", NOW)).toBe(
      "Joined 3 years ago",
    );
  });

  it("clamps future timestamps to 'this month' rather than negative buckets", () => {
    expect(formatJoinedLabel("2027-01-01T10:00:00Z", NOW)).toBe(
      "Joined this month",
    );
  });

  it("falls back to 'Joined recently' for unparseable input", () => {
    expect(formatJoinedLabel("not-a-date", NOW)).toBe("Joined recently");
  });
});

describe("formatFollowedSince", () => {
  // Mode-aware label: the Followers screen lists riders who follow the
  // profile owner — labelling those rows "Following since" reads as the
  // viewer following them, which is wrong. Mode flips the leading verb.
  it("renders 'Follower since' on the followers list", () => {
    expect(formatFollowedSince("2026-01-15T10:00:00Z", "followers")).toBe(
      "Follower since Jan 15, 2026",
    );
  });

  it("renders 'Following since' on the following list", () => {
    expect(formatFollowedSince("2026-01-15T10:00:00Z", "following")).toBe(
      "Following since Jan 15, 2026",
    );
  });

  it("falls back to the bare verb for unparseable input", () => {
    expect(formatFollowedSince("not-a-date", "followers")).toBe("Follower");
    expect(formatFollowedSince("not-a-date", "following")).toBe("Following");
  });
});

describe("formatCount", () => {
  it("uses literal counts under 1k", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(42)).toBe("42");
    expect(formatCount(999)).toBe("999");
  });

  it("uses one-decimal k notation between 1k and 10k", () => {
    expect(formatCount(1_500)).toBe("1.5k");
    expect(formatCount(9_899)).toBe("9.9k");
  });

  it("rounds to integer-k at and above 10k to avoid '10.0k'", () => {
    expect(formatCount(9_950)).toBe("10k");
    expect(formatCount(12_345)).toBe("12k");
  });
});
