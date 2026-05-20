import {
  DEFAULT_LOCALE,
  LOCALES,
  type EnglishMessageKey,
  type SupportedLocale,
  type TranslationCatalog,
} from "./locales";

export { DEFAULT_LOCALE, LOCALES };
export type { EnglishMessageKey, SupportedLocale, TranslationCatalog };

export const SUPPORTED_LOCALES = Object.keys(
  LOCALES,
) as readonly SupportedLocale[];

export const LOCALE_COOKIE = "tarmoto-locale";

export type TranslationValues = Record<string, string | number>;

let activeLocale: SupportedLocale = DEFAULT_LOCALE;

export function isSupportedLocale(value: string): value is SupportedLocale {
  return value in LOCALES;
}

/**
 * Best-effort locale picker. Accepts:
 *   - a single locale tag ("en", "et", "en-GB"),
 *   - an Accept-Language string ("et,en-GB;q=0.9,en;q=0.8"),
 *   - or `null` / `undefined` (returns DEFAULT_LOCALE).
 *
 * Tags are lowercased and stripped to their primary subtag, then matched
 * against the registry. The first supported tag wins; if nothing matches we
 * fall back to DEFAULT_LOCALE.
 */
export function resolveLocale(input?: string | null): SupportedLocale {
  if (!input) return DEFAULT_LOCALE;

  const candidates = input
    .split(",")
    .map((entry) => entry.split(";")[0]?.trim() ?? "")
    .filter(Boolean);

  for (const candidate of candidates) {
    const primary = candidate.toLowerCase().split("-")[0] ?? "";
    if (isSupportedLocale(primary)) return primary;
  }

  return DEFAULT_LOCALE;
}

export function setActiveLocale(locale: SupportedLocale): void {
  activeLocale = locale;
}

export function getActiveLocale(): SupportedLocale {
  return activeLocale;
}

function readMessage(locale: SupportedLocale, key: string): string | undefined {
  // Catalogs are `Partial<TranslationCatalog>` so non-English locales don't
  // have to be exhaustive; an `as` cast is needed to index by an arbitrary
  // string at runtime.
  const catalog = LOCALES[locale].messages as Partial<TranslationCatalog>;
  return catalog[key as EnglishMessageKey];
}

function lookup(key: string, locale: SupportedLocale): string {
  // 1. Active locale catalog
  const localized = readMessage(locale, key);
  if (localized !== undefined) return localized;

  // 2. English fallback (translators don't have to be exhaustive)
  if (locale !== DEFAULT_LOCALE) {
    const fallback = readMessage(DEFAULT_LOCALE, key);
    if (fallback !== undefined) return fallback;
  }

  // 3. Key itself — keeps the UI readable if a string was added before its
  //    catalog entry. Matches the existing convention where keys are the
  //    English source text.
  return key;
}

export function translate(
  key: string,
  values?: TranslationValues,
  locale: SupportedLocale = activeLocale,
): string {
  const template = lookup(key, locale);

  if (!values) return template;

  return template.replace(/\{(\w+)\}/g, (match, valueKey: string) => {
    const value = values[valueKey];
    return value === undefined ? match : String(value);
  });
}

export const t = translate;
