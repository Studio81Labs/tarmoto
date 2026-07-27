import { getRequestLanguage, setActiveLocale } from ".";

describe("request language", () => {
  it("uses device detection before the app locale provider commits", () => {
    expect(getRequestLanguage("cs-CZ")).toBe("cs-CZ");
  });

  it("uses the committed UI locale instead of a different device locale", () => {
    setActiveLocale("en");

    expect(getRequestLanguage("cs-CZ")).toBe("en");
  });
});
