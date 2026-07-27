import { IntlMessageFormat } from "intl-messageformat";
import { validateIcuTranslation } from "@tarmoto/shared";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import ts from "typescript";
import { en } from "./en";
import { companionCatalogs } from ".";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const INVARIANT_NUMERIC_KEYS = new Set(["MT-09", "RoadWarrior42"]);

function productionSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        [
          "__tests__",
          "build",
          "coverage",
          "dist",
          "locales",
          "node_modules",
        ].includes(entry.name)
      ) {
        return [];
      }
      return productionSourceFiles(path);
    }
    if (
      !SOURCE_EXTENSIONS.has(extname(entry.name)) ||
      /\.(?:spec|test)\.[jt]sx?$/.test(entry.name)
    ) {
      return [];
    }
    return [path];
  });
}

function productionStringLiterals(): Set<string> {
  const literals = new Set<string>();
  const roots = [resolve(process.cwd(), "src")];
  const sharedSources = [
    resolve(process.cwd(), "../../packages/shared/src/regions.ts"),
    resolve(process.cwd(), "../../packages/shared/src/rider-format.ts"),
  ];
  for (const file of [
    ...roots.flatMap(productionSourceFiles),
    ...sharedSources,
  ]) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node) => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)
      ) {
        literals.add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return literals;
}

function hasVisibleAsciiDigit(message: string): boolean {
  if (INVARIANT_NUMERIC_KEYS.has(message)) return false;
  const visibleCopy = message.replace(
    /\{([A-Za-z_][\w-]*)/g,
    (_match, identifier: string) => `{${identifier.replace(/\d/g, "")}`,
  );
  return /\d/.test(visibleCopy);
}

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

  it("preserves ICU argument contracts and target-locale plural rules", () => {
    const failures = localizedEntries.flatMap(({ locale, key, message }) =>
      validateIcuTranslation(key, message, locale).map(
        (issue) => `${locale}:${key}: ${issue}`,
      ),
    );
    expect(failures).toEqual([]);
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

  it("contains no whitespace-dependent catalog keys", () => {
    expect(entries.filter(([key]) => key !== key.trim())).toEqual([]);
  });

  it("fully translates every registered production locale", () => {
    const sourceKeys = Object.keys(en).sort();
    const incomplete = Object.entries(companionCatalogs).flatMap(
      ([locale, catalog]) => {
        const translatedKeys = Object.keys(catalog).sort();
        const missing = sourceKeys.filter((key) => !(key in catalog));
        const extra = translatedKeys.filter((key) => !(key in en));
        return missing.length > 0 || extra.length > 0
          ? [{ locale, missing, extra }]
          : [];
      },
    );

    expect(incomplete).toEqual([]);
  });

  it("keeps only catalog keys reachable from production source", () => {
    const productionCopy = productionStringLiterals();
    expect(Object.keys(en).filter((key) => !productionCopy.has(key))).toEqual(
      [],
    );
  });

  it("keeps visible numerals out of catalog copy", () => {
    expect(Object.keys(en).filter(hasVisibleAsciiDigit)).toEqual([]);
  });
});
