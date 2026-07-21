import { NativeModules, Platform } from "react-native";

/**
 * Returns the device's preferred BCP-47 locale without adding another native
 * dependency. Both shapes are provided by React Native itself. An unavailable
 * or malformed native module is treated as "unknown" and callers apply their
 * normal English fallback.
 */
export function detectDeviceLocale(): string | null {
  try {
    if (Platform.OS === "ios") {
      const settings = (
        NativeModules.SettingsManager as
          | { settings?: Record<string, unknown> }
          | undefined
      )?.settings;
      const locale =
        (settings?.AppleLocale as string | undefined) ??
        (settings?.AppleLanguages as string[] | undefined)?.[0];
      return typeof locale === "string" && locale.trim() ? locale : null;
    }

    if (Platform.OS === "android") {
      const locale = (
        NativeModules.I18nManager as { localeIdentifier?: string } | undefined
      )?.localeIdentifier;
      return typeof locale === "string" && locale.trim()
        ? locale.replace(/_/g, "-")
        : null;
    }
  } catch {
    // Native locale detection is best-effort; resolveLocale owns fallback.
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
