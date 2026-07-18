# Companion i18n readiness — design

**Date:** 2026-07-17
**Status:** approved
**Scope:** `apps/companion`, `packages/shared` (translator core + leaking helpers), `docs/process/i18n.md`. Mobile and backend email _content_ untouched; backend email _engine_ upgrades transparently (see §1 gate).

## Problem

The app is English-only (fine for MVP), but adding a second UI language today would fail
structurally, not just lexically. Audit findings (2026-07-17, on `5bc40f56`):

- `en.ts` registers 897 keys, but ~1,200 distinct literals flow through `t()` — **~675
  wrapped strings are missing from the catalog**. They render via raw-key fallback, so a
  translator working from the catalog would silently miss ~40% of shipped UI text.
- **~300–450 user-facing strings bypass `t()` entirely**: ~150 trapped in pure lib
  functions (`gamification.ts` labels/countdowns, `subscription.ts` plan copy,
  `ride-compare.ts` STAT_DEFS, `passes-summary.ts` MONTH_NAMES, `closures-summary.ts`,
  `exploration.ts`, `auth-errors.ts`), ~80 DataTable/tile/legend/pill labels, all 59
  SEO/OG `generateMetadata` strings, validation messages, a few raw `toast.error`s, and
  aria/placeholder/alt/title props.
- **No pluralization**: `makeTranslator` does naive `{placeholder}` substitution; ~40
  sites use `"{s}"` / `count === 1 ? "" : "s"` hacks or enumerated branches
  (`formatDaysRemaining`, shared `formatJoinedLabel`) — structurally wrong for Czech
  (one/few/other), Polish, and German word order.
- **Stale docs/registry**: `docs/process/i18n.md`'s "add a language" recipe no longer
  compiles; the `LOCALES` registry actually lives in `packages/shared/src/i18n.ts` and
  couples companion locale additions to backend email.
- **English variant drift** (minor): the copy is de-facto British (~13:6) — "metres",
  "kilometres", "favourite", "colour-coded", "Petrol station" — with 7 US-variant
  strings across 4 files ("Center on me", two "Color the route line…" aria-labels,
  "Personalized recommendations", an orphaned "Arrow color" catalog entry) and the
  un-European "Highways"/"Avoid highways" router copy.

Goal: fill every gap so that shipping language N+1 is a _content_ task (write a catalog,
register a locale), not an engineering excavation — and make the gaps unable to reopen.

## Decisions (product/user-ratified)

1. **Pluralization via full ICU library** — `intl-messageformat` (FormatJS core) replaces
   the naive interpolation inside the shared `makeTranslator`. (User chose the library
   over a zero-dep `Intl.PluralRules` extension: buys `select`, nesting, and
   battle-tested plural handling.)
2. **Enforcement via typed `t()` keys** — after the backfill, companion's `t()` argument
   is the catalog-key union; an unregistered string is a compile error (tsc-as-oracle).
   One explicit `tDynamic(key: string)` escape hatch for genuinely dynamic keys.
3. **"Highways" → "Motorways"** in router copy (~5 strings + tests).
4. **British English is the standard** (audit-backed de-facto): the 7 US-variant strings
   conform; the orphaned "Arrow color" key is deleted.

## Design

### 1. Translator engine (`packages/shared/src/i18n.ts`)

`makeTranslator` keeps its exact public API — `t(key, values?, locale?)`, raw English
source text as key, lookup order active-locale → `en` → raw key — and swaps the
interpolation engine to `intl-messageformat`. Parsed `IntlMessageFormat` instances are
memoized per (message, locale) at module level (same pattern as the `Formatters` caches;
size-capped identically). Messages with no arguments skip parsing entirely (fast path —
the overwhelming majority of catalog entries).

Compatibility guards (all verified in the plan, not assumed):

- **Apostrophe escaping**: ICU treats `'` before `{`/`}` as quoting. A sweep of both
  catalogs (companion `en.ts`, backend email catalog) plus all inline `t()` literals
  must show no `'{`/`'}` sequences; prose apostrophes ("day's ride") are ICU-safe.
- **Numeric arguments**: ICU locale-formats numbers (grouping) where the old engine did
  `String(n)`. Sites that pass raw numbers are audited: where the old output is pinned
  (backend email snapshots) values are pre-stringified or the message is verified
  identical; elsewhere the ICU behavior is accepted as more correct.
- **Backend email byte-parity gate**: the 45 byte-identical email snapshot tests must
  pass UNCHANGED after the engine swap. This suite is the authoritative proof that email
  content is untouched.
- Bundle cost ~18 kB gzipped client-side; accepted.

### 2. Plural rewrite (~40 sites)

