/**
 * Device-family encoding (issue #494) — `@tarmoto/shared`.
 *
 * The encoder is the canonical mapping between a free-form device
 * model string and the five-bucket family the model retraining
 * pipeline groups by. Three things have to stay correct as the
 * vocabulary evolves:
 *
 *   1. Pro vs standard iPhone tiers split on the "pro" token (the IMU
 *      package differs measurably).
 *   2. Samsung Galaxy S phones match either the marketing name or the
 *      `SM-S###`/`SM-G###` model code Android exposes.
 *   3. Unknown / null / empty inputs land in `other` rather than
 *      throwing — the analytics pipeline must never drop a row over
 *      a missing identifier.
 */

import {
  DEVICE_FAMILIES,
  encodeDeviceFamily,
  oneHotDeviceFamily,
} from "@tarmoto/shared";

describe("encodeDeviceFamily", () => {
  it("classifies iPhone Pro tiers into iphone_pro", () => {
    expect(encodeDeviceFamily("iPhone 15 Pro")).toBe("iphone_pro");
    expect(encodeDeviceFamily("iPhone 14 Pro Max")).toBe("iphone_pro");
    expect(encodeDeviceFamily("iPhone 17 Pro")).toBe("iphone_pro");
    // Case-insensitive — `getModel()` capitalisation isn't guaranteed
    // across iOS versions.
    expect(encodeDeviceFamily("IPHONE 15 PRO")).toBe("iphone_pro");
  });

  it("classifies non-Pro iPhones into iphone_standard", () => {
    expect(encodeDeviceFamily("iPhone 13")).toBe("iphone_standard");
    expect(encodeDeviceFamily("iPhone 15 Plus")).toBe("iphone_standard");
    expect(encodeDeviceFamily("iPhone SE (3rd generation)")).toBe(
      "iphone_standard",
    );
  });

  it("classifies Pixel devices into pixel", () => {
    expect(encodeDeviceFamily("Pixel 8")).toBe("pixel");
    expect(encodeDeviceFamily("Pixel 9 Pro")).toBe("pixel");
    expect(encodeDeviceFamily("Pixel Fold")).toBe("pixel");
  });

  it("matches Samsung Galaxy S by marketing name", () => {
    expect(encodeDeviceFamily("Galaxy S24 Ultra")).toBe("samsung_galaxy_s");
    expect(encodeDeviceFamily("Samsung Galaxy S23")).toBe("samsung_galaxy_s");
  });

  it("matches Samsung Galaxy S by Android Build.MODEL code", () => {
    // `SM-S921U` (S24), `SM-G991B` (S21) are values Android exposes
    // verbatim through `Build.MODEL` — the encoder must catch them
    // without a case-by-case enumeration.
    expect(encodeDeviceFamily("SM-S921U")).toBe("samsung_galaxy_s");
    expect(encodeDeviceFamily("SM-G991B")).toBe("samsung_galaxy_s");
    expect(encodeDeviceFamily("sm-s928u")).toBe("samsung_galaxy_s");
  });

  it("falls back to other for unknown / missing inputs", () => {
    expect(encodeDeviceFamily(null)).toBe("other");
    expect(encodeDeviceFamily(undefined)).toBe("other");
    expect(encodeDeviceFamily("")).toBe("other");
    expect(encodeDeviceFamily("OnePlus 11")).toBe("other");
    expect(encodeDeviceFamily("Xiaomi 13T")).toBe("other");
  });
});

describe("oneHotDeviceFamily", () => {
  it("returns a fixed-length vector matching DEVICE_FAMILIES order", () => {
    expect(oneHotDeviceFamily("iphone_pro")).toEqual([1, 0, 0, 0, 0]);
    expect(oneHotDeviceFamily("iphone_standard")).toEqual([0, 1, 0, 0, 0]);
    expect(oneHotDeviceFamily("pixel")).toEqual([0, 0, 1, 0, 0]);
    expect(oneHotDeviceFamily("samsung_galaxy_s")).toEqual([0, 0, 0, 1, 0]);
    expect(oneHotDeviceFamily("other")).toEqual([0, 0, 0, 0, 1]);
  });

  it("vector width matches DEVICE_FAMILIES.length so a new bucket is a code-only change", () => {
    for (const family of DEVICE_FAMILIES) {
      expect(oneHotDeviceFamily(family)).toHaveLength(DEVICE_FAMILIES.length);
    }
  });
});
