import {
  DEFAULT_LOCALE,
  LOCALES,
  SUPPORTED_LOCALES,
  getUserFacingErrorMessage,
  isSupportedLocale,
  matchSupportedLocale,
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
  matchSupportedLocale,
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
let activeNumberLocale: string = DEFAULT_LOCALE;

export function setActiveLocale(locale: SupportedLocale): void {
  activeLocale = locale;
}

export function getActiveLocale(): SupportedLocale {
  return activeLocale;
}

/** Keep ICU-rendered digits aligned with the rider's regional preference. */
export function setActiveNumberLocale(locale: string): void {
  activeNumberLocale = locale;
}

/** Translate registered mobile UI copy using the active app locale. */
export function translate(
  key: EnglishMessageKey,
  values?: TranslationValues,
  locale: SupportedLocale = activeLocale,
): string {
  return baseTranslate(key, values, locale, activeNumberLocale);
}

export const t = translate;

/** Mobile translator shape for pure helpers that render rider-facing copy. */
export type Translate = (
  key: EnglishMessageKey,
  values?: TranslationValues,
) => string;

/**
 * Translate a constrained wire value without exposing an unknown future token
 * as rider-facing copy.
 */
export function translateKnownLabel(
  value: string,
  labels: Readonly<Record<string, EnglishMessageKey>>,
  translator: Translate = translate,
): string {
  return translator(labels[value] ?? "Unknown");
}

/** Deliberate escape hatch for genuinely runtime-defined message keys. */
export function tDynamic(
  key: string,
  values?: TranslationValues,
  locale: SupportedLocale = activeLocale,
): string {
  return baseTranslate(
    key as EnglishMessageKey,
    values,
    locale,
    activeNumberLocale,
  );
}
