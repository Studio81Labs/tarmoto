import { IntlMessageFormat } from "intl-messageformat";
import { en } from "./en";
import { mobileCatalogs } from ".";

describe("mobile catalog validity", () => {
  const entries = Object.entries(en) as [string, string][];
  const localizedEntries = Object.entries(mobileCatalogs).flatMap(
    ([locale, catalog]) =>
      Object.entries(catalog)
        .filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        )
        .map(([key, message]) => ({ locale, key, message })),
  );

  it("parses every message as ICU in its source locale", () => {
    const failures = localizedEntries
      .filter(({ locale, message }) => {
        try {
          new IntlMessageFormat(message, locale, undefined, {
            ignoreTag: true,
          });
          return false;
        } catch {
          return true;
        }
      })
      .map(({ locale, key }) => `${locale}:${key}`);

    expect(failures).toEqual([]);
  });

  it("avoids ICU apostrophe-quoting traps", () => {
    const offenders = localizedEntries
      .filter(
        ({ message }) =>
          message.includes("'{") ||
          message.includes("'}") ||
          message.includes("''"),
      )
      .map(({ locale, key }) => `${locale}:${key}`);

    expect(offenders).toEqual([]);
  });

  it("uses an other branch for every plural in every locale", () => {
    const offenders = localizedEntries
      .filter(
        ({ message }) =>
          (message.match(/,\s*plural,/g)?.length ?? 0) >
          (message.match(/\bother\s*\{/g)?.length ?? 0),
      )
      .map(({ locale, key }) => `${locale}:${key}`);

    expect(offenders).toEqual([]);
  });

  it("keeps English source keys and values identical", () => {
    expect(entries.filter(([key, value]) => key !== value)).toEqual([]);
  });

  it("contains no whitespace-only sentence fragments", () => {
    expect(entries.filter(([key]) => key !== key.trim())).toEqual([]);
  });
});
