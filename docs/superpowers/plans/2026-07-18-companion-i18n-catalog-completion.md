# Companion i18n Catalog Completion (PR 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register every companion `t()` literal that currently renders only via raw-key fallback, and split the monolithic English catalog into per-domain modules — so PR 3b can flip the translator signature to typed keys — while keeping English output byte-identical.

**Architecture:** Two mechanical tasks plus a docs touch-up. (1) _Compiler-as-oracle backfill_: a throwaway signature-narrowing scaffold makes every unregistered literal surface as a `TS2345` error; harvest those literals and append them to the catalog as `key === value` entries; the loose signature is restored before commit (the flip itself is PR 3b). (2) _Split_: partition the complete catalog into per-domain modules under `locales/en/` merged by a barrel, routed by where each key is used, with a catch-all `common` module — guarded by a no-key-lost check and a cross-module duplicate-key test that make routing imperfections harmless. English output never changes: additive keys + a structural file move only.

**Tech Stack:** TypeScript (strict), `intl-messageformat`, Vitest, Next.js, pnpm workspaces, `tsx` for throwaway migration scripts.

## Global Constraints

- **The loose `translate(key: string)` signature stays UNCHANGED in PR 3a.** The narrowing to `EnglishMessageKey` is a throwaway worklist scaffold — it is applied, measured, and reverted; it is NEVER committed. The typed flip is PR 3b.
- **Catalog entries are strictly `key === value` English.** The current `en.ts` has 1271 keys, 0 key≠value pairs — preserve that invariant for every added key.
- **Non-ASCII in keys is escaped as `\uXXXX`** to match the existing catalog convention (em-dash `—` → `—`, middot `·` → `·`, bullet `•` → `•`, ellipsis `…` → `…`, etc.). Serialize with `JSON.stringify(s).replace(/[\u0080-\uFFFF]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))`.
- **Keys are alphabetical within each module.**
- **English output is byte-identical** — this PR only adds catalog keys and moves the catalog into modules. No copy changes, no plural changes, no signature changes.
- **Every catalog VALUE must be valid ICU** and must avoid `'{`, `'}`, `''` (the existing `catalog.test.ts` guard) — a backfilled literal that trips this has a real source-string ICU bug; fix it at the `t()` call site, do not silence the guard.
- **Full companion Vitest suite + Playwright e2e stay green.** English is unchanged, so no test literals should need updating.

### Environmental gotchas (this repo, this environment)

- Git hooks wedge in this environment. Commit with `git -c core.hooksPath=/dev/null -c core.fsmonitor=false commit`, and run `npx prettier --write <files>` manually before each commit.
- The sandbox SIGKILLs long `tsc` runs. Run any `tsc --noEmit` with sandbox disabled (`dangerouslyDisableSandbox: true`).
- `pnpm test` does NOT accept a file filter. Run a single test file with `npx vitest run <path>` from `apps/companion`.
- Next.js leaves stale route validators in `apps/companion/.next/dev/types`. Run `rm -rf apps/companion/.next/dev/types` before any `tsc --noEmit`, or old errors reappear.
- If `main` is merged mid-branch, rebuild shared: `pnpm --filter @tarmoto/shared build` (stale dist otherwise reports phantom type errors).

### Key facts (measured on `main` @ 176db3e7)

- `apps/companion/src/i18n/locales/en.ts` — `export const en = { ... } as const;` then `export type EnglishMessageKey = keyof typeof en;`. 1271 keys, strictly `key === value`.
- `apps/companion/src/i18n/index.ts:52-58` is the translator entry point:
  ```ts
  export function translate(
    key: string,
    values?: TranslationValues,
    locale: SupportedLocale = activeLocale,
  ): string {
    return baseTranslate(key as EnglishMessageKey, values, locale);
  }
  export const t = translate;
  ```
