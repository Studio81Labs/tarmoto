import { makeTranslator } from "@tarmoto/shared";
import {
  LOCALES,
  SUPPORTED_LOCALES,
  getDocumentLocale,
  resolveLocale,
  tDynamic,
  translate,
} from ".";
import { companionCatalogs, en, type EnglishMessageKey } from "./locales";

describe("companion i18n barrel", () => {
  it("translates a known companion catalog key", () => {
    expect(translate("Home")).toBe("Home");
  });

  it("falls back to the raw key for an unknown string", () => {
    expect(tDynamic("__definitely-not-in-the-catalog__")).toBe(
      "__definitely-not-in-the-catalog__",
    );
  });

  it("interpolates placeholders", () => {
    expect(translate("{name}'s profile photo", { name: "Riku" })).toBe(
      "Riku's profile photo",
    );
  });

  it("re-exports the shared registry + resolver", () => {
    expect(SUPPORTED_LOCALES).toEqual(Object.keys(LOCALES));
    expect(resolveLocale("en-GB")).toBe("en");
  });

  it("reads the request-resolved browser locale from the root document", () => {
    document.documentElement.lang = "en-GB";
    expect(getDocumentLocale()).toBe("en");
  });

  it("registers a companion catalog for every supported locale", () => {
    expect(Object.keys(companionCatalogs).sort()).toEqual(
      [...SUPPORTED_LOCALES].sort(),
    );
  });

  it.each([
    [1, "1 day"],
    [2, "2 days"],
    [5, "5 days"],
  ])("renders ICU plural rules for count %i", (count, expected) => {
    expect(
      translate("{count, plural, one {# day} other {# days}}", { count }),
    ).toBe(expected);
  });

  it("pluralizes the remaining count-bearing companion labels", () => {
    expect(
      translate(
        "{count, plural, one {{n} public ride} other {{n} public rides}}",
        { count: 1, n: "1" },
      ),
    ).toBe("1 public ride");
    expect(
      translate(
        "{count, plural, one {{n} public ride} other {{n} public rides}}",
        { count: 2, n: "2" },
      ),
    ).toBe("2 public rides");
    expect(
      translate("{count, plural, one {# advisory} other {# advisories}}", {
        count: 2,
      }),
    ).toBe("2 advisories");
    expect(
      translate(
        "{count, plural, one {Ridden ({n} segment)} other {Ridden ({n} segments)}}",
        { count: 1, n: "1" },
      ),
    ).toBe("Ridden (1 segment)");
  });

  it("renders whole-sentence ICU select variants for ride types", () => {
    const key =
      "{rideType, select, free {{riderName}'s free ride} commute {{riderName}'s commute ride} trip {{riderName}'s trip ride} tracked {{riderName}'s tracked ride} other {{riderName}'s ride}}";

    expect(translate(key, { riderName: "Riku", rideType: "free" })).toBe(
      "Riku's free ride",
    );
    expect(translate(key, { riderName: "Riku", rideType: "future" })).toBe(
      "Riku's ride",
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

describe("tDynamic", () => {
  it("falls back to the raw key for an unregistered string", () => {
    expect(tDynamic("this key is not registered")).toBe(
      "this key is not registered",
    );
  });
  it("resolves and interpolates a registered key", () => {
    // "Level {level} · {xp} XP" is a registered catalog key.
    expect(tDynamic("Level {level} · {xp} XP", { level: 3, xp: 120 })).toBe(
      "Level 3 · 120 XP",
    );
  });
});
