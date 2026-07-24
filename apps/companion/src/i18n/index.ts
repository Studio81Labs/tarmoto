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
  companionCatalogs,
  type EnglishMessageKey,
  type TranslationCatalog,
} from "./locales";
export { LOCALE_COOKIE } from "./constants";

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

const baseTranslate = makeTranslator<EnglishMessageKey>(companionCatalogs);

/**
 * Companion translator: the key must be a registered catalog key
 * (`EnglishMessageKey`) — an unregistered string is a compile error. The raw
 * English source text IS the key. For a genuinely dynamic key (a runtime
 * string with no fixed key set), use `tDynamic` below.
 */
export function translate(
  key: EnglishMessageKey,
  values?: TranslationValues,
  locale: SupportedLocale = DEFAULT_LOCALE,
  numberLocale: string = locale,
): string {
  return baseTranslate(key, values, locale, numberLocale);
}

export const t = translate;

/**
 * Read the locale already resolved onto the document by the root layout.
 * Browser-only services cannot use React hooks, but they must still translate
 * with the current request/device locale instead of silently defaulting to
 * English. Server callers deliberately fall back to the registered default;
 * request-rendered server code uses the request-bound translator instead.
 */
export function getDocumentLocale(): SupportedLocale {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  return resolveLocale(document.documentElement.lang);
}

/**
 * Typed companion translator: the key must be a registered catalog key.
 * PR 3b narrows `translate`/`t` to this; libs that receive a translator
 * declare their parameter as `Translate`.
 */
export type Translate = (
  key: EnglishMessageKey,
  values?: TranslationValues,
  locale?: SupportedLocale,
) => string;

/**
 * Escape hatch for genuinely dynamic keys (a runtime string that cannot be a
 * compile-time literal). Deliberately loose and greppable — reach for a typed
 * label map before reaching for this. Same lookup + raw-key fallback as `t`.
 */
export function tDynamic(
  key: string,
  values?: TranslationValues,
  locale: SupportedLocale = DEFAULT_LOCALE,
  numberLocale: string = locale,
): string {
  return baseTranslate(key as EnglishMessageKey, values, locale, numberLocale);
}
