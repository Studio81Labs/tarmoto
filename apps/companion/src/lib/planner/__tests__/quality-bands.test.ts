import { describe, expect, it } from "vitest";
import {
  FAIR_BAND_MIN_SCORE,
  GOOD_BAND_MIN_SCORE,
  isLowConfidence,
  LOW_CONFIDENCE_MAX_PASSES,
  scoreToBand,
} from "../quality-bands";

describe("scoreToBand", () => {
  it("maps null to no_data", () => {
    expect(scoreToBand(null)).toBe("no_data");
  });

  it("maps scores at or above the good floor to good", () => {
    expect(scoreToBand(GOOD_BAND_MIN_SCORE)).toBe("good");
    expect(scoreToBand(5)).toBe("good");
  });

  it("maps scores between the fair and good floors to fair", () => {
    expect(scoreToBand(FAIR_BAND_MIN_SCORE)).toBe("fair");
    expect(scoreToBand(GOOD_BAND_MIN_SCORE - 0.1)).toBe("fair");
  });

  it("maps scores below the fair floor to rough", () => {
    expect(scoreToBand(FAIR_BAND_MIN_SCORE - 0.1)).toBe("rough");
    expect(scoreToBand(1)).toBe("rough");
  });
});

describe("isLowConfidence", () => {
  it("treats the threshold itself as low confidence", () => {
    expect(isLowConfidence(LOW_CONFIDENCE_MAX_PASSES)).toBe(true);
  });

  it("treats one pass above the threshold as trustworthy", () => {
    expect(isLowConfidence(LOW_CONFIDENCE_MAX_PASSES + 1)).toBe(false);
  });

  it("treats zero passes as low confidence", () => {
    expect(isLowConfidence(0)).toBe(true);
  });
});
