import { IntlMessageFormat } from "intl-messageformat";
import { en } from "./en";

// Guards for future-locale readiness. Every catalog VALUE must be valid ICU
// (a translator will feed translated variants through the same parser), and
// must avoid ICU apostrophe-quoting pitfalls: `'{`/`'}` silently swallow the
// following brace, and `''` collapses to a single apostrophe — both would
// ALSO render literally on the no-values fast path, so they are always
// authoring mistakes, never intended output.
describe("companion en catalog ICU validity", () => {
  const entries = Object.entries(en) as [string, string][];

  it("parses every message as ICU", () => {
    const failures = entries
      .filter(([, message]) => {
        try {
          new IntlMessageFormat(message, "en", undefined, { ignoreTag: true });
          return false;
        } catch {
          return true;
        }
      })
      .map(([key]) => key);
    expect(failures).toEqual([]);
  });

  it("contains no ICU apostrophe-quoting sequences", () => {
    const offenders = entries
      .filter(
        ([, m]) => m.includes("'{") || m.includes("'}") || m.includes("''"),
      )
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  // Global Constraints 5-6: plural selection is always named `count` and
  // every plural message carries an `other` branch. Together with the
  // engine's plural tests (i18n.spec.ts) and the touched-site component
  // tests, this is the spec §7 "per-site count = 1/2/5" coverage: every
  // registered plural message is structurally exercisable at any count.
  it("every plural message uses the count argument and declares other", () => {
    const offenders = entries
      .filter(
        ([, m]) =>
          m.includes(", plural,") &&
          !(m.includes("{count, plural,") && m.includes("other {")),
      )
      .map(([key]) => key);
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
