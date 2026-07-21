import { describe, expect, it } from "vitest";
import { rideBreakdownLabel } from "./rides-breakdown";

describe("rideBreakdownLabel", () => {
  it("maps stable backend bucket keys to catalog keys", () => {
    expect(rideBreakdownLabel("asphalt")).toBe("Asphalt");
    expect(rideBreakdownLabel("hairpin")).toBe("Hairpin");
  });

  it("uses a cataloged fallback for a newer unknown backend key", () => {
    expect(rideBreakdownLabel("future-band")).toBe("Unknown");
  });
});
