import { describe, expect, it } from "vitest";
import { formatCount } from "./rider-format";

describe("formatCount", () => {
  it("localizes grouping when a locale is passed", () => {
    expect(formatCount(1234000, "de-DE")).toBe("1.234k");
  });
  it("keeps runtime-default behavior when locale is omitted (mobile contract)", () => {
    // Derived from the runtime's own ICU default via `toLocaleString()`
    // rather than a hardcoded "1,234k" — the assertion holds regardless of
    // which locale the test runner's ICU data treats as the ambient default.
    expect(formatCount(1234000)).toBe(`${(1234).toLocaleString()}k`);
  });
  it("keeps the compact k form", () => {
    expect(formatCount(12600, "en-US")).toBe("13k");
  });
  it("localizes the compact decimal when a locale is supplied", () => {
    expect(formatCount(1500, "de-DE")).toBe("1,5k");
    expect(formatCount(1500, "en-US")).toBe("1.5k");
  });
  it("keeps the legacy period form for the compact decimal when locale is omitted (mobile contract)", () => {
    expect(formatCount(1500)).toBe("1.5k");
  });
});