- `apps/companion/src/i18n/locales/index.ts` imports `{ en, type EnglishMessageKey } from "./en"` and defines `companionCatalogs` + `TranslationCatalog`. `./en` resolves to `en.ts` today and will resolve to `en/index.ts` (a directory barrel) after the split — so this file needs no code change, only verification.
- `apps/companion/src/i18n/locales/catalog.test.ts` imports `{ en } from "./en"` and asserts ICU validity / apostrophe-quoting / plural shape. It also needs no change (same `./en` resolution).
- The typed-flip experiment (narrow the signature, run `tsc`) measured **922 total errors across 58 files (839 src + 83 test)** before backfill, in three classes: (1) unregistered string literals → `TS2345: Argument of type '"..."'` (the class this PR clears), (2) dynamic string keys → `TS2345: Argument of type 'string'` (PR 3b), (3) the narrowed function not assignable to `LooseTranslate` → `TS2345: Argument of type '(key: ...) => string'` (PR 3b).

---

### Task 1: Backfill the catalog to zero class-1 source errors

Register every unregistered `t()` string literal so that, under the narrowing scaffold, no source file produces a `TS2345: Argument of type '"..."'` error. The loose signature is restored before the commit.

**Files:**

- Modify: `apps/companion/src/i18n/locales/en.ts` (append ~800 `key === value` entries)
- Scaffold only (reverted, NOT committed): `apps/companion/src/i18n/index.ts:53`
- Throwaway script (run, then delete — NOT committed): `scratch/i18n-backfill.mts`

**Interfaces:**

- Consumes: the current `en` catalog (`Object.keys(en)`), the companion `tsconfig.json`.
- Produces: an `en.ts` where every source `t("literal")` / `translate("literal")` call has a matching key. The `translate` signature is still `key: string`. No new exports.

- [ ] **Step 1: Confirm the baseline is green and the key===value invariant holds**

Run (from `apps/companion`):

```bash
npx vitest run src/i18n/locales/catalog.test.ts
```

Expected: PASS (3 tests).

Confirm the invariant (from repo root, sandbox disabled):

```bash
npx tsx -e 'const {en}=require("./apps/companion/src/i18n/locales/en.ts"); const e=Object.entries(en); console.log("keys",e.length,"mismatches",e.filter(([k,v])=>k!==v).length)'
```

Expected: `keys 1271 mismatches 0`.

- [ ] **Step 2: Apply the narrowing scaffold**

Edit `apps/companion/src/i18n/index.ts` — change line 53 only:

```ts
// BEFORE
  key: string,
// AFTER
  key: EnglishMessageKey,
```

(`EnglishMessageKey` is already imported at the top of the file.) Leave everything else untouched. This makes every `t("literal")` call type-check against the key union.

- [ ] **Step 3: Run tsc and capture the diagnostics**

Run (sandbox disabled, from `apps/companion`):

```bash
rm -rf .next/dev/types
npx tsc --noEmit 2>&1 | tee /tmp/tsc-scaffold.txt | grep -c "error TS"
```

Expected: a large count (~900). The full output is now in `/tmp/tsc-scaffold.txt`.

- [ ] **Step 4: Write the harvest+append script**

Create `scratch/i18n-backfill.mts` (create the `scratch/` dir if needed; it is throwaway and must NOT be committed):

