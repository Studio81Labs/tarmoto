import type { EnglishMessageKey, TranslationValues } from "@/i18n";
import type { WeatherAlert } from "@/types";
import { localizeWeatherAlert } from "../weatherAlertCopy";
import { setActiveFormatContext } from "@/format";

const translate = jest.fn(
  (key: EnglishMessageKey, values?: TranslationValues) =>
    values?.location === undefined
      ? `translated:${key}`
      : `${key}|${values.location}`,
);

function buildAlert(overrides: Partial<WeatherAlert>): WeatherAlert {
  return {
    id: "storm-0",
    kind: "storm",
    severity: "critical",
    lat: 49.123,
    lng: 16.754,
    distance_km_from_start: 10,
    title: "Backend title",
    message: "Backend message",
    ...overrides,
  };
}

describe("localizeWeatherAlert", () => {
  beforeEach(() => {
    translate.mockClear();
    setActiveFormatContext({ locale: "en", timeZone: "UTC", units: "metric" });
  });

  it.each([
    [
      "storm",
      "Storm warning",
      "Severe storm at {location} — consider rerouting or pulling over.",
    ],
    [
      "ice",
      "Icy roads ahead",
      "Icy roads near {location}. Reduce speed and avoid sudden inputs.",
    ],
    [
      "wet",
      "Wet roads ahead",
      "Wet roads near {location}. Allow extra braking distance.",
    ],
    [
      "wind",
      "High wind ahead",
      "High wind near {location}. Brace for sudden crosswinds.",
    ],
  ] as const)(
    "uses catalog copy for %s alerts",
    (kind, titleKey, messageKey) => {
      expect(localizeWeatherAlert(buildAlert({ kind }), translate)).toEqual({
        title: `translated:${titleKey}`,
        message: `${messageKey}|49.12,16.75`,
      });
    },
  );

  it("preserves structured wind speed in localized copy", () => {
    expect(
      localizeWeatherAlert(
        buildAlert({ kind: "wind", wind_kmh: 75 }),
        translate,
      ),
    ).toEqual({
      title: "translated:High wind ahead",
      message:
        "High wind ({speed}) near {location}. Brace for sudden crosswinds.|49.12,16.75",
    });
    expect(translate).toHaveBeenCalledWith(
      "High wind ({speed}) near {location}. Brace for sudden crosswinds.",
      { location: "49.12,16.75", speed: "75 km/h" },
    );
  });

  it.each([
    [
      "ice",
      "Icy roads near {location}: {temperature} · Wind {wind}. Reduce speed and avoid sudden inputs.",
    ],
    [
      "wet",
      "Wet roads near {location}: {temperature} · Wind {wind}. Allow extra braking distance.",
    ],
  ] as const)("preserves sampled conditions for %s alerts", (kind, key) => {
    localizeWeatherAlert(
      buildAlert({ kind, temperature_c: -2, wind_kmh: 28 }),
      translate,
    );

    expect(translate).toHaveBeenCalledWith(key, {
      location: "49.12,16.75",
      temperature: "-2°C",
      wind: "28 km/h",
    });
  });

  it("converts structured conditions for imperial riders", () => {
    setActiveFormatContext({
      locale: "en-US",
      timeZone: "UTC",
      units: "imperial",
    });

    localizeWeatherAlert(
      buildAlert({ kind: "ice", temperature_c: -2, wind_kmh: 28 }),
      translate,
    );

    expect(translate).toHaveBeenCalledWith(
      "Icy roads near {location}: {temperature} · Wind {wind}. Reduce speed and avoid sudden inputs.",
      {
        location: "49.12,16.75",
        temperature: "28.4°F",
        wind: "17.4 mph",
      },
    );
  });

  it("keeps server copy for an unknown future alert kind", () => {
    const alert = buildAlert({
      kind: "hail" as WeatherAlert["kind"],
      title: "Hail ahead",
      message: "Large hail near the route",
    });

    expect(localizeWeatherAlert(alert, translate)).toEqual({
      title: "Hail ahead",
      message: "Large hail near the route",
    });
    expect(translate).not.toHaveBeenCalled();
  });
});
