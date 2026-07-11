import {
  DEFAULT_LOCALE,
  LOCALES,
  SUPPORTED_LOCALES,
  resolveLocale,
  setActiveLocale,
  translate,
} from ".";

describe("companion i18n barrel", () => {
  beforeEach(() => {
    setActiveLocale(DEFAULT_LOCALE);
  });

  it("translates a known companion catalog key", () => {
    expect(translate("Home")).toBe("Home");
  });

  it("falls back to the raw key for an unknown string", () => {
    expect(translate("__definitely-not-in-the-catalog__")).toBe(
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
});