```ts
import { readFileSync, writeFileSync } from "node:fs";

const TSC = "/tmp/tsc-scaffold.txt";
const EN = "apps/companion/src/i18n/locales/en.ts";

// Class-1 only: string-literal arguments. TS renders them as '"..."'.
// Class-2 ('string') and class-3 ('(key: ...) => string') never start with
// '"' after "Argument of type ", so this pattern naturally excludes them.
const LITERAL = /error TS2345: Argument of type '"(.*)"' is not assignable/;
// The tsc line begins with the file path; Next route-group dirs like
// `(auth)`/`(dashboard)` put parens INSIDE the path, so match test/e2e
// exclusion against the whole line rather than a captured path segment.
const IS_TEST = /\.(test|spec)\.tsx?\(|(?:__tests__|e2e)\//;

const missing = new Set<string>();
for (const line of readFileSync(TSC, "utf8").split("\n")) {
  const m = line.match(LITERAL);
  if (!m) continue;
  if (IS_TEST.test(line)) continue; // source files only — tests are PR 3b
  // Undo TS's own escaping of the rendered literal.
  const key = m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  missing.add(key);
}

const escape = (s: string): string =>
  JSON.stringify(s).replace(
    /[\u0080-\uFFFF]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );

const toAdd = [...missing].sort();
console.log(`harvested ${toAdd.length} missing source literals`);

const en = readFileSync(EN, "utf8");
const marker = "} as const;";
const at = en.lastIndexOf(marker);
if (at === -1) throw new Error("could not find `} as const;` in en.ts");

const block =
  "  // ---- PR 3a backfill (previously raw-key-fallback literals) ----\n" +
  toAdd.map((k) => `  ${escape(k)}: ${escape(k)},`).join("\n") +
  "\n";

writeFileSync(EN, en.slice(0, at) + block + en.slice(at));
console.log("appended before `} as const;`");
```

Note: `missing` cannot collide with existing keys — an existing key is already in the union and produces no `TS2345`. Duplicates within the harvest are collapsed by the `Set`.

- [ ] **Step 5: Run the harvest+append script**

Run (from repo root, sandbox disabled):

```bash
npx tsx scratch/i18n-backfill.mts
```

Expected: `harvested <N> missing source literals` (N in the hundreds) and `appended before \`} as const;\``.

- [ ] **Step 6: Revert the scaffold**

Edit `apps/companion/src/i18n/index.ts` line 53 back to `  key: string,`. The committed signature MUST be the loose one.

- [ ] **Step 7: Format the catalog**

```bash
npx prettier --write apps/companion/src/i18n/locales/en.ts
```

- [ ] **Step 8: Verify zero class-1 source errors under a fresh scaffold pass**

Re-apply the scaffold (Step 2), then run (sandbox disabled, from `apps/companion`):

```bash
rm -rf .next/dev/types
npx tsc --noEmit 2>&1 \
  | grep "error TS2345: Argument of type '\"" \
  | grep -vE "\.(test|spec)\.tsx?\(" \
  | grep -vE "(__tests__|e2e)/" \
  | wc -l
```

Expected: `0`.

If it is not 0, the remaining lines are literals the harvest regex missed (e.g. a literal containing an escaped newline). Add each remaining literal to the backfill block in `en.ts` by hand (as `"literal": "literal",`, `\uXXXX`-escaped), re-run this step until it prints `0`. Then **revert the scaffold again** (Step 6) and re-run prettier (Step 7).

- [ ] **Step 9: Confirm the catalog guards still pass**

The backfilled values are plain English (`key === value`); most are inert, but any containing `{...}` are ICU messages that must parse.

```bash
npx vitest run src/i18n/locales/catalog.test.ts
```

Expected: PASS (3 tests).

If the ICU-parse or apostrophe-quoting test now fails, a backfilled source string has a latent ICU bug (an unescaped `'{`/`'}`/`''`). Fix it at the source `t(...)` call — escape the apostrophe as `''` — and update the catalog key + value to match the corrected source string. Do NOT weaken the guard.

- [ ] **Step 10: Re-confirm the key===value invariant and count**

```bash
npx tsx -e 'const {en}=require("./apps/companion/src/i18n/locales/en.ts"); const e=Object.entries(en); console.log("keys",e.length,"mismatches",e.filter(([k,v])=>k!==v).length)'
```

Expected: `keys <1271 + N> mismatches 0`.

- [ ] **Step 11: Delete the throwaway script and commit**

```bash
rm -rf scratch/i18n-backfill.mts
git -c core.hooksPath=/dev/null -c core.fsmonitor=false add apps/companion/src/i18n/locales/en.ts
git -c core.hooksPath=/dev/null -c core.fsmonitor=false status --short
```

Confirm `git status` shows ONLY `apps/companion/src/i18n/locales/en.ts` staged, and that `apps/companion/src/i18n/index.ts` is unmodified (no scaffold leak) and `scratch/` is gone.

