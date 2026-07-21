import { getFormatters, setActiveFormatContext } from ".";

describe("mobile active formatters", () => {
  afterEach(() => {
    setActiveFormatContext({
      locale: "en-US",
      timeZone: "UTC",
      units: "metric",
    });
  });

  it("applies a regional decimal locale", () => {
    const format = setActiveFormatContext({
      locale: "cs-CZ",
      timeZone: "Europe/Prague",
      units: "metric",
    });

    expect(format.locale).toBe("cs-CZ");
    expect(format.decimal(1234.5, 1)).toContain(",5");
    expect(getFormatters()).toBe(format);
  });

  it("applies the rider's unit system", () => {
    const format = setActiveFormatContext({
      locale: "en-US",
      timeZone: "UTC",
      units: "imperial",
    });

    expect(format.distanceKm(1.609344)).toBe("1 mi");
    expect(format.units).toBe("imperial");
  });
});
