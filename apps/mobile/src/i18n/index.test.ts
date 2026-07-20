import { makeTranslator } from "@tarmoto/shared";
import {
  DEFAULT_LOCALE,
  LOCALES,
  SUPPORTED_LOCALES,
  resolveLocale,
  setActiveLocale,
  tDynamic,
  translate,
} from ".";
import { en, mobileCatalogs, type EnglishMessageKey } from "./locales";

describe("mobile i18n", () => {
  beforeEach(() => {
    setActiveLocale(DEFAULT_LOCALE);
  });

  it("translates registered copy and ICU values", () => {
    expect(translate("Home")).toBe("Home");
    expect(translate("Code: {code}", { code: "ABC123" })).toBe("Code: ABC123");
    expect(
      translate("{count, plural, one {# day} other {# days}}", { count: 2 }),
    ).toBe("2 days");
  });

  it("keeps the deliberate dynamic-key fallback", () => {
    expect(tDynamic("runtime server copy")).toBe("runtime server copy");
  });

  it("re-exports the shared locale registry and resolver", () => {
    expect(SUPPORTED_LOCALES).toEqual(Object.keys(LOCALES));
    expect(resolveLocale("en-GB")).toBe("en");
  });

  it("registers a mobile catalog for every supported locale", () => {
    expect(Object.keys(mobileCatalogs).sort()).toEqual(
      [...SUPPORTED_LOCALES].sort(),
    );
  });

  it("can pseudo-expand every registered key", () => {
    const pseudo = Object.fromEntries(
      Object.keys(en).map((key) => [key, `[!! ${key} !!]`]),
    ) as Record<EnglishMessageKey, string>;
    const pseudoTranslate = makeTranslator<EnglishMessageKey>({ en: pseudo });

    for (const key of Object.keys(en) as EnglishMessageKey[]) {
      expect(pseudoTranslate(key)).toBe(`[!! ${key} !!]`);
    }
  });
});
