import { translate, type EnglishMessageKey, type Translate } from "@/i18n";
import type { WeatherAlert, WeatherAlertKind } from "@/types";

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

function isWeatherAlertKind(kind: string): kind is WeatherAlertKind {
  return Object.hasOwn(TITLE_KEYS, kind);
}

/**
 * Reconstruct route-alert copy from structured data instead of displaying the
 * backend's English compatibility fields. Unknown future kinds deliberately
 * retain those fields until the mobile catalog gains matching copy.
 */
export function localizeWeatherAlert(
  alert: WeatherAlert,
  t: Translate = translate,
): WeatherAlertCopy {
  const kind: string = alert.kind;
  if (!isWeatherAlertKind(kind)) {
    return { title: alert.title, message: alert.message };
  }

  const location = `${alert.lat.toFixed(2)},${alert.lng.toFixed(2)}`;
  return {
    title: t(TITLE_KEYS[kind]),
    message: t(MESSAGE_KEYS[kind], { location }),
  };
}
