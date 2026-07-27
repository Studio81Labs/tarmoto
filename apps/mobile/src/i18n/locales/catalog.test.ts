import { IntlMessageFormat } from "intl-messageformat";
import { validateIcuTranslation } from "@tarmoto/shared";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import ts from "typescript";
import { en } from "./en";
import { mobileCatalogs } from ".";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const INVARIANT_NUMERIC_KEYS = new Set([
  "+420 123 456 789",
  "e.g. 8f3d0c1e-...",
  "e.g. BMW R1250GS",
  "e.g. TARMOTO-42",
]);

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

  it("preserves ICU argument contracts and target-locale plural rules", () => {
    const failures = localizedEntries.flatMap(({ locale, key, message }) =>
      validateIcuTranslation(key, message, locale).map(
        (issue) => `${locale}:${key}: ${issue}`,
      ),
    );

    expect(failures).toEqual([]);
  });

  it("keeps English source keys and values identical", () => {
    expect(entries.filter(([key, value]) => key !== value)).toEqual([]);
  });

  it("contains no whitespace-only sentence fragments", () => {
    expect(entries.filter(([key]) => key !== key.trim())).toEqual([]);
  });

  it("fully translates every registered production locale", () => {
    const sourceKeys = Object.keys(en).sort();
    const incomplete = Object.entries(mobileCatalogs).flatMap(
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
