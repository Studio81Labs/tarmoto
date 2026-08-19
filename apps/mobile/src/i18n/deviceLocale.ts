import { NativeModules, Platform } from "react-native";

function normalizeLocaleIdentifier(locale: unknown): string | null {
  if (typeof locale !== "string") return null;
  const normalized = locale.trim().replace(/_/g, "-");
  return normalized || null;
}

function readIosLocales(): {
  preferredLanguage: unknown;
  formatLocale: unknown;
} {
  const settings = (
    NativeModules.SettingsManager as
      { settings?: Record<string, unknown> } | undefined
  )?.settings;
  const languages = settings?.AppleLanguages;
  return {
    preferredLanguage: Array.isArray(languages) ? languages[0] : undefined,
    formatLocale: settings?.AppleLocale,
  };
}

/**
 * Returns the device's preferred BCP-47 locale without adding another native
 * dependency. Both shapes are provided by React Native itself. An unavailable
 * or malformed native module is treated as "unknown" and callers apply their
 * normal English fallback.
 */
export function detectDeviceLocale(): string | null {
  try {
    if (Platform.OS === "ios") {
      const { preferredLanguage, formatLocale } = readIosLocales();
      return (
        normalizeLocaleIdentifier(preferredLanguage) ??
        normalizeLocaleIdentifier(formatLocale)
      );
    }

    if (Platform.OS === "android") {
      const locale = (
        NativeModules.I18nManager as { localeIdentifier?: string } | undefined
      )?.localeIdentifier;
      return normalizeLocaleIdentifier(locale);
    }
  } catch {
    // Native locale detection is best-effort; resolveLocale owns fallback.
  }
  return null;
}

/**
 * Returns the device locale used for dates and numbers. On iOS this is the
 * regional AppleLocale setting, which can intentionally differ from the
 * preferred UI language returned by detectDeviceLocale().
 */
export function detectDeviceFormatLocale(): string | null {
  try {
    if (Platform.OS === "ios") {
      const { preferredLanguage, formatLocale } = readIosLocales();
      return (
        normalizeLocaleIdentifier(formatLocale) ??
        normalizeLocaleIdentifier(preferredLanguage)
      );
    }

    if (Platform.OS === "android") {
      const locale = (
        NativeModules.I18nManager as { localeIdentifier?: string } | undefined
      )?.localeIdentifier;
      return normalizeLocaleIdentifier(locale);
    }
  } catch {
    // Native locale detection is best-effort; formatters own fallback.
  }
  return null;
}

export function detectDeviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
