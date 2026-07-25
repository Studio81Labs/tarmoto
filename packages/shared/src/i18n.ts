/**
 * Framework-agnostic i18n core shared by every Tarmoto surface (companion UI,
 * backend email, later mobile). The language list + lookup/fallback/interpolate
 * logic live here once; each surface owns its own message catalog and builds a
 * translator over it via `makeTranslator`.
 */

import {
  IntlMessageFormat,
  type Formatters as MessageFormatters,
} from "intl-messageformat";

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
 * Match one BCP-47 tag against the registry without applying a default.
 * Registry keys are compared case-insensitively while preserving their
 * canonical spelling (for example `pt-BR`). If an exact regional match is not
 * registered, a language-only tag such as `pt` may still match a `pt` entry.
 */
export function matchSupportedLocale(
  value: string,
): SupportedLocale | undefined {
  const normalized = value.trim().replaceAll("_", "-").toLowerCase();
  if (!normalized) return undefined;

  const exact = SUPPORTED_LOCALES.find(
    (locale) => locale.toLowerCase() === normalized,
  );
  if (exact) return exact;

  const primary = normalized.split("-")[0] ?? "";
  return SUPPORTED_LOCALES.find(
    (locale) => !locale.includes("-") && locale.toLowerCase() === primary,
  );
}

/**
 * Best-effort locale picker. Accepts a single tag ("en", "en-GB"), a full
 * Accept-Language string ("et,en-GB;q=0.9,en;q=0.8"), or null/undefined.
 * Tags first match a registered regional tag exactly, then a registered
 * language-only primary subtag. RFC 9110 q-weights are honoured (highest q wins; header order
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
        if (!/^q=/i.test(param)) continue;
        // RFC 9110 qvalues are 0..1 with at most three fractional digits;
        // only zeroes may follow `1`. A malformed q parameter makes this
        // candidate unacceptable instead of silently restoring q=1.
        const match = /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i.exec(param);
        q = match ? Number.parseFloat(match[1] ?? "0") : 0;
      }
      return { tag, q, index };
    })
    // q=0 explicitly means "not acceptable" and must never win merely
    // because it is the only supported tag in the header.
    .filter((candidate) => candidate.tag !== "" && candidate.q > 0)
    .sort((a, b) => (b.q !== a.q ? b.q - a.q : a.index - b.index));

  for (const candidate of candidates) {
    const locale = matchSupportedLocale(candidate.tag);
    if (locale) return locale;
  }

  return DEFAULT_LOCALE;
}

/**
 * Normalize rider-entered text and localized labels for case-insensitive
 * search. The explicit locale avoids Turkish/Azeri I/İ/ı mismatches; the
 * lower-upper-lower fold also makes title-case, all-caps input, and expanding
 * uppercase mappings such as German ß/ẞ converge to one stable form.
 */
export function normalizeForLocaleSearch(
  value: string,
  locale: string,
): string {
  const normalized = value.normalize("NFC").trim();
  try {
    return normalized
      .toLocaleLowerCase(locale)
      .toLocaleUpperCase(locale)
      .toLocaleLowerCase(locale)
      .normalize("NFC");
  } catch {
    // Locale strings ultimately come from validated providers, but pure
    // helpers may be called with untrusted values in tests or import paths.
    return normalized
      .toLowerCase()
      .toUpperCase()
      .toLowerCase()
      .normalize("NFC");
  }
}

export function localeSearchIncludes(
  value: string,
  query: string,
  locale: string,
): boolean {
  return normalizeForLocaleSearch(value, locale).includes(
    normalizeForLocaleSearch(query, locale),
  );
}

export type TranslationValues = Record<string, string | number>;

/**
 * Marker carried by errors whose message has already passed through a
 * surface's locale catalog. Keeping this explicit prevents arbitrary browser,
 * native, or library Error.message strings from leaking into rider-facing UI.
 */
export interface LocalizedUserFacingError extends Error {
  readonly localizedUserMessage: true;
}