```bash
git -c core.hooksPath=/dev/null -c core.fsmonitor=false commit -m "feat(companion): backfill i18n catalog with previously raw-key-fallback literals"
```

---

### Task 2: Split the catalog into per-domain modules

Move the complete (backfilled) catalog from one `en.ts` into per-domain modules under `locales/en/`, merged by a barrel. Routing is by usage; a `common` module catches cross-domain and unreferenced keys. Two guards make the move safe: a no-key-lost check (throwaway, at implementation time) and a durable cross-module duplicate-key test.

**Files:**

- Create: `apps/companion/src/i18n/locales/en/common.ts`, `.../auth.ts`, `.../rides.ts`, `.../trips.ts`, `.../community.ts`, `.../achievements.ts`, `.../settings.ts`, `.../map.ts` (only the modules that receive ≥1 key are created; `common.ts` is always created)
- Create: `apps/companion/src/i18n/locales/en/index.ts` (barrel)
- Create: `apps/companion/src/i18n/locales/en/duplicate-keys.test.ts`
- Delete: `apps/companion/src/i18n/locales/en.ts`
- Verify unchanged: `apps/companion/src/i18n/locales/index.ts`, `apps/companion/src/i18n/locales/catalog.test.ts` (both import `./en`, which now resolves to the directory barrel)
- Throwaway script (run, then delete — NOT committed): `scratch/i18n-split.mts`

**Interfaces:**

- Consumes: the backfilled `en.ts` from Task 1.
- Produces: `apps/companion/src/i18n/locales/en/index.ts` exporting `export const en = { ...common, ...auth, ... }`, `export type EnglishMessageKey = keyof typeof en`, and `export const __catalogModules = { common, auth, ... } as const` (used by the duplicate-key test). The exported `en` and `EnglishMessageKey` are drop-in replacements for the old `en.ts` exports.

- [ ] **Step 1: Snapshot the pre-split key set**

Run (repo root, sandbox disabled):

```bash
npx tsx -e 'const {en}=require("./apps/companion/src/i18n/locales/en.ts"); require("node:fs").writeFileSync("/tmp/en-keys-old.txt", Object.keys(en).sort().join("\n"))'
wc -l /tmp/en-keys-old.txt
```

Expected: a non-empty file (line count = the backfilled key total minus 1).

- [ ] **Step 2: Write the split script**

Create `scratch/i18n-split.mts` (throwaway, NOT committed):

