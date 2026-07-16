import { describe, expect, it } from "vitest";
import {
  canonicalizeFormatLocale,
  isValidFormatLocale,
  isValidTimeZone,
  resolveFormatLocaleFromAcceptLanguage,
} from "./format";

describe("canonicalizeFormatLocale", () => {
  it("canonicalizes case per BCP-47", () => {
    expect(canonicalizeFormatLocale("CS-cz")).toBe("cs-CZ");
    expect(canonicalizeFormatLocale("en-gb")).toBe("en-GB");
    expect(canonicalizeFormatLocale("de")).toBe("de");
  });

  it("rejects malformed, empty, oversized, and non-string input", () => {
    expect(canonicalizeFormatLocale("not a locale!")).toBeNull();
    expect(canonicalizeFormatLocale("en_US")).toBeNull(); // underscore is not BCP-47
    expect(canonicalizeFormatLocale("")).toBeNull();
    expect(canonicalizeFormatLocale("x".repeat(36))).toBeNull();
    expect(canonicalizeFormatLocale(null)).toBeNull();
    expect(canonicalizeFormatLocale(42)).toBeNull();
  });
});

describe("isValidFormatLocale", () => {
  it("accepts well-formed tags and rejects garbage", () => {
    expect(isValidFormatLocale("cs-CZ")).toBe(true);
    expect(isValidFormatLocale("klingon locale")).toBe(false);
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA zones", () => {
    expect(isValidTimeZone("Europe/Prague")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects unknown zones, empty, oversized, and non-string input", () => {
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("x".repeat(65))).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
  });
});

describe("resolveFormatLocaleFromAcceptLanguage", () => {
  it("keeps the region of the highest-q tag", () => {
    expect(
      resolveFormatLocaleFromAcceptLanguage("cs-CZ,cs;q=0.9,en;q=0.8"),
    ).toBe("cs-CZ");
  });

  it("honours q-weights over listing order", () => {
    expect(resolveFormatLocaleFromAcceptLanguage("en;q=0.5,de-AT;q=0.9")).toBe(
      "de-AT",
    );
  });

  it("skips wildcards and malformed tags, falling through to the next candidate", () => {
    expect(resolveFormatLocaleFromAcceptLanguage("*,fr-FR;q=0.7")).toBe(
      "fr-FR",
    );
    expect(resolveFormatLocaleFromAcceptLanguage("!!bad!!,en-GB;q=0.1")).toBe(
      "en-GB",
    );
  });

  it("returns null for empty/absent/unusable headers", () => {
    expect(resolveFormatLocaleFromAcceptLanguage(null)).toBeNull();
    expect(resolveFormatLocaleFromAcceptLanguage(undefined)).toBeNull();
    expect(resolveFormatLocaleFromAcceptLanguage("*")).toBeNull();
  });
});
