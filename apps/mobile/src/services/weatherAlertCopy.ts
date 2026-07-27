import { translate, type EnglishMessageKey, type Translate } from "@/i18n";
import type { WeatherAlert, WeatherAlertKind } from "@/types";
import { getFormatters, type Formatters } from "@/format";

export interface WeatherAlertCopy {
  title: string;
  message: string;
}

const TITLE_KEYS = {
  storm: "Storm warning",
  ice: "Icy roads ahead",
  wet: "Wet roads ahead",
  wind: "High wind ahead",
} as const satisfies Record<WeatherAlertKind, EnglishMessageKey>;

const MESSAGE_KEYS = {
  storm: "Severe storm at {location} — consider rerouting or pulling over.",
  ice: "Icy roads near {location}. Reduce speed and avoid sudden inputs.",
  wet: "Wet roads near {location}. Allow extra braking distance.",
  wind: "High wind near {location}. Brace for sudden crosswinds.",
} as const satisfies Record<WeatherAlertKind, EnglishMessageKey>;

const WIND_SPEED_MESSAGE_KEY =
  "High wind ({speed}) near {location}. Brace for sudden crosswinds." satisfies EnglishMessageKey;

const SURFACE_CONDITIONS_MESSAGE_KEYS = {
  ice: "Icy roads near {location}: {temperature} · Wind {wind}. Reduce speed and avoid sudden inputs.",
  wet: "Wet roads near {location}: {temperature} · Wind {wind}. Allow extra braking distance.",
} as const satisfies Record<"ice" | "wet", EnglishMessageKey>;

function isWeatherAlertKind(kind: string): kind is WeatherAlertKind {
  return Object.hasOwn(TITLE_KEYS, kind);
}

/**
 * Reconstruct route-alert copy from structured data instead of displaying the
 * backend's English compatibility fields. Unknown future kinds use safe,
 * cataloged generic copy until the mobile catalog gains a structured label.
 */
export function localizeWeatherAlert(
  alert: WeatherAlert,
  t: Translate = translate,
  format: Formatters = getFormatters(),
): WeatherAlertCopy {
  const kind: string = alert.kind;
  if (!isWeatherAlertKind(kind)) {
    return {
      title: t("Weather warning"),
      message: t("Weather conditions may affect your route. Ride cautiously."),
    };
  }

  const location = `${format.decimal(alert.lat, 2)},${format.decimal(alert.lng, 2)}`;
  const hasSurfaceConditions =
    (kind === "ice" || kind === "wet") &&
    Number.isFinite(alert.temperature_c) &&
    Number.isFinite(alert.wind_kmh);
  return {
    title: t(TITLE_KEYS[kind]),
    message: hasSurfaceConditions
      ? t(SURFACE_CONDITIONS_MESSAGE_KEYS[kind], {
          location,
          temperature: format.temperature(alert.temperature_c ?? 0),
          wind: format.speed(alert.wind_kmh ?? 0),
        })
      : kind === "wind" && Number.isFinite(alert.wind_kmh)
        ? t(WIND_SPEED_MESSAGE_KEY, {
            location,
            speed: format.speed(alert.wind_kmh ?? 0),
          })
        : t(MESSAGE_KEYS[kind], { location }),
  };
}
