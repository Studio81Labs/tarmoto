import { describe, it, expect } from "vitest";
import {
  DEFAULT_LOCALE,
  LOCALES,
  SUPPORTED_LOCALES,
  getUserFacingErrorMessage,
  isSupportedLocale,
  matchSupportedLocale,
  makeTranslator,
  resolveLocale,
  type CatalogsByLocale,
  type SupportedLocale,
} from "./i18n";

describe("i18n / registry", () => {
  it("registers exactly the locales declared in LOCALES, including the default", () => {
    expect(SUPPORTED_LOCALES).toEqual(Object.keys(LOCALES));
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  });
});

describe("i18n / getUserFacingErrorMessage", () => {
  it("returns only explicitly cataloged error messages", () => {
    const localized = Object.assign(new Error("Localized API failure"), {
      localizedUserMessage: true as const,
    });
    expect(getUserFacingErrorMessage(localized, "Translated fallback")).toBe(
      "Localized API failure",
    );
  });

  it("hides arbitrary runtime and non-error values", () => {
    expect(
      getUserFacingErrorMessage(
        new Error("Failed to fetch"),
        "Translated fallback",
      ),
    ).toBe("Translated fallback");
    expect(getUserFacingErrorMessage("socket exploded", "Fallback")).toBe(
      "Fallback",
    );
  });
});

describe("i18n / isSupportedLocale", () => {
  it("narrows registered locales and rejects prototype keys", () => {
    expect(isSupportedLocale("en")).toBe(true);
    expect(isSupportedLocale("xx")).toBe(false);
    expect(isSupportedLocale("toString")).toBe(false);
    expect(isSupportedLocale("__proto__")).toBe(false);
    expect(isSupportedLocale("constructor")).toBe(false);
  });
});

describe("i18n / resolveLocale", () => {
  it("returns DEFAULT_LOCALE for null / undefined / empty", () => {
    expect(resolveLocale(null)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale("")).toBe(DEFAULT_LOCALE);
  });

  it("matches the primary subtag of a single tag", () => {
    expect(resolveLocale("en-GB")).toBe("en");
    expect(resolveLocale("EN")).toBe("en");
  });

  it("walks an Accept-Language header, honouring q-weights", () => {
    expect(resolveLocale("xx-YY,en;q=0.8")).toBe("en");
    expect(resolveLocale("zz-AA;q=1,xx-YY;q=0.9")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale("xx;q=1.0,en;q=0.2")).toBe("en");
    expect(resolveLocale("en;q=garbage")).toBe("en");
    expect(resolveLocale("en;q=0.001")).toBe("en");
    expect(resolveLocale("en;q=0")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale("en;q=1.5")).toBe(DEFAULT_LOCALE);
  });
});

describe("i18n / matchSupportedLocale", () => {
  it("matches registry tags case-insensitively without defaulting", () => {
    expect(matchSupportedLocale("EN")).toBe("en");
    expect(matchSupportedLocale("en-GB")).toBe("en");
    expect(matchSupportedLocale("xx-YY")).toBeUndefined();
  });
});

describe("i18n / makeTranslator", () => {
  const t = makeTranslator<"greeting" | "photo">({
    en: { greeting: "Hi {name},", photo: "{name}'s photo" },
  });

  it("returns the catalog entry for a known key", () => {
    expect(t("greeting", { name: "Riku" })).toBe("Hi Riku,");
  });

  it("falls back to the raw key when no catalog entry exists", () => {
    // @ts-expect-error — exercising the runtime raw-key fallback path
    expect(t("__missing__")).toBe("__missing__");
  });

  it("leaves placeholders without a matching value untouched", () => {
    expect(t("photo")).toBe("{name}'s photo");
    expect(t("photo", {})).toBe("{name}'s photo");
  });

  it("falls back to the default-locale catalog for an unpopulated locale", () => {
    // @ts-expect-error — "et" is not a registered SupportedLocale; exercises the English fallback
    expect(t("greeting", { name: "Riku" }, "et")).toBe("Hi Riku,");
  });
});

