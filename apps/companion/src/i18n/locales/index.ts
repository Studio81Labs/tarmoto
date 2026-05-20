import { en, type EnglishMessageKey } from "./en";

// =============================================================================
// Locale registry
//
// To add a new language:
//   1. Create a sibling file in this directory, e.g. `./et.ts`, exporting a
//      `Partial<TranslationCatalog>` named after the locale. You only need to
//      translate the keys you want to override — missing keys fall back to
//      English automatically.
//   2. Import it below and register it in `LOCALES` with a human-readable
//      `label` used in the locale switcher UI.
//
// No other code changes are required; the rest of the app picks up the new
// locale automatically.
// =============================================================================

export type TranslationCatalog = Record<EnglishMessageKey, string>;

export const DEFAULT_LOCALE = "en" as const;

type LocaleEntry = {
  label: string;
  messages: Partial<TranslationCatalog>;
};

export const LOCALES = {
  en: { label: "English", messages: en },
  // Example:
  // et: { label: "Eesti", messages: et },
} as const satisfies Record<string, LocaleEntry>;

export type SupportedLocale = keyof typeof LOCALES;

export { en, type EnglishMessageKey };
