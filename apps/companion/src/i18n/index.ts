import {
  DEFAULT_LOCALE,
  LOCALES,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  makeTranslator,
  resolveLocale,
  type SupportedLocale,
  type TranslationValues,
} from "@tarmoto/shared";
import {
  companionCatalogs,
  type EnglishMessageKey,
  type TranslationCatalog,
} from "./locales";

export {
  DEFAULT_LOCALE,
  LOCALES,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  resolveLocale,
};
export type {
  EnglishMessageKey,
  SupportedLocale,
  TranslationCatalog,
  TranslationValues,
};

export const LOCALE_COOKIE = "tarmoto-locale";

const baseTranslate = makeTranslator<EnglishMessageKey>(companionCatalogs);

// Module-global active locale consumed by the synchronous `t()` helper. Set by
// the Next server layer (`server.ts`) per request before children render.
let activeLocale: SupportedLocale = DEFAULT_LOCALE;

export function setActiveLocale(locale: SupportedLocale): void {
  activeLocale = locale;
}

export function getActiveLocale(): SupportedLocale {
  return activeLocale;
}

/**
 * Consumers pass raw English source text as the key (loose `string`), relying on
 * the raw-key fallback for untranslated strings — so this keeps the `string`
 * signature and casts into the catalog key type.
 */
export function translate(
  key: string,
  values?: TranslationValues,
  locale: SupportedLocale = activeLocale,
): string {
  return baseTranslate(key as EnglishMessageKey, values, locale);
}

export const t = translate;
