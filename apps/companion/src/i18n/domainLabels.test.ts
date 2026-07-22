import { describe, expect, it } from "vitest";
import { t } from ".";
import {
  PASS_STATUS_LABELS,
  SUGGESTION_STATUS_LABELS,
  translateKnownLabel,
} from "./domainLabels";

describe("cataloged domain labels", () => {
  it("translates known wire values through their typed catalog key", () => {
    expect(translateKnownLabel("closed", PASS_STATUS_LABELS, t)).toBe("Closed");
    expect(translateKnownLabel("accepted", SUGGESTION_STATUS_LABELS, t)).toBe(
      "Accepted",
    );
  });

  it("hides unknown future wire values behind the cataloged fallback", () => {
    expect(translateKnownLabel("future", PASS_STATUS_LABELS, t)).toBe(
      "Unknown",
    );
  });
});