/** Return a cataloged error message, otherwise the caller's translated copy. */
export function getUserFacingErrorMessage(
  error: unknown,
  translatedFallback: string,
): string {
  return error instanceof Error &&
    "localizedUserMessage" in error &&
    error.localizedUserMessage === true
    ? error.message
    : translatedFallback;
}

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
  numberLocale?: string,
) => string;

/**
 * Loose translator shape for threading through pure helper functions that
 * cannot depend on a concrete catalog's key union (e.g. shared rider-format
 * helpers, companion lib formatters). Locale binding is the caller's concern.
 */
export type LooseTranslate = (
  key: string,
  values?: TranslationValues,
) => string;

type MessageAst = ReturnType<IntlMessageFormat["getAst"]>;

const ICU_ARGUMENT_TYPES: Readonly<Record<number, string>> = {
  1: "argument",
  2: "number",
  3: "date",
  4: "time",
};

function collectIcuArgumentSchema(
  elements: MessageAst,
  schema = new Map<string, Set<string>>(),
): Map<string, Set<string>> {
  for (const element of elements) {
    const node = element as unknown as {
      type: number;
      value?: string;
      options?: Record<string, { value: MessageAst }>;
      pluralType?: "cardinal" | "ordinal";
      children?: MessageAst;
    };
    const selectOptions = Object.keys(node.options ?? {}).sort();
    const argumentType =
      node.type === 5
        ? `select[${selectOptions.join("|")}]`
        : node.type === 6
          ? `plural:${node.pluralType ?? "cardinal"}[${selectOptions
              .filter((option) => option.startsWith("="))
              .join("|")}]`
          : ICU_ARGUMENT_TYPES[node.type];
    if (argumentType && node.value) {
      const types = schema.get(node.value) ?? new Set<string>();
      types.add(argumentType);
      schema.set(node.value, types);
    }
    for (const option of Object.values(node.options ?? {})) {
      collectIcuArgumentSchema(option.value, schema);
    }
    if (node.children) collectIcuArgumentSchema(node.children, schema);
  }
  return schema;
}

function serialiseIcuArgumentSchema(
  schema: Map<string, Set<string>>,
): string[] {
  return [...schema]
    .map(([name, types]) => `${name}:${[...types].sort().join("|")}`)
    .sort();
}

function collectIcuBranchIssues(
  elements: MessageAst,
  locale: string,
  path = "message",
): string[] {
  const issues: string[] = [];
  for (const element of elements) {
    const node = element as unknown as {
      type: number;
      value?: string;
      options?: Record<string, { value: MessageAst }>;
      pluralType?: "cardinal" | "ordinal";
      children?: MessageAst;
    };
    if (node.options) {
      const argumentPath = `${path}.${node.value ?? "argument"}`;
      const optionNames = Object.keys(node.options);
      if (!optionNames.includes("other")) {
        issues.push(`${argumentPath} is missing the required "other" branch`);
      }
      if (node.type === 6) {
        const pluralType = node.pluralType ?? "cardinal";
        const required = new Intl.PluralRules(locale, {
          type: pluralType,
        }).resolvedOptions().pluralCategories;
        const missing = required.filter(
          (category) => !optionNames.includes(category),
        );
        if (missing.length > 0) {
          issues.push(
            `${argumentPath} is missing ${locale} ${pluralType} plural branches: ${missing.join(", ")}`,
          );
        }
      }
      for (const [option, branch] of Object.entries(node.options)) {
        issues.push(
          ...collectIcuBranchIssues(
            branch.value,
            locale,
            `${argumentPath}.${option}`,
          ),
        );
      }
    }
    if (node.children) {
      issues.push(...collectIcuBranchIssues(node.children, locale, path));
    }
  }
  return issues;
}

