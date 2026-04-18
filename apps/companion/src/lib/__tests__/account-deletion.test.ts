import { isDeletionConfirmed } from "../account-deletion";

describe("isDeletionConfirmed", () => {
  it("returns false when no email is provided", () => {
    expect(isDeletionConfirmed("rider@example.com", null)).toBe(false);
    expect(isDeletionConfirmed("rider@example.com", undefined)).toBe(false);
    expect(isDeletionConfirmed("rider@example.com", "")).toBe(false);
  });

  it("returns true when typed matches email exactly", () => {
    expect(isDeletionConfirmed("rider@example.com", "rider@example.com")).toBe(
      true,
    );
  });

  it("is case-insensitive", () => {
    expect(isDeletionConfirmed("Rider@Example.COM", "rider@example.com")).toBe(
      true,
    );
  });

  it("ignores surrounding whitespace on the typed value", () => {
    expect(
      isDeletionConfirmed("  rider@example.com  ", "rider@example.com"),
    ).toBe(true);
  });

  it("returns false on any mismatch", () => {
    expect(isDeletionConfirmed("", "rider@example.com")).toBe(false);
    expect(
      isDeletionConfirmed("rider@example.co", "rider@example.com"),
    ).toBe(false);
    expect(
      isDeletionConfirmed("other@example.com", "rider@example.com"),
    ).toBe(false);
  });
});
