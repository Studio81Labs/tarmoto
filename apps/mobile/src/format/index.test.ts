import { getFormatters, setActiveFormatContext } from ".";
import { translate } from "@/i18n";

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

  it("applies the regional locale to ICU count digits", () => {
    setActiveFormatContext({
      locale: "ar-EG",
      timeZone: "UTC",
      units: "metric",
    });

    expect(
      translate("{count, plural, one {# day} other {# days}}", { count: 2 }),
    ).toBe("٢ days");
  });
});
