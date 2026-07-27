import { createFormatters } from "@tarmoto/shared";
import { splitDuration } from "./public-share";

describe("splitDuration", () => {
  it("keeps the second English measurement in the compact suffix", () => {
    const format = createFormatters({ locale: "en", units: "metric" });

    expect(splitDuration(252, format)).toEqual({
      value: "4h",
      unit: "12m",
      unitPosition: "after",
    });
  });

  it("does not split inside locale-leading measurements", () => {
    const format = createFormatters({ locale: "sw", units: "metric" });

    expect(splitDuration(252, format)).toEqual({
      value: "saa 4",
      unit: "dak 12",
      unitPosition: "after",
    });
  });

  it("keeps single-measurement and missing durations unitless", () => {
    const format = createFormatters({ locale: "en", units: "metric" });

    expect(splitDuration(52, format)).toEqual({ value: "52m" });
    expect(splitDuration(120, format)).toEqual({ value: "2h" });
    expect(splitDuration(null, format)).toEqual({ value: "—" });
  });
});
