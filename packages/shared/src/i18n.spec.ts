import { describe, it, expect } from "vitest";
import {
  DEFAULT_LOCALE,
  LOCALES,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  makeTranslator,
  resolveLocale,
} from "./i18n";

describe("i18n / registry", () => {
  it("registers exactly the locales declared in LOCALES, including the default", () => {
    expect(SUPPORTED_LOCALES).toEqual(Object.keys(LOCALES));
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
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
    expect(t("greeting", { name: "Riku" }, "en")).toBe("Hi Riku,");
  });
});