Every `"{s}"` hack, `=== 1 ? "" : "s"` ternary, and enumerated plural branch becomes an
ICU plural message, e.g.
`t("{count, plural, one {# Fun Zone} other {# Fun Zones}} on the way", { count })`.
Enumerated-time helpers (`formatDaysRemaining`'s days/weeks/months families) become
plural messages per unit. Pure-lib producers get a translator threaded as the LAST
parameter (the convention the `Formatters` migration established). Shared
`formatJoinedLabel` gains an **optional** translator/locale argument — omitted preserves
today's exact English output (mobile contract, same trick as `formatCount`).

### 3. Wrapping the raw surface (~300–450 strings)

- **Pure libs** (`gamification`, `subscription`, `ride-compare`, `passes-summary`,
  `closures-summary`, `exploration`, `auth-errors`): translator parameter threaded;
  label constants become functions of `t` (or the raw constant stays and the RENDER
  site wraps with `t(label)` where the existing `t(item.label)` pattern already works —
  choose per structure, favor the render-site wrap where the constant also serves
  non-UI purposes).
- **DataTable/tile/legend/pill labels**: wrapped at render (`t("DATE")`, `t("Distance")`
  …) and registered.
- **SEO/metadata (59 strings, 16 files)**: `generateMetadata` reads the request locale
  via the existing `readLocale()` and routes title/description/OG/imageAlt through
  `t()`. Static `metadata` exports that need locale become `generateMetadata`.
- **Validation strings, raw `toast.error`s, aria-label/placeholder/alt/title props**:
  wrapped.
- **Documented exception**: `app/global-error.tsx` stays hardcoded English with
  `<html lang="en">` — the i18n providers are dead when it renders. Recorded here; not
  a gap.

### 4. Catalog backfill, split, and the typed flip

- All ~675 wrapped-but-unregistered literals plus every newly wrapped string land in the
  `en` catalog. Final size ~1,600–1,800 keys.
- The single `en.ts` splits into per-domain modules under
  `apps/companion/src/i18n/locales/en/` (e.g. `rides.ts`, `trips.ts`, `community.ts`,
  `settings.ts`, `gamification.ts`, `common.ts`…) merged by an `index.ts` — with a
  duplicate-key unit test across modules.
- **The flip**: companion's `t()`/`translate()` signature narrows from `string` to the
  key union (`EnglishMessageKey`). `tDynamic(key: string, values?)` is the sole
  loose-typed entry point (implemented via the same translator; exists to be greppable).
  Dynamic-label maps (nav items, quality tiers, dimension labels) stay typed by
  declaring the maps' label values `as const satisfies EnglishMessageKey`-shaped so
  `t(item.label)` still compiles.
- Backend email's `translate()` keeps its current loose signature — its raw-key-fallback
  usage is deliberate and out of scope.

### 5. English normalization

Conform the 7 US-variant strings to British ("Centre on me", "Colour the route line…"
aria-labels, "Personalised recommendations" — the API identifier
`personalized_recommendations_consent` is untouched), delete the orphaned "Arrow color"
key, and rename "Highways"/"Avoid highways" → "Motorways"/"Avoid motorways" (copy +
catalog + tests; backend routing option identifiers untouched).

### 6. Registry + docs + add-a-language recipe

`docs/process/i18n.md` is rewritten to match reality: `LOCALES` registry in
`packages/shared/src/i18n.ts` (couples to backend email locale resolution), companion
catalogs in `apps/companion/src/i18n/locales/`, the typed-`t()` rule, the plural syntax,
and a checklist for adding a language:

1. Create `apps/companion/src/i18n/locales/<locale>/…` catalog modules
   (`Partial<TranslationCatalog>` — missing keys fall back to English).
2. Register the catalog in `companionCatalogs`.
3. Add the locale to `LOCALES` in `packages/shared` (label included) — this
   auto-unhides the settings LocaleSwitcher, activates `<html lang>`, the
   `/api/locale` bridge, `users.language` validation, AND backend email locale
   resolution for that locale (email catalogs fall back to English until provided).
4. Run the pseudo-translation test suite (below).

A **test-only Czech-shaped catalog** (one/few/other plurals, diacritics, longer strings)
is injected directly into `makeTranslator` in unit tests to prove the machinery — it is
NEVER registered in `LOCALES`, so the production switcher stays hidden until a real
language ships.

### 7. Testing

- Engine: `intl-messageformat` behavior unit tests (plural one/few/other with the
  Czech-shaped test catalog, select, apostrophe handling, numeric-arg formatting,
  memoization); **email snapshot suite byte-identical** (the gate).
- Plural rewrite: per-site assertions for count = 1 / 2 / 5 in English.
- Metadata: a test that `generateMetadata` output follows the locale cookie.
- Typed flip: compilation IS the test; plus a unit test that `tDynamic` falls back to
  the raw key.
- Catalog: duplicate-key test across the split modules; a completeness test asserting
  every `LOCALES` locale has a registered catalog.
- Companion full suite + e2e must stay green (English output should be byte-identical
  except the ~12 normalized/Motorways/plural-copy strings — those are the ONLY intended
  visible changes; each gets its test literal updated deliberately).

### 8. Delivery phasing

- **PR 1 — engine + language mechanics**: ICU swap in `makeTranslator` (+ memoization,
  guards, email byte-parity), plural rewrite of all ~40 sites (incl. shared
  `formatJoinedLabel` optional-translator), EN normalization + Motorways, registry/docs
  rewrite, Czech-shaped test catalog.
- **PR 2 — raw-surface wrapping**: lib translator threading, table/tile/legend/pill
  labels, SEO metadata, validation/toasts/props. Output-identical (English) except where
  PR 1 already changed copy.
- **PR 3 — catalog completion + enforcement**: backfill all missing keys, split `en.ts`
  into per-domain modules, flip `t()` to typed keys + `tDynamic`, fix everything the
  compiler then finds. After this PR, an unregistered UI string cannot compile.

### 8a. PR 3 execution addendum (post-PR 2, ratified 2026-07-18)

PR 2 (#1035) registered only the strings it _wrapped_, so the pre-existing legacy
raw-key-fallback surface remains. Measured current state: `en.ts` = 1,271 keys / 1,523
lines. A one-shot **typed-flip experiment** (temporarily narrow `translate` to
`EnglishMessageKey`, run `tsc`) is the definitive worklist: **922 errors across 58 files
(839 src + 83 test)**, in three fallout classes —

1. **Unregistered literals → register** (the bulk, ~800). `TS2345` quotes the exact
   missing literal, so the backfill is a compiler-driven loop (narrow → collect literals
   → add key===value alphabetically, `\uXXXX`-escaped → repeat to zero), not a manual hunt.
2. **Dynamic string keys → `tDynamic`** (handful). `t(challenge.unit)`,
   `t(SURFACE_LABELS[key])`, `t(role)` — runtime key, not a literal.
3. **Narrowed `t` not assignable to `LooseTranslate`** (few files). Companion-owned pure
   libs adopt a companion-local typed `Translate` type (so their internal literal calls
   are checked too); the shared `formatJoinedLabel` (mobile/backend consumers) keeps
   `LooseTranslate` and receives `tDynamic` at the companion call site.

**PR 3 ships as two PRs** to keep each review tractable — a ~800-key additive diff is
eyeball-reviewable as "all key===value English"; the signature flip is small and
high-signal once the backfill is done:

- **PR 3a — catalog completion + `en.ts` split.** Register the ~800 unregistered literals
  and split `en.ts` into per-domain modules under `apps/companion/src/i18n/locales/en/`
  (barrel `index.ts` + cross-module duplicate-key test). Loose `translate(key: string)`
  signature is **unchanged**; English output byte-identical; purely additive.
- **PR 3b — typed enforcement.** Flip `translate()`/`t()` to `EnglishMessageKey`, add
  `tDynamic`, resolve classes 2–3, fix the 83 test-file keys. Plus two enforcement
  additions beyond the original §4 scope (ratified):
  - **ESLint guard** banning raw string literals on `label`/`title`/`aria-*`-class props
    of shared UI components — the structural complement to the flip, which cannot catch
    strings that never reach `t()` (PR 2's whole-branch review found 106 such bypass
    strings). Scoped to the shared `@tarmoto/ui` render props + companion label/title/aria
    JSX attributes.
  - **Server-locale default**: server-side `t()` defaults its locale to
    `getServerLocale()` so every awaiting server component is request-locale-safe, not
    just the 4 public-share pages already patched in PR 2 — closes the module-global
    `activeLocale` Suspense race app-wide. Client components stay on the
    `I18nProvider`-set `activeLocale` (per-render, exempt).

## Out of scope

- Shipping an actual second language (content/product decision — which language, who
  translates; same gate as email i18n Phase 3).
- Mobile app copy; backend email content/catalogs (engine upgrade only, proven inert).
- Locale-seeded unit defaults (separate product decision noted in the formatting epic).

## Risks

- **ICU semantics vs pinned output**: apostrophe quoting and numeric formatting are the
  two real hazards; both have explicit sweeps + the email byte-parity gate.
- **Typed-flip fallout**: narrowing `t()` will surface every remaining stray at compile
  time — that is the point, but PR 3's size depends on PR 1/2 completeness; the plan
  orders it last deliberately.
- **Catalog-size churn in review**: PR 3 is large but mechanical; per-domain split keeps
  modules reviewable.
- **Copy changes visible to users**: limited to the normalization/Motorways/plural-copy
  set (~12 strings), enumerated in the PR body.
