import { publicLanguageAlternates, publicLocalePath } from "./publicLocale";
import type { SupportedLocale } from "@tarmoto/shared";

describe("public locale URLs", () => {
  it("keeps the default locale on the clean canonical path", () => {
    expect(publicLocalePath("/roads/best", "en")).toBe("/roads/best");
    expect(publicLanguageAlternates("/roads/best")).toEqual({
      en: "/roads/best",
    });
  });

  it("gives future locales a stable indexable query URL", () => {
    expect(
      publicLocalePath("/roads/best?surface=good", "cs" as SupportedLocale),
    ).toBe("/roads/best?surface=good&lang=cs");
  });
});