```ts
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

const ROOT = "apps/companion";
const SRC = `${ROOT}/src`;
const OUT = `${ROOT}/src/i18n/locales/en`;

// Complete catalog (key === value) from Task 1.
const { en } = require(`${process.cwd()}/${ROOT}/src/i18n/locales/en.ts`);
const allKeys: string[] = Object.keys(en);

// --- Build key -> referencing source files (approximate; routing only) ---
function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      walk(p, acc);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
      if (/(?:^|\/)(?:__tests__|e2e)\//.test(p)) continue;
      acc.push(p);
    }
  }
  return acc;
}

const callRe = /\bt(?:ranslate)?\(\s*"((?:[^"\\]|\\.)*)"/g;
const keyToFiles = new Map<string, Set<string>>();
for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(text))) {
    const key = m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (!(key in en)) continue;
    (keyToFiles.get(key) ?? keyToFiles.set(key, new Set()).get(key)!).add(file);
  }
}

// --- Path -> domain (longest matching prefix wins; default `common`) ---
const RULES: [prefix: string, domain: string][] = [
  ["src/app/(auth)/", "auth"],
  ["src/lib/auth-errors", "auth"],
  ["src/app/(dashboard)/trips/", "trips"],
  ["src/app/trips/", "trips"],
  ["src/lib/planner/", "trips"],
  ["src/app/(dashboard)/community/", "community"],
  ["src/app/community/", "community"],
  ["src/app/(dashboard)/achievements/", "achievements"],
  ["src/lib/gamification", "achievements"],
  ["src/app/(dashboard)/settings/", "settings"],
  ["src/lib/subscription", "settings"],
  ["src/app/(dashboard)/rides/", "rides"],
  ["src/app/rides/", "rides"],
  ["src/lib/ride-compare", "rides"],
  ["src/lib/segment-preview", "rides"],
  ["src/app/(dashboard)/explore/", "map"],
  ["src/app/explore/", "map"],
  ["src/app/discover/", "map"],
  ["src/app/roads/", "map"],
  ["src/app/road-map/", "map"],
  ["src/components/map/", "map"],
  ["src/lib/conditions", "map"],
  ["src/lib/passes", "map"],
  ["src/lib/closures", "map"],
  ["src/lib/exploration", "map"],
];
function domainOf(file: string): string {
  const rel = file.startsWith(`${ROOT}/`) ? file.slice(ROOT.length + 1) : file;
  let bestLen = -1;
  let domain = "common";
  for (const [prefix, dom] of RULES) {
    if (rel.startsWith(prefix) && prefix.length > bestLen) {
      bestLen = prefix.length;
      domain = dom;
    }
  }
  return domain;
}

// --- Assign every key to exactly one bucket ---
const buckets = new Map<string, string[]>([["common", []]]);
for (const key of allKeys) {
  const files = keyToFiles.get(key);
  let domain = "common";
  if (files && files.size) {
    const doms = new Set([...files].map(domainOf));
    domain = doms.size === 1 ? [...doms][0] : "common";
  }
  (buckets.get(domain) ?? buckets.set(domain, []).get(domain)!).push(key);
}

// --- Emit modules ---
const escape = (s: string): string =>
  JSON.stringify(s).replace(
    /[\u0080-\uFFFF]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
mkdirSync(OUT, { recursive: true });
const domains = [...buckets.keys()]
  .filter((d) => buckets.get(d)!.length)
  .sort();
for (const d of domains) {
  const body = buckets
    .get(d)!
    .sort()
    .map((k) => `  ${escape(k)}: ${escape(k)},`)
    .join("\n");
  writeFileSync(
    `${OUT}/${d}.ts`,
    `export const ${d} = {\n${body}\n} as const;\n`,
  );
  console.log(`${d}.ts: ${buckets.get(d)!.length} keys`);
}

// --- Emit barrel ---
const barrel =
  domains.map((d) => `import { ${d} } from "./${d}";`).join("\n") +
  "\n\n" +
  "// English source catalog, split by domain. Keys are the English source\n" +
  "// text (key === value). `EnglishMessageKey` is the union PR 3b's typed\n" +
  "// `t()` enforces. A new key goes in the domain module it is used from,\n" +
  "// or `common` if it is shared across domains.\n" +
  "export const en = {\n" +
  domains.map((d) => `  ...${d},`).join("\n") +
  "\n};\n\n" +
  "export type EnglishMessageKey = keyof typeof en;\n\n" +
  "/** Every domain module, for the cross-module duplicate-key test. */\n" +
  "export const __catalogModules = {\n" +
  domains.map((d) => `  ${d},`).join("\n") +
  "\n} as const;\n";
writeFileSync(`${OUT}/index.ts`, barrel);
console.log(`barrel: ${domains.length} modules`);
```

- [ ] **Step 3: Run the split script, then delete the monolith**

Run (repo root, sandbox disabled):

```bash
npx tsx scratch/i18n-split.mts
rm apps/companion/src/i18n/locales/en.ts
npx prettier --write "apps/companion/src/i18n/locales/en/*.ts"
```

Expected: one `<domain>.ts: <n> keys` line per non-empty domain, then `barrel: <k> modules`.

- [ ] **Step 4: Verify NO key was lost or added (the correctness gate)**

```bash
npx tsx -e 'const {en}=require("./apps/companion/src/i18n/locales/en/index.ts"); require("node:fs").writeFileSync("/tmp/en-keys-new.txt", Object.keys(en).sort().join("\n"))'
diff /tmp/en-keys-old.txt /tmp/en-keys-new.txt && echo "KEY SETS IDENTICAL"
```

