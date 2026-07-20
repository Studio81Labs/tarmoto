import type { EnglishMessageKey, TranslationValues } from "@/i18n";
import type { WeatherAlert } from "@/types";
import { localizeWeatherAlert } from "../weatherAlertCopy";

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
  beforeEach(() => translate.mockClear());

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
