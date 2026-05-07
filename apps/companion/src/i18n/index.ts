export const DEFAULT_LOCALE = "en" as const;

export const SUPPORTED_LOCALES = [DEFAULT_LOCALE] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type TranslationValues = Record<string, string | number>;

import { en } from "./en";

export type TranslationCatalog = Record<string, string>;

export const englishMessages: TranslationCatalog = en;

export function isSupportedLocale(locale: string): locale is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale);
}

export function resolveLocale(locale?: string | null): SupportedLocale {
  if (!locale) {
    return DEFAULT_LOCALE;
  }

  const normalized = locale.toLowerCase().split("-")[0] ?? DEFAULT_LOCALE;
  return isSupportedLocale(normalized) ? normalized : DEFAULT_LOCALE;
}

export function translate(
  key: string,
  values?: TranslationValues,
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  const catalog = locale === DEFAULT_LOCALE ? englishMessages : englishMessages;
  const template = catalog[key] ?? key;

  if (!values) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (match, valueKey: string) => {
    const value = values[valueKey];
    return value === undefined ? match : String(value);
  });
}

export const t = translate;