Expected: `KEY SETS IDENTICAL` (empty diff). If the diff is non-empty, it names each lost (`<`) or added (`>`) key — the split dropped or duplicated one. Do not proceed; re-run Step 3 after fixing the script.

- [ ] **Step 5: Write the durable cross-module duplicate-key test**

Create `apps/companion/src/i18n/locales/en/duplicate-keys.test.ts`:

```ts
import { __catalogModules } from "./index";

// The barrel merges domain modules with object spread, which silently
// resolves a duplicate key to whichever module is spread last. This test
// makes such a collision a hard failure so a key can never live in two
// modules with one copy silently shadowed.
describe("en catalog domain partition", () => {
  it("defines every key in exactly one domain module", () => {
    const owner = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [domain, mod] of Object.entries(__catalogModules)) {
      for (const key of Object.keys(mod)) {
        const prior = owner.get(key);
        if (prior)
          duplicates.push(`"${key}" in both "${prior}" and "${domain}"`);
        else owner.set(key, domain);
      }
    }
    expect(duplicates).toEqual([]);
  });
});
```

- [ ] **Step 6: Run the duplicate-key test**

```bash
npx vitest run src/i18n/locales/en/duplicate-keys.test.ts
```

Expected: PASS (1 test). If it fails, the same key was routed into two modules — the split script's `buckets` assignment is broken (each key must be pushed once). Fix the script and re-run from Step 3.

- [ ] **Step 7: Confirm the ICU guard and catalog-completeness tests still pass**

`catalog.test.ts` and `index.test.ts` import `./en` / the catalog, now resolved to the barrel:

```bash
npx vitest run src/i18n/locales/catalog.test.ts src/i18n/index.test.ts
```

Expected: PASS. (If `index.test.ts` does not exist, run only `catalog.test.ts`.)

- [ ] **Step 8: Typecheck the workspace (loose signature, so this must be clean)**

Run (sandbox disabled, from `apps/companion`):

```bash
rm -rf .next/dev/types
npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Expected: `0`. The loose `translate(key: string)` signature is unchanged, so the split must not introduce any type error. If `error TS` appears, most likely `locales/index.ts` or `catalog.test.ts` failed to resolve `./en` — confirm `apps/companion/src/i18n/locales/en/index.ts` exists and exports both `en` and `EnglishMessageKey`.

- [ ] **Step 9: Run the broader i18n test group**

```bash
npx vitest run src/i18n
```

Expected: PASS (all i18n tests — engine consumers, server locale, catalog guards, duplicate-key).

- [ ] **Step 10: Delete the throwaway script and commit**

```bash
rm -rf scratch/i18n-split.mts
npx prettier --write apps/companion/src/i18n/locales/en/duplicate-keys.test.ts
git -c core.hooksPath=/dev/null -c core.fsmonitor=false add apps/companion/src/i18n/locales/en apps/companion/src/i18n/locales/en.ts
git -c core.hooksPath=/dev/null -c core.fsmonitor=false status --short
```

Confirm `git status` shows the new `locales/en/` module files + `duplicate-keys.test.ts` added, `locales/en.ts` deleted, and NOTHING else (no `scratch/`, no scaffold in `index.ts`).

```bash
git -c core.hooksPath=/dev/null -c core.fsmonitor=false commit -m "refactor(companion): split i18n english catalog into per-domain modules"
```

---

### Task 3: Update the add-a-language docs for the split structure

The `docs/process/i18n.md` recipe references `en.ts` as a single file and says the per-domain split is still pending. Flip those references to the completed structure.

**Files:**

- Modify: `docs/process/i18n.md`

**Interfaces:**

- Consumes: nothing (docs only).
- Produces: nothing (docs only).

- [ ] **Step 1: Update the "Authoring rules" catalog reference**

In `docs/process/i18n.md`, replace this bullet (currently near line 41):

```markdown
- The English source text is the key: `t("Save changes")`. Register every
  key in `apps/companion/src/i18n/locales/en.ts` (key === value,
  alphabetical). `src/i18n/locales/catalog.test.ts` enforces that every
  entry parses as ICU and avoids `'{`, `'}`, `''`.
