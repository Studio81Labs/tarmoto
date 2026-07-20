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
    expect(
      translate("{count, plural, one {# new hazard} other {# new hazards}}", {
        count: 1,
      }),
    ).toBe("1 new hazard");
    expect(
      translate("{count, plural, one {# new hazard} other {# new hazards}}", {
        count: 2,
      }),
    ).toBe("2 new hazards");
    expect(translate("Hazards ({count})", { count: 3 })).toBe("Hazards (3)");
    expect(translate("Saved routes ({count})", { count: 2 })).toBe(
      "Saved routes (2)",
    );
    expect(translate("Members ({count})", { count: 4 })).toBe("Members (4)");
    expect(
      translate("Save current area ({distance} km)", { distance: 25 }),
    ).toBe("Save current area (25 km)");
    expect(
      translate("Below your minimum ({quality})", { quality: "Fair" }),
    ).toBe("Below your minimum (Fair)");
    expect(translate("{distance} from start", { distance: "12.0 km" })).toBe(
      "12.0 km from start",
    );
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
