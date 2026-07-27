import { createFormatters } from "@tarmoto/shared";
import { splitRideDetailDuration } from "./ride-detail-format";

describe("splitRideDetailDuration", () => {
  it("keeps the second locale-leading measurement in the compact suffix", () => {
    const format = createFormatters({ locale: "sw", units: "metric" });

    expect(splitRideDetailDuration(252, format)).toEqual({
      value: "saa 4",
      unit: "dak 12",
      unitPosition: "after",
    });
  });

  it("keeps single-measurement and missing durations unitless", () => {
    const format = createFormatters({ locale: "en", units: "metric" });

    expect(splitRideDetailDuration(52, format)).toEqual({ value: "52m" });
    expect(splitRideDetailDuration(120, format)).toEqual({ value: "2h" });
    expect(splitRideDetailDuration(null, format)).toEqual({ value: "—" });
  });
});
