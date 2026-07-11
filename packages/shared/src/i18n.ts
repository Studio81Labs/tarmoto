/**
 * Framework-agnostic i18n core shared by every Tarmoto surface (companion UI,
 * backend email, later mobile). The language list + lookup/fallback/interpolate
 * logic live here once; each surface owns its own message catalog and builds a
 * translator over it via `makeTranslator`.
 */

export const DEFAULT_LOCALE = "en" as const;

/**
 * Product-wide language registry — metadata only. Message catalogs are
 * per-surface, so this carries just the human-readable label used by
 * locale-switcher UIs. To add a language: add an entry here + a `Partial`
 * catalog for it in each surface that should translate.
 */
export const LOCALES = {
  en: { label: "English" },
} as const;

export type SupportedLocale = keyof typeof LOCALES;

export const SUPPORTED_LOCALES = Object.keys(
  LOCALES,
) as readonly SupportedLocale[];

export function isSupportedLocale(value: string): value is SupportedLocale {
  // Object.hasOwn (not `in`) so prototype keys ("toString"/"__proto__") can't
  // slip through validation and index a catalog with an inherited method.
  return Object.hasOwn(LOCALES, value);
}

/**
 * Best-effort locale picker. Accepts a single tag ("en", "en-GB"), a full
 * Accept-Language string ("et,en-GB;q=0.9,en;q=0.8"), or null/undefined.
 * Tags are lowercased and reduced to their primary subtag, then matched against
 * the registry. RFC 7231 q-weights are honoured (highest q wins; header order
 * breaks ties; no `q` defaults to 1.0). Anything unresolved → DEFAULT_LOCALE.
 */
export function resolveLocale(input?: string | null): SupportedLocale {
  if (!input) return DEFAULT_LOCALE;

  const candidates = input
    .split(",")
    .map((entry, index) => {
      const parts = entry.split(";").map((part) => part.trim());
      const tag = parts[0] ?? "";
      let q = 1;
      for (const param of parts.slice(1)) {
        const match = /^q=([0-9]*\.?[0-9]+)$/i.exec(param);
        if (match) {
          const parsed = Number.parseFloat(match[1] ?? "");
          if (!Number.isNaN(parsed)) q = parsed;
        }
      }
      return { tag, q, index };
    })
    .filter((candidate) => candidate.tag !== "")
    .sort((a, b) => (b.q !== a.q ? b.q - a.q : a.index - b.index));

  for (const candidate of candidates) {
    const primary = candidate.tag.toLowerCase().split("-")[0] ?? "";
    if (isSupportedLocale(primary)) return primary;
  }

  return DEFAULT_LOCALE;
}

export type TranslationValues = Record<string, string | number>;

/** A fully-populated message map for one surface, in the default locale. */
export type Catalog<K extends string> = Record<K, string>;

/**
 * Per-surface catalogs keyed by locale. The default locale is exhaustive;
 * other locales are partial and fall back to it key-by-key.
 */
export type CatalogsByLocale<K extends string> = { en: Catalog<K> } & Partial<
  Record<SupportedLocale, Partial<Catalog<K>>>
>;

export type Translator<K extends string> = (
  key: K,
  values?: TranslationValues,
  locale?: SupportedLocale,
) => string;

/**
 * Build a translator over a surface's catalogs. Lookup order:
 * active-locale catalog → default-locale (en) catalog → the raw key. Then
 * `{placeholder}` values are substituted. Substitution is RAW — callers that
 * emit HTML MUST escape untrusted values before passing them in.
 */
export function makeTranslator<K extends string>(
  catalogs: CatalogsByLocale<K>,
): Translator<K> {
  const read = (locale: SupportedLocale, key: K): string | undefined => {
    const catalog = catalogs[locale] as Partial<Catalog<K>> | undefined;
    return catalog?.[key];
  };

  return (key, values, locale = DEFAULT_LOCALE) => {
    const template =
      read(locale, key) ??
      (locale !== DEFAULT_LOCALE ? read(DEFAULT_LOCALE, key) : undefined) ??
      key;

    if (!values) return template;

    return template.replace(/\{(\w+)\}/g, (match, valueKey: string) => {
      const value = values[valueKey];
      return value === undefined ? match : String(value);
    });
  };
}
