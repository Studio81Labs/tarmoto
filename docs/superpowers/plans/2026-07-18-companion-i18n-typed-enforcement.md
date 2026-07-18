# Companion i18n Typed Enforcement (PR 3b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Narrow the companion translator from `translate(key: string)` to `translate(key: EnglishMessageKey)` so an unregistered UI string becomes a **compile error**, with a `tDynamic(key: string)` escape hatch for genuinely dynamic keys — plus an ESLint guard for strings that never reach `t()` and a request-safe server translator.

**Architecture:** The narrowing surfaces 188 `TS2345` errors (measured). They're pre-resolved in dependency order while the loose signature stays in place — each task's committed state is `tsc`-green, using a throwaway signature-narrowing _scaffold_ as a burn-down oracle (the same technique PR 3a used for the backfill). The actual narrowing happens **last** (Task 4), turning enforcement on only once every site is fixed. Then two enforcement additions: an ESLint guard on raw `label`/`title`/`aria-*` JSX props (catches bypass strings the compiler can't, because they never reach `t()`), and a server-bound `t` that defaults its locale to `getServerLocale()` (request-safe under concurrent SSR).

**Tech Stack:** TypeScript (strict), `intl-messageformat`, Vitest, ESLint 10 flat config (`typescript-eslint`), Next.js, pnpm.

## Global Constraints

- **English output is byte-identical.** This PR changes types and adds an escape hatch / guard — it must not change a single rendered string. The full companion suite + Playwright e2e stay green with no test-literal edits (except registering one missing test key and any `tDynamic`/import swaps).
- **`tDynamic(key: string)` is the ONLY loose-typed entry point** after the flip. It exists to be greppable — every genuinely dynamic key goes through it. Prefer typing a label/config map (`as const satisfies` / `EnglishMessageKey`-valued) over `tDynamic` whenever the key comes from a fixed map.
- **The shared `formatJoinedLabel` (`packages/shared/src/rider-format.ts`) keeps `LooseTranslate`** — mobile and backend consume it. Companion callers pass `tDynamic`, never the narrowed `t`.
- **Each task's committed state is `tsc`-clean with the loose signature still in place.** Only Task 4 narrows the signature. Tasks 2–3 verify progress with a throwaway scaffold that is applied, measured, and reverted — never committed.
- **`EnglishMessageKey`** is the union `keyof typeof en` exported from `apps/companion/src/i18n/locales/en/index.ts` (1903 keys, from PR 3a).

### Environmental gotchas (this repo/environment)

- Git hooks wedge. Commit with `git -c core.hooksPath=/dev/null -c core.fsmonitor=false commit`; run `npx prettier --write <files>` manually before committing.
- The sandbox SIGKILLs long `tsc` runs. Run `npx tsc --noEmit` with the Bash tool's `dangerouslyDisableSandbox: true`.
- `pnpm test` does NOT filter — run one file with `npx vitest run <path>` from `apps/companion`.
- `rm -rf apps/companion/.next/dev/types` before every `tsc --noEmit`.
- If `main` is merged mid-branch, rebuild shared: `pnpm --filter @tarmoto/shared build`.

### Key facts (measured on branch `feat/i18n-typed-enforcement` @ main 8a0805c0)

- **Scaffold** = edit `apps/companion/src/i18n/index.ts:53` `  key: string,` → `  key: EnglishMessageKey,`, run `tsc`, then revert. Current translator (index.ts:52-60):
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
- Under the scaffold: **188 `TS2345` errors / 33 files**, all class-2/class-3 (class-1 was backfilled by PR 3a):
  - **class-1** (`Argument of type '"..."'`): src **0**, test **1** (one unregistered literal in a `*.test` file → register it).
  - **class-2** (`Argument of type 'string'` — dynamic key): **79, all src**, ~20 files. Fix by typing the backing label/config map to `EnglishMessageKey`-valued so `t(map[x])` stays typed; `tDynamic` only where the key is genuinely runtime-computed.
  - **class-3** (narrowed `t` not assignable to `LooseTranslate`): **108** (26 src + 82 test), collapsing to **~26 params across 9 companion lib files**. Fix by retyping those params `LooseTranslate` → the companion `Translate` type; the fix cascades to every call site.
- `getServerLocale()` (`apps/companion/src/i18n/server.ts`) returns the per-request `cache()` ref — request-safe under concurrent SSR, unlike the module-global `activeLocale` that `translate` defaults to.

## File Structure

- `apps/companion/src/i18n/index.ts` — add `tDynamic` + export the `Translate` type (T1); narrow `translate` (T4).
- `apps/companion/src/i18n/server.ts` — add a server-bound `t`/`translate` defaulting locale to `getServerLocale()` (T6).
- `apps/companion/src/lib/utils.ts` + the label/config maps — retype label values to `EnglishMessageKey` (T2).
- The 9 lib files (`subscription.ts`, `gamification.ts`, `closures-summary.ts`, `route-collections.ts`, `ride-compare.ts`, `auth-errors.ts`, `bikes.ts`, `trip-folders.ts`, `components/PassesPanel.tsx`) — retype translator params (T3).
- `apps/companion/eslint.config.mjs` — add the raw-label/title/aria selector (T5).
- `docs/process/i18n.md` — document `tDynamic`, the typed rule, and the server translator (folded into T4/T6).

---

### Task 1: Foundation — `tDynamic` + the companion `Translate` type

**Files:**

- Modify: `apps/companion/src/i18n/index.ts`
- Test: `apps/companion/src/i18n/index.test.ts`

**Interfaces:**

- Produces: `export type Translate = (key: EnglishMessageKey, values?: TranslationValues, locale?: SupportedLocale) => string;` and `export function tDynamic(key: string, values?: TranslationValues, locale?: SupportedLocale): string` — both from `@/i18n`. `translate`/`t` stay loose (`key: string`) in this task.

- [ ] **Step 1: Write the failing test**

Add to `apps/companion/src/i18n/index.test.ts` (create if absent; if it exists, append inside the top-level `describe` or add a new one):

```ts
import { tDynamic } from "./index";

describe("tDynamic", () => {
  it("falls back to the raw key for an unregistered string", () => {
    expect(tDynamic("this key is not registered")).toBe(
      "this key is not registered",
    );
  });
  it("resolves and interpolates a registered key", () => {
    // "Level {level} · {xp} XP" is a registered catalog key.
    expect(tDynamic("Level {level} · {xp} XP", { level: 3, xp: 120 })).toBe(
      "Level 3 · 120 XP",
    );
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npx vitest run src/i18n/index.test.ts
```

Expected: FAIL — `tDynamic` is not exported yet.

- [ ] **Step 3: Add `tDynamic` and the `Translate` type**

In `apps/companion/src/i18n/index.ts`, after the `translate`/`t` block (after line 60), add:

```ts
/**
 * Typed companion translator: the key must be a registered catalog key.
 * PR 3b narrows `translate`/`t` to this; libs that receive a translator
 * declare their parameter as `Translate`.
 */
export type Translate = (
  key: EnglishMessageKey,
  values?: TranslationValues,
  locale?: SupportedLocale,
) => string;

/**
 * Escape hatch for genuinely dynamic keys (a runtime string that cannot be a
 * compile-time literal). Deliberately loose and greppable — reach for a typed
 * label map before reaching for this. Same lookup + raw-key fallback as `t`.
 */
export function tDynamic(
  key: string,
  values?: TranslationValues,
  locale: SupportedLocale = activeLocale,
): string {
  return baseTranslate(key as EnglishMessageKey, values, locale);
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
npx vitest run src/i18n/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck (still loose, must be clean)**

```bash
rm -rf .next/dev/types && npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Expected: `0` (additive change; `translate` is untouched).

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/i18n/index.ts src/i18n/index.test.ts
git -c core.hooksPath=/dev/null -c core.fsmonitor=false add src/i18n/index.ts src/i18n/index.test.ts
git -c core.hooksPath=/dev/null -c core.fsmonitor=false commit -m "feat(companion): add tDynamic escape hatch + typed Translate type for i18n"
```

---

### Task 2: Type the class-2 label/config maps (+ `tDynamic` for genuinely dynamic sites)

Resolve the 79 class-2 (`Argument of type 'string'`) sites so that, under the scaffold, class-1 + class-2 errors reach **0** — while the committed signature stays loose. Preferred fix: type the backing map's label values to `EnglishMessageKey`; `tDynamic` only for keys with no fixed map.

**Files (representative — the scaffold enumerates the exact set):**

- Modify: `apps/companion/src/lib/utils.ts` (`SURFACE_LABELS`, `QUALITY_CONFIG.label`, `HAZARD_CONFIG.label`), `apps/companion/src/lib/planner/*` (quality-band label maps), and the ~20 class-2 component files.
- Modify: the one `*.test` file with the class-1 literal (register its key in the catalog).

**Interfaces:**

- Consumes: `EnglishMessageKey` (type), `tDynamic` (from Task 1), both from `@/i18n`.
- Produces: label/config maps whose label values are typed `EnglishMessageKey` — so `t(MAP[x])` is typed in Task 4.

- [ ] **Step 1: Apply the scaffold and capture the class-2 worklist**

Edit `apps/companion/src/i18n/index.ts:53` `  key: string,` → `  key: EnglishMessageKey,`. Then (sandbox disabled):

```bash
rm -rf .next/dev/types
npx tsc --noEmit 2>&1 | grep "Argument of type 'string'" | grep -vE "\.(test|spec)\.tsx?\(|(__tests__|e2e)/" > /tmp/class2.txt
wc -l /tmp/class2.txt
```

Expected: 79 lines. Each names a `file(line,col)` where `t(<dynamic>)` is called.

- [ ] **Step 2: Type the shared label maps in `lib/utils.ts`**

The label values are already registered catalog keys; narrow their declared type from `string` to `EnglishMessageKey` so `t(map[x])` type-checks. `EnglishMessageKey` is a subtype of `string`, so every existing non-`t` consumer still compiles.

In `apps/companion/src/lib/utils.ts`:

- Add `EnglishMessageKey` to the existing `@/i18n` import (or add `import type { EnglishMessageKey } from "@/i18n";`).
- `export const SURFACE_LABELS: Record<SurfaceType, string>` → `Record<SurfaceType, EnglishMessageKey>`.
- In `QUALITY_CONFIG`'s value type `{ label: string; color: string; bg: string; hex: string }` → `{ label: EnglishMessageKey; color: string; bg: string; hex: string }`.
- In `HAZARD_CONFIG`'s value type `{ label: string; emoji: string; hex: string }` → `{ label: EnglishMessageKey; emoji: string; hex: string }`.

If TypeScript reports a value in any of these maps is not a registered key, that string was never backfilled — register it in the appropriate `locales/en/*.ts` module (key===value, alphabetical) rather than widening the type back to `string`.

- [ ] **Step 3: Type the remaining backing maps, or use `tDynamic`**

Work through `/tmp/class2.txt`. For each site:

- **Key from a fixed map** (e.g. planner quality-band labels, condition labels, nav items, quality tiers): give that map's label values the `EnglishMessageKey` type the same way (annotate `Record<K, EnglishMessageKey>`, or append `satisfies Record<K, EnglishMessageKey>` to an `as const` map). Then `t(map[x])` type-checks.
- **Genuinely runtime key** (assembled at runtime, or from API data with no fixed key set): replace `t(expr)` with `tDynamic(expr)` (import `tDynamic` from `@/i18n`). This is the deliberate, greppable bypass.

Prefer the typed-map route; use `tDynamic` only when there is no fixed key set.

- [ ] **Step 4: Register the one class-1 test key**

```bash
npx tsc --noEmit 2>&1 | grep "Argument of type '\"" | grep -E "\.(test|spec)\.tsx?\(|(__tests__|e2e)/"
```

This prints the one `file(line): ... Argument of type '"<literal>"'`. Register `"<literal>"` in the correct `locales/en/*.ts` module (key===value, alphabetical, `\uXXXX`-escape non-ASCII). (If the literal is a test-only synthetic key rather than real UI copy, change the test to call `tDynamic("<literal>")` instead — but a real UI string should be registered.)

- [ ] **Step 5: Verify class-1 + class-2 are clear under the scaffold**

```bash
rm -rf .next/dev/types
npx tsc --noEmit 2>&1 | grep -E "Argument of type '(\"|string')" | grep -c "error TS2345"
```

Expected: `0` (only class-3 `LooseTranslate` errors remain — those are Task 3).

- [ ] **Step 6: Revert the scaffold; committed state must be loose + green**

Revert `index.ts:53` to `  key: string,` (`git checkout src/i18n/index.ts` restores it, or edit back). Then:

```bash
rm -rf .next/dev/types && npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Expected: `0`. Typing the maps is compatible with the loose signature (`EnglishMessageKey` ⊂ `string`), and `tDynamic` takes `string`.

- [ ] **Step 7: Run the touched-area tests**

```bash
npx vitest run src/lib src/components/map
```

Expected: PASS. English output is unchanged (a label's runtime string value is identical; only its static type narrowed).

- [ ] **Step 8: Commit**

```bash
npx prettier --write $(git diff --name-only | grep -E '\.(ts|tsx)$' | tr '\n' ' ')
git -c core.hooksPath=/dev/null -c core.fsmonitor=false add -A
git -c core.hooksPath=/dev/null -c core.fsmonitor=false status --short   # confirm index.ts is NOT staged with the scaffold
git -c core.hooksPath=/dev/null -c core.fsmonitor=false commit -m "refactor(companion): type i18n label maps to EnglishMessageKey; tDynamic for runtime keys"
```

Confirm `git status` shows `src/i18n/index.ts` with only the Task-1 changes (no scaffold `EnglishMessageKey` on line 53).

---

### Task 3: Retype the pure-lib translator params `LooseTranslate` → `Translate`

Resolve the 108 class-3 errors by retyping ~26 companion-owned lib params. Because the caller passes a translator and TypeScript function params are contravariant, retyping the param to the (narrower-key) `Translate` accepts both the loose `t` (today) and the narrowed `t` (after Task 4); test mocks `(k: string) => k` also stay assignable. The maps those libs read internally are already typed (Task 2), so internal `t(MAP[x])` calls compile.

**Files:**

- Modify: `apps/companion/src/lib/subscription.ts` (params at lines ~76,153,199,208,219,243,253,272,282,348,393,411,436), `gamification.ts` (247,284,663,712), `closures-summary.ts` (103,141), `route-collections.ts` (66,86), `ride-compare.ts` (149), `auth-errors.ts` (16), `bikes.ts` (44), `trip-folders.ts` (59), `components/PassesPanel.tsx` (470).

**Interfaces:**

- Consumes: `Translate` (Task 1) and `tDynamic` (Task 1) from `@/i18n`.
- Produces: lib functions whose translator parameter is `Translate`. The shared `formatJoinedLabel` (`@tarmoto/shared`) is unchanged; companion callers pass `tDynamic`.

- [ ] **Step 1: Apply the scaffold and capture the class-3 worklist**

Re-apply the scaffold (`index.ts:53` → `EnglishMessageKey`). Then (sandbox disabled):

```bash
rm -rf .next/dev/types
npx tsc --noEmit 2>&1 | grep "LooseTranslate" > /tmp/class3.txt
wc -l /tmp/class3.txt
```

- [ ] **Step 2: Retype each lib param `LooseTranslate` → `Translate`**

In each of the 9 files: replace `import type { LooseTranslate } from "@tarmoto/shared"` (and the mixed imports, e.g. `import type { Formatters, LooseTranslate } from "@tarmoto/shared"`) so `LooseTranslate` is dropped and `Translate` is imported from `@/i18n` (`import type { Translate } from "@/i18n"`). Change every `t: LooseTranslate` parameter to `t: Translate`. (In `subscription.ts` this is ~13 params including `tierLabel(tier, t: LooseTranslate)` and `titleCase(value, t: LooseTranslate)`.)

- [ ] **Step 3: Fix any internal dynamic / shared-helper calls the retype surfaces**

After retyping, a lib's own `t(<non-literal>)` call may now fail (the param is typed). Resolve each:

- If the value comes from a map, that map is typed (Task 2) → already compiles.
- If a lib passes its `t` into the **shared** `formatJoinedLabel(parts, t)`, that parameter is `LooseTranslate`; the narrowed `Translate` is not assignable to it. Pass `tDynamic` there instead (import `tDynamic` from `@/i18n`) — `formatJoinedLabel` builds its keys from data, so the dynamic path is correct.
- If a lib genuinely computes a key at runtime and must honour the caller's threaded locale, call `t(key as EnglishMessageKey)` with a short comment — this is the deliberate dynamic bypass that preserves the threaded locale (the imported `tDynamic` would use the module-global `activeLocale` instead).

- [ ] **Step 4: Verify class-3 is clear and the scaffold total is 0**

```bash
rm -rf .next/dev/types
npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Expected: `0` — with the scaffold applied, the whole workspace now typechecks. This is the completeness proof Task 4 relies on. If any error remains, it is a missed class-2/class-3 site — fix it here.

- [ ] **Step 5: Revert the scaffold; committed state loose + green**

Revert `index.ts:53` to `  key: string,`. Then:

```bash
rm -rf .next/dev/types && npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Expected: `0`.

- [ ] **Step 6: Run the lib tests (the class-3 test call sites)**

```bash
npx vitest run src/lib/__tests__/subscription.test.ts src/lib/__tests__/gamification.test.ts src/lib/__tests__/bikes.test.ts src/lib/__tests__/route-collections.test.ts src/lib/__tests__/closures-summary.test.ts src/lib/__tests__/trip-folders.test.ts src/lib/__tests__/auth-errors.test.ts src/lib/__tests__/ride-compare.test.ts
```

Expected: PASS (mocks `(k: string) => k` remain assignable to `Translate`; behavior unchanged).

- [ ] **Step 7: Commit**

```bash
npx prettier --write $(git diff --name-only | grep -E '\.(ts|tsx)$' | tr '\n' ' ')
git -c core.hooksPath=/dev/null -c core.fsmonitor=false add -A
git -c core.hooksPath=/dev/null -c core.fsmonitor=false status --short   # index.ts must NOT carry the scaffold
git -c core.hooksPath=/dev/null -c core.fsmonitor=false commit -m "refactor(companion): retype pure-lib translator params to typed Translate"
```

---

### Task 4: The flip — narrow `translate`/`t` to `EnglishMessageKey`

Make the narrowing permanent. After Tasks 2–3 the scaffold total is 0, so this compiles clean — and from now on an unregistered UI string cannot compile.

**Files:**

- Modify: `apps/companion/src/i18n/index.ts`
- Modify: `docs/process/i18n.md` (the typed-`t()` rule + `tDynamic`)

**Interfaces:**

- Produces: `translate`/`t` with signature `(key: EnglishMessageKey, values?, locale?) => string` — matching the `Translate` type from Task 1.

- [ ] **Step 1: Narrow the signature**

In `apps/companion/src/i18n/index.ts`, change the `translate` function so it matches `Translate`:

```ts
export function translate(
  key: EnglishMessageKey,
  values?: TranslationValues,
  locale: SupportedLocale = activeLocale,
): string {
  return baseTranslate(key, values, locale);
}
export const t = translate;
```

(The `as EnglishMessageKey` cast is now redundant — `key` is already `EnglishMessageKey`; drop it. `tDynamic` keeps its cast.)

- [ ] **Step 2: Typecheck — enforcement is now live**

```bash
rm -rf .next/dev/types && npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Expected: `0`. If nonzero, a class-2/class-3 site was missed in Tasks 2–3 — fix it (type its map, or `tDynamic`) here.

- [ ] **Step 3: Full suite + build sanity**

```bash
npx vitest run 2>&1 | tail -5
```

Expected: all green (English output unchanged).

- [ ] **Step 4: Update the docs**

In `docs/process/i18n.md`, under "Authoring rules (companion)", add a bullet after the key-registration bullet:

```markdown
- `t()` / `translate()` take a **registered catalog key** (`EnglishMessageKey`);
  an unregistered string is a compile error. For a genuinely dynamic key (a
  runtime string with no fixed key set), use `tDynamic(key)` from `@/i18n` —
  it is the single loose-typed, greppable escape hatch. Prefer typing a label
  map (`Record<K, EnglishMessageKey>` / `satisfies`) over `tDynamic`.
```

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/i18n/index.ts ../../docs/process/i18n.md
git -c core.hooksPath=/dev/null -c core.fsmonitor=false add src/i18n/index.ts ../../docs/process/i18n.md
git -c core.hooksPath=/dev/null -c core.fsmonitor=false commit -m "feat(companion): narrow t() to typed EnglishMessageKey keys (enforcement)"
```

---

### Task 5: ESLint guard — ban raw string literals on label/title/aria JSX props

The typed flip constrains `t()` arguments; it cannot catch a string that never reaches `t()` (`label="Foo"`, `aria-label={"Foo"}`). This guard flags those in companion src, with a disable-comment escape for deliberate cases — mirroring the existing native-form-control guard.

**Files:**

- Modify: `apps/companion/eslint.config.mjs`

**Interfaces:**

- Consumes/Produces: nothing at the type level; adds a `no-restricted-syntax` selector.

- [ ] **Step 1: Add the selector to the shared array**

In `apps/companion/eslint.config.mjs`, append to the `restrictedSyntaxSelectors` array (so BOTH `no-restricted-syntax` blocks pick it up — flat config lets the later block win outright, and both re-spread this array):

```js
  // i18n bypass guard (PR 3b): user-facing text on these JSX props must go
  // through t()/tDynamic, not a raw string literal — the typed t() flip
  // cannot catch a string that never reaches t(). Flags a string literal
  // (direct or in braces) that starts with a letter, so symbols, empty
  // alt="", and interpolated/`t(...)` values pass. Deliberate raw text
  // (a brand name, a non-translatable token) carries a disable comment.
  {
    selector:
      "JSXAttribute[name.name=/^(label|title|alt|placeholder|aria-label)$/] > Literal[value=/^[A-Za-z]/]",
    message:
      "Wrap user-facing text on label/title/alt/placeholder/aria-label with t() (or tDynamic for a runtime key). If this literal is deliberately not translatable, add a disable comment with the reason.",
  },
  {
    selector:
      "JSXAttribute[name.name=/^(label|title|alt|placeholder|aria-label)$/] > JSXExpressionContainer > Literal[value=/^[A-Za-z]/]",
    message:
      "Wrap user-facing text on label/title/alt/placeholder/aria-label with t() (or tDynamic for a runtime key). If this literal is deliberately not translatable, add a disable comment with the reason.",
  },
```

- [ ] **Step 2: Run the guard against the codebase**

```bash
npx eslint "src/**/*.{ts,tsx}" 2>&1 | tail -30
```

Expected: either clean, or a small number of violations. For each violation: if it is user-facing text PR 2 missed, wrap it (`label={t("Foo")}`) and register the key; if it is deliberately raw (brand token, non-text value the `/^[A-Za-z]/` filter didn't exclude), add `// eslint-disable-next-line no-restricted-syntax -- <reason>` above it. The guard must end clean.

- [ ] **Step 3: Prove the guard actually fires (planted violation)**

```bash
printf 'export const X = () => <div label="Planted Violation" />;\n' > src/__eslint_probe__.tsx
npx eslint src/__eslint_probe__.tsx 2>&1 | grep -c "no-restricted-syntax"
rm src/__eslint_probe__.tsx
```

Expected: a nonzero count (the rule fired on the planted `label="Planted Violation"`), then the probe file is removed.

- [ ] **Step 4: Confirm the whole lint run is clean**

```bash
npx eslint "src/**/*.{ts,tsx}" 2>&1 | tail -3 && echo "exit: $?"
```

Expected: no errors (exit 0). (Pre-existing warnings are acceptable; there must be no new errors.)

- [ ] **Step 5: Commit**

```bash
npx prettier --write eslint.config.mjs
git -c core.hooksPath=/dev/null -c core.fsmonitor=false add -A
git -c core.hooksPath=/dev/null -c core.fsmonitor=false commit -m "feat(companion): eslint guard banning raw text on label/title/aria props"
```

Note (scope): this guard covers JSX-attribute bypasses (the common case). Raw text in object-literal config (`{ label: "Foo" }` column defs) is not covered by an AST selector without false positives — those are handled by the typed flip when the config's `label` field is typed `EnglishMessageKey`. Recorded, not a gap for this task.

---

### Task 6: Request-safe server translator (default locale to `getServerLocale()`)

A server component that `await`s before its `t()` calls can read a stale module-global `activeLocale` (a concurrent request stomps it at a Suspense boundary). Provide a server-bound `t` that defaults its locale to the per-request `getServerLocale()`, and route the known awaiting-server-components through it. `index.ts` stays isomorphic (cannot import `next/headers`), so the server binding lives in `server.ts`.

**Files:**

- Modify: `apps/companion/src/i18n/server.ts`
- Modify: the 4 public-share pages (`app/rides/shared/[token]/page.tsx`, `app/trips/shared/[token]/page.tsx`, `app/road-map/shared/[token]/page.tsx`, `app/collections/shared/[token]/page.tsx`) + any other awaiting server component found in Step 3.
- Modify: `docs/process/i18n.md`

**Interfaces:**

- Consumes: `translate` + `Translate` from `@/i18n`, `getServerLocale` (already in `server.ts`).
- Produces: `export const t: Translate` and `export const translate: Translate` from `@/i18n/server` — locale defaults to `getServerLocale()`.

- [ ] **Step 1: Add the server-bound translator to `server.ts`**

In `apps/companion/src/i18n/server.ts`, add (after `getServerLocale`):

```ts
import { translate as isomorphicTranslate, type Translate } from ".";

/**
 * Server-bound translator: defaults the locale to `getServerLocale()` (the
 * per-request `cache()` ref), so an awaiting server component is request-safe
 * without threading `locale` by hand. Import `t` from `@/i18n/server` (not
 * `@/i18n`) in server components that render text after an `await`.
 */
export const t: Translate = (key, values, locale) =>
  isomorphicTranslate(key, values, locale ?? getServerLocale());
export const translate = t;
```

(Add `type Translate` to the existing import from `"."` in `server.ts`.)

- [ ] **Step 2: Migrate the 4 public-share pages**

Each currently imports `t` from `@/i18n` and threads `getServerLocale()` as the explicit 3rd argument to every body `t()` call (PR 2). Change the import to `import { t } from "@/i18n/server";`, drop the local `const locale = getServerLocale()` and the explicit 3rd arg on the body calls (the server `t` now defaults it). Leave `generateMetadata` as-is if it already resolves locale via `readLocale()`.

- [ ] **Step 3: Sweep for other awaiting server components importing `t` from `@/i18n`**

```bash
grep -rL "\"use client\"" src/app --include='*.tsx' | xargs grep -l "from \"@/i18n\"" 2>/dev/null | xargs grep -l "await " 2>/dev/null
```

For each hit that renders text with `t()` after an `await`, switch its import to `@/i18n/server`. (A file that only uses `t` before any `await`, or is a client component, does not need the change.)

- [ ] **Step 4: Typecheck + tests**

```bash
rm -rf .next/dev/types && npx tsc --noEmit 2>&1 | grep -c "error TS"
npx vitest run src/app 2>&1 | tail -5
```

Expected: `0` tsc errors; tests green.

- [ ] **Step 5: Document the convention**

In `docs/process/i18n.md`, under "Server vs. client translation", add:

```markdown
- Server components that render text after an `await` import `t` from
  `@/i18n/server` (not `@/i18n`) — it defaults the locale to
  `getServerLocale()`, the per-request ref, so a concurrent request cannot
  stomp the locale at a Suspense boundary. Client components keep importing
  from `@/i18n` (`I18nProvider` sets the active locale per render).
```

- [ ] **Step 6: Commit**

```bash
npx prettier --write $(git diff --name-only | grep -E '\.(ts|tsx|md)$' | tr '\n' ' ')
git -c core.hooksPath=/dev/null -c core.fsmonitor=false add -A
git -c core.hooksPath=/dev/null -c core.fsmonitor=false commit -m "feat(companion): request-safe server translator defaulting to getServerLocale"
```

---

## Final validation (before opening the PR)

From `apps/companion` (sandbox disabled for tsc):

```bash
rm -rf .next/dev/types
npx tsc --noEmit 2>&1 | grep -c "error TS"          # expect 0 — enforcement live
npx eslint "src/**/*.{ts,tsx}" 2>&1 | tail -3        # expect no errors
npx vitest run 2>&1 | tail -5                         # expect all green
pnpm --filter @tarmoto/companion test:e2e            # expect green
```

Enforcement proof: re-applying the scaffold is now a no-op (the committed signature already IS `EnglishMessageKey`). English output is byte-identical; no e2e/unit literal should need updating.

## Self-Review

**Spec coverage (§4 + §8a):**

- "flip `t()`/`translate()` to typed `EnglishMessageKey`" → Task 4 (after Tasks 2–3 clear the fallout).
- "`tDynamic(key: string)` escape hatch" → Task 1.
- "Dynamic-label maps stay typed via `EnglishMessageKey`" → Task 2.
- "companion-owned libs adopt a companion typed `Translate`; shared `formatJoinedLabel` keeps `LooseTranslate` + gets `tDynamic`" → Tasks 1 + 3.
- "fix the ~83 test-file keys" → Task 2 (1 class-1 key) + Task 3 (82 class-3 via cascade).
- "ESLint guard on raw label/title props of shared UI" → Task 5.
- "default server-side `t()` to `getServerLocale()`" → Task 6.
- "English byte-identical" → Global Constraints + no-literal-change tasks + final validation.

**Placeholder scan:** No `TBD`/"handle edge cases". The two bulk tasks (2, 3) are compiler-driven (the scaffold enumerates the exact sites, the burn-down-to-0 gate proves completeness) rather than pre-listing all 79/108 sites — the same technique PR 3a used and its reviews accepted.

**Type consistency:** `Translate = (key: EnglishMessageKey, values?: TranslationValues, locale?: SupportedLocale) => string` is defined in Task 1 and consumed unchanged in Tasks 3, 4, 6. `translate` narrows to exactly this signature in Task 4. `tDynamic(key: string, …)` is the loose counterpart throughout. Every task's committed state keeps the loose signature until Task 4; the scaffold is never committed.
