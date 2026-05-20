import {
  DEFAULT_LOCALE,
  LOCALES,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  resolveLocale,
  setActiveLocale,
  translate,
} from ".";

describe("i18n / translate", () => {
  beforeEach(() => {
    setActiveLocale(DEFAULT_LOCALE);
  });

  it("returns the catalog entry for a known key", () => {
    expect(translate("Home")).toBe("Home");
  });

  it("falls back to the raw key when the catalog has no entry for it", () => {
    expect(translate("__definitely-not-in-the-catalog__")).toBe(
      "__definitely-not-in-the-catalog__",
    );
  });

  it("interpolates {placeholder} values", () => {
    expect(translate("{name}'s profile photo", { name: "Riku" })).toBe(
      "Riku's profile photo",
    );
  });

  it("leaves untouched placeholders that have no matching value", () => {
    expect(translate("{greeting}, {name}", { greeting: "Hi" })).toBe(
      "Hi, {name}",
    );
  });

  it("registers exactly the locales declared in the registry", () => {
    expect(SUPPORTED_LOCALES).toEqual(Object.keys(LOCALES));
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  });
});

describe("i18n / resolveLocale", () => {
  it("returns DEFAULT_LOCALE for null / undefined / empty input", () => {
    expect(resolveLocale(null)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale("")).toBe(DEFAULT_LOCALE);
  });

  it("matches the primary subtag of a single tag", () => {
    expect(resolveLocale("en-GB")).toBe("en");
    expect(resolveLocale("EN")).toBe("en");
  });

  it("walks an Accept-Language header and picks the first supported tag", () => {
    expect(resolveLocale("xx-YY,en;q=0.8")).toBe("en");
    expect(resolveLocale("zz-AA;q=1,xx-YY;q=0.9")).toBe(DEFAULT_LOCALE);
  });

  it("parses q-values without crashing and still picks a supported tag", () => {
    // Higher-q tag is unsupported; we should fall through to the
    // lower-q supported tag rather than returning DEFAULT_LOCALE blindly.
    expect(resolveLocale("xx;q=1.0,en;q=0.2")).toBe("en");
    expect(resolveLocale("en;q=0.001")).toBe("en");
    expect(resolveLocale("en;q=garbage")).toBe("en");
  });

  // Once a second locale (e.g. "et") is registered, add a test that
  // verifies `resolveLocale("en;q=0.4,et;q=1.0")` resolves to "et" — the
  // q-value sort is currently unobservable through behaviour because only
  // one locale matches in any test input.
});

describe("i18n / isSupportedLocale", () => {
  it("narrows registered locales", () => {
    expect(isSupportedLocale("en")).toBe(true);
    expect(isSupportedLocale("xx")).toBe(false);
  });

  it("rejects Object prototype keys so /api/locale and translate() are safe", () => {
    // `value in LOCALES` would let these through and crash translate() when
    // it tried to read `.messages` off the inherited method.
    expect(isSupportedLocale("toString")).toBe(false);
    expect(isSupportedLocale("hasOwnProperty")).toBe(false);
    expect(isSupportedLocale("__proto__")).toBe(false);
    expect(isSupportedLocale("constructor")).toBe(false);
  });
});