/**
 * Validate one translated ICU message against its English source contract.
 *
 * Parsing alone does not catch a translator renaming an argument, changing a
 * number into a plain string, or omitting plural categories required by the
 * target language. Catalog tests in every UI call this helper so adding the
 * next language fails close to the catalog edit instead of at runtime.
 */
export function validateIcuTranslation(
  source: string,
  translated: string,
  locale: string,
): string[] {
  let sourceAst: MessageAst;
  let translatedAst: MessageAst;
  try {
    sourceAst = new IntlMessageFormat(source, DEFAULT_LOCALE, undefined, {
      ignoreTag: true,
    }).getAst();
  } catch (error) {
    return [
      `English source is invalid ICU: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  try {
    translatedAst = new IntlMessageFormat(translated, locale, undefined, {
      ignoreTag: true,
    }).getAst();
  } catch (error) {
    return [
      `Translation is invalid ICU: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }

  const sourceSchema = serialiseIcuArgumentSchema(
    collectIcuArgumentSchema(sourceAst),
  );
  const translatedSchema = serialiseIcuArgumentSchema(
    collectIcuArgumentSchema(translatedAst),
  );
  const issues =
    JSON.stringify(sourceSchema) === JSON.stringify(translatedSchema)
      ? []
      : [
          `ICU argument schema differs (expected ${sourceSchema.join(", ") || "none"}; received ${translatedSchema.join(", ") || "none"})`,
        ];
  issues.push(...collectIcuBranchIssues(translatedAst, locale));
  return issues;
}

// Parsed-message cache shared by every translator. Keyed by source locale +
// template so the same English fallback text can coexist with a translated
// variant under different plural rules. `null` negative-caches templates
// that fail to parse, so a malformed raw key doesn't re-throw per render.
// Capped and cleared wholesale like the Formatters caches in format.ts.
const MESSAGE_CACHE_MAX = 256;
const messageFormats = new Map<string, IntlMessageFormat | null>();
const messageNumberFormats = new Map<string, Intl.NumberFormat>();
const messageDateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const messagePluralRules = new Map<string, Intl.PluralRules>();

function boundedFormatter<T>(
  cache: Map<string, T>,
  key: string,
  create: () => T,
): T {
  let formatter = cache.get(key);
  if (!formatter) {
    if (cache.size >= MESSAGE_CACHE_MAX) cache.clear();
    formatter = create();
    cache.set(key, formatter);
  }
  return formatter;
}

function messageFormatters(numberLocale: string): MessageFormatters {
  return {
    // Number glyphs/grouping are a display preference independent from the
    // UI language. IntlMessageFormat still receives the UI locale below for
    // plural-rule selection; only number rendering is redirected here.
    getNumberFormat: (_locales, options) => {
      const key = `${numberLocale}|${JSON.stringify(options ?? {})}`;
      return boundedFormatter(messageNumberFormats, key, () => {
        return new Intl.NumberFormat(
          numberLocale,
          options as Intl.NumberFormatOptions,
        );
      });
    },
    getDateTimeFormat: (...args) => {
      const key = JSON.stringify(args);
      return boundedFormatter(
        messageDateTimeFormats,
        key,
        () => new Intl.DateTimeFormat(...args),
      );
    },
    getPluralRules: (...args) => {
      const key = JSON.stringify(args);
      return boundedFormatter(
        messagePluralRules,
        key,
        () => new Intl.PluralRules(...args),
      );
    },
  };
}

function getMessageFormat(
  template: string,
  locale: SupportedLocale,
  numberLocale: string,
): IntlMessageFormat | null {
  const cacheKey = `${locale}\u0000${numberLocale}\u0000${template}`;
  const cached = messageFormats.get(cacheKey);
  if (cached !== undefined) return cached;
  if (messageFormats.size >= MESSAGE_CACHE_MAX) messageFormats.clear();
  let parsed: IntlMessageFormat | null;
  try {
    // ignoreTag keeps `<strong>`-style markup (backend email templates) as
    // literal text instead of ICU rich-text tags demanding render functions.
    parsed = new IntlMessageFormat(template, locale, undefined, {
      ignoreTag: true,
      formatters: messageFormatters(numberLocale),
    });
  } catch {
    parsed = null;
  }
  messageFormats.set(cacheKey, parsed);
  return parsed;
}

/**
 * ICU deliberately renders plain `{value}` arguments as raw strings. Preserve
 * that behavior for identifiers supplied as strings, while localizing finite
 * numeric arguments without grouping. This gives day numbers, ranks, counts,
 * years, and accessibility values the requested numeral glyphs/decimal
 * separator without turning identifier-like values into grouped prose.
 *
 * Arguments that drive a typed ICU construct remain numeric so plural/select
 * semantics are unchanged. Authors that want grouping still use
 * `{value, number}` or plural `#`.
 */
function localizePlainNumericValues(
  template: string,
  values: TranslationValues,
  numberLocale: string,
): TranslationValues {
  const plainNames = new Set<string>();
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    if (match[1]) plainNames.add(match[1]);
  }
  if (plainNames.size === 0) return values;

  const typedNames = new Set<string>();
  for (const match of template.matchAll(
    /\{(\w+)\s*,\s*(?:plural|selectordinal|select|number|date|time)\b/g,
  )) {
    if (match[1]) typedNames.add(match[1]);
  }

  let localized: TranslationValues | undefined;
  const formatter = boundedFormatter(
    messageNumberFormats,
    `${numberLocale}|plain`,
    () =>
      new Intl.NumberFormat(numberLocale, {
        useGrouping: false,
        maximumFractionDigits: 20,
      }),
  );
  for (const name of plainNames) {
    const value = values[name];
    if (
      !typedNames.has(name) &&
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      localized ??= { ...values };
      localized[name] = formatter.format(value);
    }
  }
  return localized ?? values;
}

// The pre-ICU engine, retained as the compatibility fallback: it never
// throws, leaves unmatched placeholders in place, and renders malformed
// templates verbatim — the contract the legacy tests pin.
function interpolateLegacy(
  template: string,
  values: TranslationValues,
): string {
  return template.replace(/\{(\w+)\}/g, (match, valueKey: string) => {
    const value = values[valueKey];
    return value === undefined ? match : String(value);
  });
}

/**
 * Build a translator over a surface's catalogs. Lookup order:
 * active-locale catalog → default-locale (en) catalog → the raw key.
 * Interpolation is ICU MessageFormat (plural/select/#) via
 * `intl-messageformat`, using the plural rules of the locale whose catalog
 * supplied the template (raw-key fallback ⇒ default locale). Calls without
 * values return the template verbatim (fast path — most catalog entries).
 * Any ICU parse/format error degrades to the legacy `{placeholder}`
 * substitution. Substitution is RAW — callers that emit HTML MUST escape
 * untrusted values before passing them in.
 */
export function makeTranslator<K extends string>(
  catalogs: CatalogsByLocale<K>,
): Translator<K> {
  const read = (locale: SupportedLocale, key: K): string | undefined => {
    const catalog = catalogs[locale] as Partial<Catalog<K>> | undefined;
    return catalog?.[key];
  };

  return (key, values, locale = DEFAULT_LOCALE, numberLocale = locale) => {
    let template = read(locale, key);
    let sourceLocale = locale;
    if (template === undefined && locale !== DEFAULT_LOCALE) {
      template = read(DEFAULT_LOCALE, key);
      sourceLocale = DEFAULT_LOCALE;
    }
    if (template === undefined) {
      template = key;
      sourceLocale = DEFAULT_LOCALE;
    }

    if (!values) return template;

    const parsed = getMessageFormat(template, sourceLocale, numberLocale);
    if (parsed === null) return interpolateLegacy(template, values);
    try {
      return parsed.format(
        localizePlainNumericValues(template, values, numberLocale),
      ) as string;
    } catch {
      return interpolateLegacy(template, values);
    }
  };
}
