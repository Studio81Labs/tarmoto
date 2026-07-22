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
export { LOCALE_COOKIE } from "./constants";

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
 * Companion translator: the key must be a registered catalog key
 * (`EnglishMessageKey`) — an unregistered string is a compile error. The raw
 * English source text IS the key. For a genuinely dynamic key (a runtime
 * string with no fixed key set), use `tDynamic` below.
 */
export function translate(
  key: EnglishMessageKey,
  values?: TranslationValues,
  locale: SupportedLocale = activeLocale,
): string {
  return baseTranslate(key, values, locale);
}

export const t = translate;

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
  locale: SupportedLocale = activeLocale,
): string {
  return baseTranslate(key as EnglishMessageKey, values, locale);
}
