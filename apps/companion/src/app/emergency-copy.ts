/**
 * Tiny, dependency-free catalog for the root error boundary. Do not import the
 * main i18n barrel here: this module must remain usable when that bootstrap is
 * the reason the root layout crashed.
 */
export interface EmergencyCopy {
  label: string;
  title: string;
  body: string;
  reload: string;
  home: string;
}

export const emergencyCatalogs = {
  en: {
    label: "Server error",
    title: "Something skidded out",
    body: "A problem on our end interrupted the request. We’ve logged it — give it another go in a moment.",
    reload: "Reload page",
    home: "Back to home",
  },
} as const satisfies Record<string, EmergencyCopy>;

export type EmergencyLocale = keyof typeof emergencyCatalogs;

const DEFAULT_EMERGENCY_LOCALE: EmergencyLocale = "en";
const LOCALE_COOKIE = "tarmoto-locale";

export function resolveEmergencyLocale(
  candidates: readonly (string | null | undefined)[],
): EmergencyLocale {
  const supported = Object.keys(emergencyCatalogs) as EmergencyLocale[];
  for (const candidate of candidates) {
    // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search -- BCP-47 locale tags are ASCII protocol identifiers, not rider-facing search text.
    const normalized = candidate?.trim().replaceAll("_", "-").toLowerCase();
    if (!normalized) continue;
    const exact = supported.find(
      // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search -- BCP-47 registry keys use protocol-defined ASCII case folding.
      (locale) => locale.toLowerCase() === normalized,
    );
    if (exact) return exact;
    const primary = normalized.split("-")[0];
    const languageOnly = supported.find(
      // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search -- BCP-47 registry keys use protocol-defined ASCII case folding.
      (locale) => !locale.includes("-") && locale.toLowerCase() === primary,
    );
    if (languageOnly) return languageOnly;
  }
  return DEFAULT_EMERGENCY_LOCALE;
}

export function readEmergencyLocaleFromBrowser(): EmergencyLocale {
  if (typeof document === "undefined" || typeof navigator === "undefined") {
    return DEFAULT_EMERGENCY_LOCALE;
  }
  const cookieLocale = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${LOCALE_COOKIE}=`))
    ?.slice(LOCALE_COOKIE.length + 1);
  return resolveEmergencyLocale([
    cookieLocale,
    ...(navigator.languages ?? []),
    navigator.language,
  ]);
}

export function getEmergencyCopy(locale: EmergencyLocale): EmergencyCopy {
  return emergencyCatalogs[locale];
}