describe("i18n / makeTranslator (ICU)", () => {
  type Key = string;
  const icuT = makeTranslator<Key>({
    en: {
      rides: "{count, plural, one {# ride} other {# rides}}",
      whose: "{gender, select, female {her} male {his} other {their}} bike",
      prose: "a full day's ride",
      literalBrace: "literal '{' brace {name}",
      markup: '<strong style="color:#f8fafc;">{code}</strong>',
      views: "{count, number} views",
    },
  });

  it("selects English plural branches and formats # with the message locale", () => {
    expect(icuT("rides", { count: 1 })).toBe("1 ride");
    expect(icuT("rides", { count: 2 })).toBe("2 rides");
    // Intentional change from the String(n) engine: en grouping.
    expect(icuT("rides", { count: 1234 })).toBe("1,234 rides");
  });

  it("supports select", () => {
    expect(icuT("whose", { gender: "female" })).toBe("her bike");
    expect(icuT("whose", { gender: "x" })).toBe("their bike");
  });

  it("keeps prose apostrophes and renders escaped literal braces", () => {
    expect(icuT("prose", {})).toBe("a full day's ride");
    expect(icuT("literalBrace", { name: "x" })).toBe("literal { brace x");
  });

  it("treats markup as literal text (ignoreTag)", () => {
    expect(icuT("markup", { code: "ABC" })).toBe(
      '<strong style="color:#f8fafc;">ABC</strong>',
    );
  });

  it("locale-formats explicit number-typed arguments (documented engine change)", () => {
    expect(icuT("views", { count: 1234 })).toBe("1,234 views");
  });

  it("keeps UI plural rules while using the independent number locale", () => {
    expect(icuT("rides", { count: 2 }, "en", "ar-EG")).toBe("٢ rides");
    expect(icuT("views", { count: 1234 }, "en", "de-DE")).toBe("1.234 views");
  });

  it("localizes finite numbers in plain placeholders without grouping identifiers", () => {
    expect(icuT("Day {day}", { day: 12 }, "en", "ar-EG")).toBe("Day ١٢");
    expect(icuT("Rank {rank}", { rank: 1234 }, "en", "ar-EG")).toBe(
      "Rank ١٢٣٤",
    );
    expect(icuT("Card {suffix}", { suffix: "1234" }, "en", "ar-EG")).toBe(
      "Card 1234",
    );
  });

  it("falls back to legacy interpolation for malformed messages and missing values", () => {
    // Unbalanced brace — ICU parse fails; legacy regex leaves it untouched.
    expect(icuT("Hi {name", { name: "R" })).toBe("Hi {name");
    // Valid ICU, missing value — legacy contract: placeholder stays.
    expect(icuT("Hi {a} {b}", { a: "x" })).toBe("Hi x {b}");
  });

  it("proves the machinery with a Czech-shaped catalog (one/few/other)", () => {
    // 'cs' is deliberately NOT in LOCALES — cast to exercise the engine the
    // way a future registered language would, without unhiding any UI.
    const cs = makeTranslator<string>({
      en: { left: "{count, plural, one {# day} other {# days}} left" },
      cs: {
        left: "{count, plural, one {Zbývá # den} few {Zbývají # dny} other {Zbývá # dní}}",
      },
    } as unknown as CatalogsByLocale<string>);
    const csLocale = "cs" as SupportedLocale;
    expect(cs("left", { count: 1 }, csLocale)).toBe("Zbývá 1 den");
    expect(cs("left", { count: 2 }, csLocale)).toBe("Zbývají 2 dny");
    expect(cs("left", { count: 5 }, csLocale)).toBe("Zbývá 5 dní");
    expect(cs("left", { count: 2 }, csLocale, "ar-EG")).toBe("Zbývají ٢ dny");
  });

  it("applies the plural rules of the catalog that supplied the template", () => {
    // Key missing from cs catalog → en template AND en plural rules apply.
    const cs = makeTranslator<string>({
      en: { left: "{count, plural, one {# day} other {# days}} left" },
      cs: {},
    } as unknown as CatalogsByLocale<string>);
    const csLocale = "cs" as SupportedLocale;
    expect(cs("left", { count: 2 }, csLocale)).toBe("2 days left");
    expect(cs("left", { count: 1234 }, csLocale)).toBe("1 234 days left");
  });
});