```

with:

```markdown
- The English source text is the key: `t("Save changes")`. Register every
  key in the per-domain module it is used from, under
  `apps/companion/src/i18n/locales/en/` (`common.ts`, `trips.ts`, `map.ts`,
  …), merged by `locales/en/index.ts` (key === value, alphabetical within
  the module; shared keys go in `common.ts`).
  `src/i18n/locales/catalog.test.ts` enforces that every entry parses as ICU
  and avoids `'{`, `'}`, `''`, and `locales/en/duplicate-keys.test.ts`
  enforces that no key lives in two modules.
```

- [ ] **Step 2: Update the "Adding a language" translate step**

In `docs/process/i18n.md`, replace this step (currently near line 94):

```markdown
5. Translate: work through `en.ts` (and per-domain modules once the
   catalog is split) — plural messages must be rewritten with the target
   language's plural branches, not word-for-word.
```

with:

```markdown
5. Translate: work through the per-domain English modules under
   `apps/companion/src/i18n/locales/en/` — plural messages must be rewritten
   with the target language's plural branches, not word-for-word. A new
   locale may be a single `Partial<Record<EnglishMessageKey, string>>` file
   (`locales/<locale>.ts`) or mirror the English domain split; missing keys
   fall back to English either way.
```

- [ ] **Step 3: Verify the references are consistent**

```bash
grep -n "en\.ts" docs/process/i18n.md
```

Expected: no line describes `en.ts` as the single registration target (the Step 1 and Step 2 edits removed both). Any remaining `en.ts` mention must not claim it is where keys are registered.

- [ ] **Step 4: Commit**

```bash
npx prettier --write docs/process/i18n.md
git -c core.hooksPath=/dev/null -c core.fsmonitor=false add docs/process/i18n.md
git -c core.hooksPath=/dev/null -c core.fsmonitor=false commit -m "docs(companion): point add-a-language recipe at the split en catalog"
```

---

## Final validation (before opening the PR)

After all three tasks, run the full companion suite and typecheck from `apps/companion` (sandbox disabled for tsc):

```bash
rm -rf .next/dev/types
npx tsc --noEmit 2>&1 | grep -c "error TS"   # expect 0
npx vitest run                                 # expect all green
```

Then the e2e gate (per the epic's convention, e2e also runs in CI):

```bash
pnpm --filter @tarmoto/companion test:e2e     # expect green
```

English output is byte-identical, so no e2e or unit literal should need updating. If any test asserts a literal that changed, that is a regression to investigate — not a snapshot to bless.

## Self-Review

**Spec coverage (§4 + §8a):**

- "All wrapped-but-unregistered literals land in the `en` catalog" → Task 1 (compiler-as-oracle backfill to zero class-1 source errors).
- "`en.ts` splits into per-domain modules under `locales/en/` merged by an `index.ts`, with a duplicate-key unit test" → Task 2.
- "The flip / `tDynamic` / classes 2–3 / ESLint guard / server-locale default" → explicitly PR 3b, out of scope here (Global Constraints + §8a).
- "English byte-identical" → enforced by Global Constraints + Task 1 additive-only + Task 2 no-key-lost gate + final validation.
- "Docs recipe reflects the split" → Task 3 (§6 recipe references).

**Placeholder scan:** No `TBD`/`TODO`/"handle edge cases". Every script and edit is shown in full; the one open-ended quantity (how many literals harvest) is bounded and self-correcting via the iterate-to-zero gate (Task 1 Step 8).

**Type consistency:** The barrel's exports (`en`, `EnglishMessageKey`, `__catalogModules`) match what `locales/index.ts`, `catalog.test.ts`, and `duplicate-keys.test.ts` consume. `translate(key: string)` is unchanged (loose) in every committed state. The scaffold edit (`key: EnglishMessageKey`) is applied and reverted within Task 1 and never committed.
