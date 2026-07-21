import { IntlMessageFormat } from "intl-messageformat";
import { en } from "./en";
import { companionCatalogs } from ".";

// Guards for future-locale readiness. Every catalog VALUE must be valid ICU
// (a translator will feed translated variants through the same parser), and
// must avoid ICU apostrophe-quoting pitfalls: `'{`/`'}` silently swallow the
// following brace, and `''` collapses to a single apostrophe — both would
// ALSO render literally on the no-values fast path, so they are always
// authoring mistakes, never intended output.
describe("companion catalog ICU validity", () => {
  const entries = Object.entries(en) as [string, string][];
  const localizedEntries = Object.entries(companionCatalogs).flatMap(
    ([locale, catalog]) =>
      Object.entries(catalog)
        .filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        )
        .map(([key, message]) => ({ locale, key, message })),
  );

  it("parses every message as ICU", () => {
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

  it("contains no ICU apostrophe-quoting sequences", () => {
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

  // The English source text IS the key, so every entry must be `key === value`.
  // `makeTranslator` returns the VALUE for a registered key, so a typo'd value
  // silently changes rendered English — a drift the PR 3b typed flip can never
  // catch (it constrains the key side only). This guards the next hand-edit.
  it("registers every key as its own English value", () => {
    const mismatches = entries
      .filter(([key, value]) => key !== value)
      .map(([key]) => key);
    expect(mismatches).toEqual([]);
  });
});
