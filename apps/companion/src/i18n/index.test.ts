import {
  DEFAULT_LOCALE,
  LOCALES,
  SUPPORTED_LOCALES,
  resolveLocale,
  setActiveLocale,
  translate,
} from ".";
import { companionCatalogs } from "./locales";

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

  it("registers a companion catalog for every supported locale", () => {
    expect(Object.keys(companionCatalogs).sort()).toEqual(
      [...SUPPORTED_LOCALES].sort(),
    );
  });

  it("renders an ICU plural through the companion translator", () => {
    expect(
      translate("{count, plural, one {# day} other {# days}}", { count: 1 }),
    ).toBe("1 day");
    expect(
      translate("{count, plural, one {# day} other {# days}}", { count: 3 }),
    ).toBe("3 days");
  });
});
