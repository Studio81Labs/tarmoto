import {
  DEFAULT_LOCALE,
  LOCALES,
  SUPPORTED_LOCALES,
  getUserFacingErrorMessage,
  isSupportedLocale,
  makeTranslator,
  resolveLocale,
  type SupportedLocale,
  type TranslationValues,
} from "@tarmoto/shared";
import {
  mobileCatalogs,
  type EnglishMessageKey,
  type TranslationCatalog,
} from "./locales";

export {
  DEFAULT_LOCALE,
  LOCALES,
  SUPPORTED_LOCALES,
  getUserFacingErrorMessage,
  isSupportedLocale,
  resolveLocale,
};
export type {
  EnglishMessageKey,
  SupportedLocale,
  TranslationCatalog,
  TranslationValues,
};

const baseTranslate = makeTranslator<EnglishMessageKey>(mobileCatalogs);
let activeLocale: SupportedLocale = DEFAULT_LOCALE;

export function setActiveLocale(locale: SupportedLocale): void {
  activeLocale = locale;
}

export function getActiveLocale(): SupportedLocale {
  return activeLocale;
}

/** Translate registered mobile UI copy using the active app locale. */
export function translate(
  key: EnglishMessageKey,
  values?: TranslationValues,
  locale: SupportedLocale = activeLocale,
): string {
  return baseTranslate(key, values, locale);
}

export const t = translate;

/** Mobile translator shape for pure helpers that render rider-facing copy. */
export type Translate = (
  key: EnglishMessageKey,
  values?: TranslationValues,
) => string;

/** Deliberate escape hatch for genuinely runtime-defined message keys. */
export function tDynamic(
  key: string,
  values?: TranslationValues,
  locale: SupportedLocale = activeLocale,
): string {
  return baseTranslate(key as EnglishMessageKey, values, locale);
}
