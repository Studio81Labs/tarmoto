# Companion i18n Engine + Plurals + EN Normalization (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap the shared `makeTranslator` interpolation engine to ICU (`intl-messageformat`), rewrite all ~40 plural-hack sites into ICU plural messages, normalize the 7 US-variant strings + Highways→Motorways, and rewrite the stale i18n docs — PR 1 of the i18n-readiness spec (`docs/superpowers/specs/2026-07-17-companion-i18n-readiness-design.md`).

**Architecture:** `makeTranslator` in `packages/shared/src/i18n.ts` keeps its exact public API and lookup order; only interpolation changes (memoized `IntlMessageFormat`, no-values fast path, legacy-interpolation fallback on parse/format errors). Companion plural sites move from `"{s}"` hacks and word-ternaries to single ICU messages registered in `en.ts`. Backend email is engine-only: its 45 byte-identical snapshots are the proof nothing visible changed.

**Tech Stack:** TypeScript strict, `intl-messageformat@^10.7.18` (dual CJS/ESM), vitest (shared + companion), jest 30 (backend), Next.js App Router, pnpm workspaces.

## Global Constraints

Every task implicitly includes these. Copy-checked against the spec.

1. **Branch:** work on `feat/i18n-readiness` (already exists; contains the spec commit `870fcbc0`).
2. **Dependency pin:** `intl-messageformat@^10.7.18`. NEVER 11.x — v11 is ESM-only (`type: module`) and would break the backend's CJS build and jest 30 loading. v10.7 ships dual CJS+ESM with the same constructor/`format`/`ignoreTag` API.
3. **Email byte-parity gate:** all 45 snapshots in `apps/backend/src/modules/email/templates/__snapshots__/templates.snapshot.spec.ts.snap` must pass UNCHANGED. Never run jest with `-u`/`--updateSnapshot`. A snapshot failure means fix the engine or call site, never the snapshot. Never edit email catalog content or keys (`apps/backend/src/modules/email/i18n/en.ts`) — engine upgrade only.
4. **English output byte-identical** except the deltas each task enumerates in its "Visible changes" list (these feed the PR-body ledger). If a test pins output this plan doesn't list as changing, the code is wrong, not the test.
5. **Number rendering rule (Epic-1 interaction):** ICU `#` renders numbers with the MESSAGE locale (`en`), but user-visible numbers must follow `preferences.format_locale` via `createFormatters`. Therefore: `#` is allowed ONLY for counts that cannot plausibly reach 1000 (days, weeks, months, photos, stars, passes, regions, members, waypoints, repairs, routes, per-day rides). Unbounded counts (total rides, views, embed clicks) pass a pre-formatted `n: format.integer(value)` for display plus the raw `count` for plural selection: `{count, plural, one {{n} ride} other {{n} rides}}`.
6. **Plural message shape:** selection argument is always named `count`; every plural message includes an `other` branch.
7. **`ignoreTag: true`** on every `IntlMessageFormat` construction (email messages contain literal `<strong>`/`<a>` markup).
8. **Fallback contract:** any ICU parse or format error falls back to the legacy `{token}` regex interpolation (the pre-swap engine). This preserves the pinned legacy behaviors (missing values leave placeholders untouched; malformed braces render as-is; the translator never throws). Pinned by tests in Task 1 — do not remove.
9. **Catalog discipline (`apps/companion/src/i18n/locales/en.ts`):** key and value are the identical English string, character-identical to the call-site literal; insert new entries in alphabetical key order; delete a key only after a grep proves zero remaining call sites.
10. **Stale-dist gotcha:** after any `packages/shared/src` change, run `pnpm --filter @tarmoto/shared build` before typechecking/testing dependent apps.
11. **Commits:** conventional `<type>(<scope>): <lowercase subject>`. This environment's git hooks are unusable — run `npx prettier --write <touched files>` before staging, commit with `git -c core.hooksPath=/dev/null commit`.
12. **Test commands:** shared → `cd packages/shared && npx vitest run <file>`; companion → `cd apps/companion && npx vitest run <file>` (`pnpm test -- <name>` does NOT filter); backend snapshots → `cd apps/backend && npx jest --testPathPatterns templates.snapshot`; companion typecheck → `cd apps/companion && npx tsc --noEmit` (CI typechecks test files too).
13. **Mobile untouched:** no edits under `apps/mobile`. `formatJoinedLabel`/`formatCount` default (translator-omitted) output stays byte-identical — that is the mobile contract.
14. **Scope discipline:** no drive-by refactors. Raw non-plural strings stay raw (PR 2 wraps them) EXCEPT strings inside a function this plan already converts for plurals (e.g. `buildRouteSummary`) — leaving half a function raw would force a second rewrite.

## File Structure

- `packages/shared/src/i18n.ts` — engine swap + `LooseTranslate` type (Task 1)
- `packages/shared/src/i18n.spec.ts` — engine tests incl. Czech-shaped catalog (Task 1)
- `packages/shared/package.json` — add `dependencies.intl-messageformat` (Task 1)
- `apps/companion/src/i18n/locales/catalog.test.ts` — NEW: catalog ICU-validity + apostrophe guard (Task 2)
- `apps/backend/src/modules/email/i18n/catalog-icu.spec.ts` — NEW: same guard for the email catalog (Task 2)
- `packages/shared/src/rider-format.ts` + `.spec.ts` — `formatJoinedLabel` optional translator (Task 3)
- `apps/companion/src/lib/gamification.ts`, `apps/companion/src/lib/ride-embed.ts` + tests + callers (Task 4)
- `apps/companion/src/app/(dashboard)/trips/planner/page.tsx` (Task 5)
- Components: `SegmentTrendChart`, `RoadReviewsPanel`, `TripRouteOverview`, `PassesPanel`, `ClosuresPanel`, `planner/RoadPreviewPopover`, `roads/SegmentDetailSidebar`, `community/CollectionPreviewMap`, `trips/DayByDayList`, `app/(dashboard)/trips/[tripId]/page.tsx` (Task 6)
- Pages: dashboard, roads/best ×2, settings/bikes, rides/\_components/RidesTable, rides/stats, community collections ×3, rides+trips share pages (Task 7)
- Normalization: `road-map/page.tsx`, `settings/privacy/page.tsx`, `TripPlannerMap.tsx` (+test), planner page (+test), `lib/planner/prefs.ts` (+test), `e2e/tests/trip-planner.spec.ts`, `en.ts` (Task 8)
- `docs/process/i18n.md` + `apps/companion/src/i18n/index.test.ts` + `apps/companion/src/i18n/locales/index.ts` comment (Task 9)
- `apps/companion/src/i18n/locales/en.ts` — touched by Tasks 3–8 (add/delete keys)

---

### Task 1: ICU engine swap in `makeTranslator`

**Files:**

- Modify: `packages/shared/package.json`
- Modify: `packages/shared/src/i18n.ts:87-114` (makeTranslator + new helpers above it)
- Test: `packages/shared/src/i18n.spec.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `makeTranslator` — SAME signature `(catalogs: CatalogsByLocale<K>) => Translator<K>`, now ICU-capable. New exported type `LooseTranslate = (key: string, values?: TranslationValues) => string` (Tasks 3/4 thread it). Engine semantics later tasks rely on: no-values calls return the template verbatim (fast path); plural rules and `#` formatting follow the locale of the CATALOG THAT SUPPLIED THE TEMPLATE (raw-key fallback ⇒ `en`), not the requested locale.

- [ ] **Step 1: Add the dependency**

```bash
cd /Users/akadlec/.superset/worktrees/97409800-fba5-47c2-a3d2-456e3b402110/dent-railway
pnpm --filter @tarmoto/shared add intl-messageformat@^10.7.18
```

Verify `packages/shared/package.json` gained `"dependencies": { "intl-messageformat": "^10.7.18" }` (a new `dependencies` block — the file previously had only `devDependencies`) and that the resolved version is 10.7.x, not 11.x.

- [ ] **Step 2: Write the failing engine tests**

Append to `packages/shared/src/i18n.spec.ts` (keep every existing test unchanged — they pin the legacy contract):

```ts
describe("i18n / makeTranslator (ICU)", () => {
  type Key = string;
  const icuT = makeTranslator<Key>({
    en: {
      rides: "{count, plural, one {# ride} other {# rides}}",
      whose: "{gender, select, female {her} male {his} other {their}} bike",
      prose: "a full day's ride",
      literalBrace: "literal '{' brace {name}",
      markup: '<strong style="color:#f8fafc;">{code}</strong>',
      views: "{count} views",
    },
  });

  it("selects English plural branches and formats # with the message locale", () => {
    expect(icuT("rides", { count: 1 })).toBe("1 ride");
    expect(icuT("rides", { count: 2 })).toBe("2 rides");
    // Intentional change from the String(n) engine: en grouping.
    expect(icuT("rides", { count: 1234 })).toBe("1,234 rides");
  });

  it("supports select", () => {
    expect(icuT("whose", { gender: "female" })).toBe("her bike");
    expect(icuT("whose", { gender: "x" })).toBe("their bike");
  });

  it("keeps prose apostrophes and renders escaped literal braces", () => {
    expect(icuT("prose", {})).toBe("a full day's ride");
    expect(icuT("literalBrace", { name: "x" })).toBe("literal { brace x");
  });

  it("treats markup as literal text (ignoreTag)", () => {
    expect(icuT("markup", { code: "ABC" })).toBe(
      '<strong style="color:#f8fafc;">ABC</strong>',
    );
  });

  it("locale-formats plain numeric arguments (documented engine change)", () => {
    expect(icuT("views", { count: 1234 })).toBe("1,234 views");
  });

  it("falls back to legacy interpolation for malformed messages and missing values", () => {
    // Unbalanced brace — ICU parse fails; legacy regex leaves it untouched.
    expect(icuT("Hi {name", { name: "R" })).toBe("Hi {name");
    // Valid ICU, missing value — legacy contract: placeholder stays.
    expect(icuT("Hi {a} {b}", { a: "x" })).toBe("Hi x {b}");
  });

  it("proves the machinery with a Czech-shaped catalog (one/few/other)", () => {
    // 'cs' is deliberately NOT in LOCALES — cast to exercise the engine the
    // way a future registered language would, without unhiding any UI.
    const cs = makeTranslator<string>({
      en: { left: "{count, plural, one {# day} other {# days}} left" },
      cs: {
        left: "{count, plural, one {Zbývá # den} few {Zbývají # dny} other {Zbývá # dní}}",
      },
    } as unknown as CatalogsByLocale<string>);
    const csLocale = "cs" as SupportedLocale;
    expect(cs("left", { count: 1 }, csLocale)).toBe("Zbývá 1 den");
    expect(cs("left", { count: 2 }, csLocale)).toBe("Zbývají 2 dny");
    expect(cs("left", { count: 5 }, csLocale)).toBe("Zbývá 5 dní");
  });

  it("applies the plural rules of the catalog that supplied the template", () => {
    // Key missing from cs catalog → en template AND en plural rules apply.
    const cs = makeTranslator<string>({
      en: { left: "{count, plural, one {# day} other {# days}} left" },
      cs: {},
    } as unknown as CatalogsByLocale<string>);
    const csLocale = "cs" as SupportedLocale;
    expect(cs("left", { count: 2 }, csLocale)).toBe("2 days left");
    expect(cs("left", { count: 1234 }, csLocale)).toBe("1,234 days left");
  });
});
```

(Add `CatalogsByLocale` and `SupportedLocale` to the spec's type imports from `./i18n`.)

- [ ] **Step 3: Run to verify failure**

Run: `cd packages/shared && npx vitest run src/i18n.spec.ts`
Expected: FAIL — plural/select messages render raw (`"{count, plural, one {# ride} other {# rides}}"` comes back unformatted from the legacy regex).

- [ ] **Step 4: Implement the engine**

In `packages/shared/src/i18n.ts`, add the import at the top and replace the body below `Translator` (keep `read` and the lookup order; the diff is confined to interpolation):

```ts
import { IntlMessageFormat } from "intl-messageformat";
```

```ts
/**
 * Loose translator shape for threading through pure helper functions that
 * cannot depend on a concrete catalog's key union (e.g. shared rider-format
 * helpers, companion lib formatters). Locale binding is the caller's concern.
 */
export type LooseTranslate = (
  key: string,
  values?: TranslationValues,
) => string;

// Parsed-message cache shared by every translator. Keyed by source locale +
// template so the same English fallback text can coexist with a translated
// variant under different plural rules. `null` negative-caches templates
// that fail to parse, so a malformed raw key doesn't re-throw per render.
// Capped and cleared wholesale like the Formatters caches in format.ts.
const MESSAGE_CACHE_MAX = 256;
const messageFormats = new Map<string, IntlMessageFormat | null>();

function getMessageFormat(
  template: string,
  locale: SupportedLocale,
): IntlMessageFormat | null {
  const cacheKey = `${locale}\u0000${template}`;
  const cached = messageFormats.get(cacheKey);
  if (cached !== undefined) return cached;
  if (messageFormats.size >= MESSAGE_CACHE_MAX) messageFormats.clear();
  let parsed: IntlMessageFormat | null;
  try {
    // ignoreTag keeps `<strong>`-style markup (backend email templates) as
    // literal text instead of ICU rich-text tags demanding render functions.
    parsed = new IntlMessageFormat(template, locale, undefined, {
      ignoreTag: true,
    });
  } catch {
    parsed = null;
  }
  messageFormats.set(cacheKey, parsed);
  return parsed;
}

// The pre-ICU engine, retained as the compatibility fallback: it never
// throws, leaves unmatched placeholders in place, and renders malformed
// templates verbatim — the contract the legacy tests pin.
function interpolateLegacy(
  template: string,
  values: TranslationValues,
): string {
  return template.replace(/\{(\w+)\}/g, (match, valueKey: string) => {
    const value = values[valueKey];
    return value === undefined ? match : String(value);
  });
}

/**
 * Build a translator over a surface's catalogs. Lookup order:
 * active-locale catalog → default-locale (en) catalog → the raw key.
 * Interpolation is ICU MessageFormat (plural/select/#) via
 * `intl-messageformat`, using the plural rules of the locale whose catalog
 * supplied the template (raw-key fallback ⇒ default locale). Calls without
 * values return the template verbatim (fast path — most catalog entries).
 * Any ICU parse/format error degrades to the legacy `{placeholder}`
 * substitution. Substitution is RAW — callers that emit HTML MUST escape
 * untrusted values before passing them in.
 */
export function makeTranslator<K extends string>(
  catalogs: CatalogsByLocale<K>,
): Translator<K> {
  const read = (locale: SupportedLocale, key: K): string | undefined => {
    const catalog = catalogs[locale] as Partial<Catalog<K>> | undefined;
    return catalog?.[key];
  };

  return (key, values, locale = DEFAULT_LOCALE) => {
    let template = read(locale, key);
    let sourceLocale = locale;
    if (template === undefined && locale !== DEFAULT_LOCALE) {
      template = read(DEFAULT_LOCALE, key);
      sourceLocale = DEFAULT_LOCALE;
    }
    if (template === undefined) {
      template = key;
      sourceLocale = DEFAULT_LOCALE;
    }

    if (!values) return template;

    const parsed = getMessageFormat(template, sourceLocale);
    if (parsed === null) return interpolateLegacy(template, values);
    try {
      return parsed.format(values) as string;
    } catch {
      return interpolateLegacy(template, values);
    }
  };
}
```

- [ ] **Step 5: Run shared tests — all green including the four pre-existing legacy pins**

Run: `cd packages/shared && npx vitest run`
Expected: PASS (whole shared suite — `format.spec.ts`, `rider-format.spec.ts` etc. must stay green too).

- [ ] **Step 6: Build shared, then run the byte-parity gate + full downstream suites**

```bash
pnpm --filter @tarmoto/shared build
cd apps/backend && npx jest --testPathPatterns templates.snapshot
```

Expected: 45/45 snapshots PASS with zero snapshot writes. If ANY fails: the engine broke email parity — fix the engine (likely `ignoreTag` or fallback), never the snapshot.

```bash
cd apps/companion && npx vitest run && npx tsc --noEmit
```

Expected: full companion suite green (no companion source changed; this proves engine compatibility with all existing `t()` traffic).

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/shared/src/i18n.ts packages/shared/src/i18n.spec.ts
git add packages/shared/src/i18n.ts packages/shared/src/i18n.spec.ts packages/shared/package.json pnpm-lock.yaml
git -c core.hooksPath=/dev/null commit -m "feat(shared): swap makeTranslator interpolation to icu intl-messageformat"
```

**Visible changes:** none (engine-internal; numeric-arg grouping only manifests where later tasks pass numbers ≥1000).

---

### Task 2: Catalog ICU-validity + apostrophe guards

**Files:**

- Create: `apps/companion/src/i18n/locales/catalog.test.ts`
- Create: `apps/backend/src/modules/email/i18n/catalog-icu.spec.ts`

**Interfaces:**

- Consumes: `en` catalogs (`apps/companion/src/i18n/locales/en.ts`, `apps/backend/src/modules/email/i18n/en.ts`).
- Produces: permanent guards later tasks' new catalog keys must satisfy — ICU-parseability, no apostrophe pitfalls, and (for plural messages) `count` + `other` structure per Global Constraints 5-6.

- [ ] **Step 0: Add the test dependency to both apps**

pnpm gives each workspace package an isolated `node_modules` — these tests import `intl-messageformat` directly, so it must be a devDependency of each app (same pinned line as Task 1):

```bash
pnpm --filter ./apps/companion add -D intl-messageformat@^10.7.18
pnpm --filter ./apps/backend add -D intl-messageformat@^10.7.18
```

- [ ] **Step 1: Write the companion catalog guard**

Create `apps/companion/src/i18n/locales/catalog.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Write the email catalog guard**

Create `apps/backend/src/modules/email/i18n/catalog-icu.spec.ts`:

```ts
import { IntlMessageFormat } from "intl-messageformat";
import { en } from "./en.js";

// Engine-readiness guard for the email catalog (content is out of scope —
// this asserts parseability, not copy). See companion catalog.test.ts for
// the rationale on the apostrophe rules.
describe("email en catalog ICU validity", () => {
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
});
```

(Match the email module's import style — it uses `./en.js` ESM-suffixed relative imports and single quotes.)

- [ ] **Step 3: Run both**

```bash
cd apps/companion && npx vitest run src/i18n/locales/catalog.test.ts
cd ../../apps/backend && npx jest --testPathPatterns catalog-icu
```

Expected: PASS on both (pre-verified: neither catalog contains `'{`, `'}`, or `''`; messages are balanced). If an entry fails the parse test, STOP and report — a copy change would be needed, which must go on the visible-changes ledger, not be slipped in silently.

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/companion/src/i18n/locales/catalog.test.ts apps/backend/src/modules/email/i18n/catalog-icu.spec.ts
git add apps/companion/src/i18n/locales/catalog.test.ts apps/backend/src/modules/email/i18n/catalog-icu.spec.ts apps/companion/package.json apps/backend/package.json pnpm-lock.yaml
git -c core.hooksPath=/dev/null commit -m "test(cross): icu validity + apostrophe guards for companion and email catalogs"
```

**Visible changes:** none.

---

### Task 3: `formatJoinedLabel` optional translator (shared, mobile-safe)

**Files:**

- Modify: `packages/shared/src/rider-format.ts:21-37`
- Test: `packages/shared/src/rider-format.spec.ts`
- Modify: `apps/companion/src/app/(dashboard)/community/[riderId]/page.tsx:251`
- Modify: `apps/companion/src/i18n/locales/en.ts` (add 4 keys)

**Interfaces:**

- Consumes: `LooseTranslate`, `TranslationValues` from Task 1.
- Produces: `formatJoinedLabel(joinedAt: string, now?: Date, t?: LooseTranslate): string`. Omitted `t` ⇒ byte-identical legacy English (mobile contract). Companion catalog keys: `"Joined recently"`, `"Joined this month"`, `"Joined {count, plural, one {# month} other {# months}} ago"`, `"Joined {count, plural, one {# year} other {# years}} ago"`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/rider-format.spec.ts`:

```ts
import { makeTranslator } from "./i18n";
import { formatJoinedLabel } from "./rider-format";

describe("formatJoinedLabel", () => {
  const NOW = new Date("2026-07-15T12:00:00Z");

  it("keeps the legacy English output when no translator is passed (mobile contract)", () => {
    expect(formatJoinedLabel("2026-07-01T00:00:00Z", NOW)).toBe(
      "Joined this month",
    );
    expect(formatJoinedLabel("2026-06-01T00:00:00Z", NOW)).toBe(
      "Joined 1 month ago",
    );
    expect(formatJoinedLabel("2026-02-01T00:00:00Z", NOW)).toBe(
      "Joined 5 months ago",
    );
    expect(formatJoinedLabel("2024-05-01T00:00:00Z", NOW)).toBe(
      "Joined 2 years ago",
    );
    expect(formatJoinedLabel("not-a-date", NOW)).toBe("Joined recently");
  });

  it("routes through the translator when one is passed", () => {
    const t = makeTranslator<string>({
      en: {
        "Joined {count, plural, one {# month} other {# months}} ago":
          "Joined {count, plural, one {# month} other {# months}} ago",
        "Joined {count, plural, one {# year} other {# years}} ago":
          "Joined {count, plural, one {# year} other {# years}} ago",
        "Joined this month": "Joined this month",
        "Joined recently": "Joined recently",
      },
    });
    expect(formatJoinedLabel("2026-06-01T00:00:00Z", NOW, t)).toBe(
      "Joined 1 month ago",
    );
    expect(formatJoinedLabel("2026-02-01T00:00:00Z", NOW, t)).toBe(
      "Joined 5 months ago",
    );
    expect(formatJoinedLabel("2024-05-01T00:00:00Z", NOW, t)).toBe(
      "Joined 2 years ago",
    );
    expect(formatJoinedLabel("2026-07-01T00:00:00Z", NOW, t)).toBe(
      "Joined this month",
    );
  });
});
```

(Merge the `formatJoinedLabel` import into the spec's existing import from `./rider-format`.)

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/shared && npx vitest run src/rider-format.spec.ts`
Expected: FAIL — `formatJoinedLabel` accepts no third argument (TS error) / translated path missing.

- [ ] **Step 3: Implement**

In `packages/shared/src/rider-format.ts`, add to the imports and replace the function (keep the existing doc comment, append the translator note):

```ts
import type { LooseTranslate } from "./i18n";
```

```ts
/**
 * "Joined this month" / "Joined 5 months ago" / "Joined 2 years ago".
 *
 * (existing paragraph about calendar-month arithmetic stays verbatim)
 *
 * @param t - Optional translator. Omitted keeps today's exact English
 * output (mobile's existing contract); when provided, the label routes
 * through ICU plural messages so translated locales get real plural rules.
 */
export function formatJoinedLabel(
  joinedAt: string,
  now: Date = new Date(),
  t?: LooseTranslate,
): string {
  const date = new Date(joinedAt);
  if (Number.isNaN(date.getTime())) {
    return t ? t("Joined recently") : "Joined recently";
  }
  let months =
    (now.getUTCFullYear() - date.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - date.getUTCMonth());
  if (now.getUTCDate() < date.getUTCDate()) months -= 1;
  if (months < 0) months = 0;
  if (months < 1) return t ? t("Joined this month") : "Joined this month";
  if (months < 12) {
    return t
      ? t("Joined {count, plural, one {# month} other {# months}} ago", {
          count: months,
        })
      : `Joined ${months} month${months === 1 ? "" : "s"} ago`;
  }
  const years = Math.floor(months / 12);
  return t
    ? t("Joined {count, plural, one {# year} other {# years}} ago", {
        count: years,
      })
    : `Joined ${years} year${years === 1 ? "" : "s"} ago`;
}
```

- [ ] **Step 4: Run shared tests**

Run: `cd packages/shared && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Thread the companion caller + register keys**

`apps/companion/src/app/(dashboard)/community/[riderId]/page.tsx:251` — change:

```tsx
<span>{formatJoinedLabel(profile.created_at)}</span>
```

to:

```tsx
<span>{formatJoinedLabel(profile.created_at, new Date(), t)}</span>
```

(`t` is already imported/available in this file — verify; if the component uses `useTranslation()`, use that binding.)

Add to `apps/companion/src/i18n/locales/en.ts` (alphabetical position, key === value):

```ts
  "Joined recently": "Joined recently",
  "Joined this month": "Joined this month",
  "Joined {count, plural, one {# month} other {# months}} ago":
    "Joined {count, plural, one {# month} other {# months}} ago",
  "Joined {count, plural, one {# year} other {# years}} ago":
    "Joined {count, plural, one {# year} other {# years}} ago",
```

- [ ] **Step 6: Verify**

```bash
pnpm --filter @tarmoto/shared build
cd apps/companion && npx vitest run src/i18n/locales/catalog.test.ts && npx tsc --noEmit
```

Expected: PASS. Also run the page's covering test if one exists (`npx vitest run riderId` — if no test matches, note that in the report).

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/shared/src/rider-format.ts packages/shared/src/rider-format.spec.ts "apps/companion/src/app/(dashboard)/community/[riderId]/page.tsx" apps/companion/src/i18n/locales/en.ts
git add -A packages/shared/src apps/companion/src
git -c core.hooksPath=/dev/null commit -m "feat(shared): optional translator for formatjoinedlabel plurals"
```

**Visible changes:** none in English (translated path is English-identical; mobile path untouched).

---

### Task 4: Lib plural threading — `formatDaysRemaining` + `formatRideEmbedStat`

**Files:**

- Modify: `apps/companion/src/lib/gamification.ts:267-290`
- Modify: `apps/companion/src/lib/ride-embed.ts:44-51`
- Modify: `apps/companion/src/app/(dashboard)/achievements/page.tsx:630`
- Modify: `apps/companion/src/app/rides/shared/[token]/_components/RouteEmbedPanel.tsx:94,98`
- Modify: `apps/companion/src/app/embed/rides/_components/SharedRideEmbedWidget.tsx:105,107,185,190`
- Test: `apps/companion/src/lib/__tests__/gamification.test.ts:235-282`, `apps/companion/src/lib/__tests__/ride-embed.test.ts:40-41`
- Modify: `apps/companion/src/i18n/locales/en.ts`

**Interfaces:**

- Consumes: `LooseTranslate` (from `@tarmoto/shared`), companion `t` (`@/i18n`), `Formatters` (existing).
- Produces: `formatDaysRemaining(endsAt: string, now: Date, t: LooseTranslate): string` (note: `now` loses its default — a required param cannot follow an optional one, and `t` goes last per the Formatters threading convention). `formatRideEmbedStat(value: number, noun: "view" | "click", format: Formatters, t: LooseTranslate): string`.

- [ ] **Step 1: Update the tests first**

In `apps/companion/src/lib/__tests__/gamification.test.ts`, add `import { t } from "@/i18n";` and change every `formatDaysRemaining(X, NOW)` call to `formatDaysRemaining(X, NOW, t)` (12 calls in the `describe("formatDaysRemaining")` block, lines 235-282). Every expected string stays IDENTICAL ("Ends today", "3 days left", "1w 3d left", "1 month left", "Ongoing", …).

In `apps/companion/src/lib/__tests__/ride-embed.test.ts`, add the same `t` import and change:

```ts
expect(formatRideEmbedStat(1, "view", format)).toBe("1 view");
expect(formatRideEmbedStat(2450, "click", format)).toBe("2,450 clicks");
```

to:

```ts
expect(formatRideEmbedStat(1, "view", format, t)).toBe("1 view");
expect(formatRideEmbedStat(2450, "click", format, t)).toBe("2,450 clicks");
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/companion && npx vitest run src/lib/__tests__/gamification.test.ts src/lib/__tests__/ride-embed.test.ts`
Expected: FAIL (arity/type errors).

- [ ] **Step 3: Implement `formatDaysRemaining`**

Replace in `apps/companion/src/lib/gamification.ts` (add `import type { LooseTranslate } from "@tarmoto/shared";` to the file's shared import):

```ts
export function formatDaysRemaining(
  endsAt: string,
  now: Date,
  t: LooseTranslate,
): string {
  const end = new Date(endsAt).getTime();
  if (!Number.isFinite(end)) return t("Ongoing");
  const diffMs = end - now.getTime();
  if (diffMs <= 0) return t("Ended");
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days === 0) return t("Ends today");
  if (days === 1) return t("Ends tomorrow");
  if (days < 7) {
    return t("{count, plural, one {# day} other {# days}} left", {
      count: days,
    });
  }
  const weeks = Math.floor(days / 7);
  const extra = days % 7;
  if (weeks < 4) {
    return extra === 0
      ? t("{count, plural, one {# week} other {# weeks}} left", {
          count: weeks,
        })
      : t("{weeks}w {days}d left", { weeks, days: extra });
  }
  // Clamp to at least 1 so the 28-29 day band (weeks === 4, days / 30 === 0)
  // doesn't render "0 months left".
  const months = Math.max(1, Math.floor(days / 30));
  return t("{count, plural, one {# month} other {# months}} left", {
    count: months,
  });
}
```

Update the caller `apps/companion/src/app/(dashboard)/achievements/page.tsx:630`:

```ts
const daysLeft = formatDaysRemaining(seasonal.endsAt, new Date(), t);
```

(The page already imports `t`. `formatDaysShort` further down the file is a distinct unit-code helper — "5D LEFT" — with no word plurals; leave it alone.)

- [ ] **Step 4: Implement `formatRideEmbedStat`**

Replace in `apps/companion/src/lib/ride-embed.ts` (add the `LooseTranslate` type import):

```ts
export function formatRideEmbedStat(
  value: number,
  noun: "view" | "click",
  format: Formatters,
  t: LooseTranslate,
): string {
  // View/click totals are unbounded, so the visible number comes
  // pre-formatted via the rider's format locale; the raw count only drives
  // plural selection.
  const values = { count: value, n: format.integer(value) };
  return noun === "view"
    ? t("{count, plural, one {{n} view} other {{n} views}}", values)
    : t("{count, plural, one {{n} click} other {{n} clicks}}", values);
}
```

Update all 5 call sites (`RouteEmbedPanel.tsx:94,98`, `SharedRideEmbedWidget.tsx:105,107,185,190-191`) to append `t` as the 4th argument, e.g. `formatRideEmbedStat(views, "view", format, t)`. Both components: verify `t` is imported from `@/i18n` (add the import if absent).

- [ ] **Step 5: Register catalog keys**

Add to `apps/companion/src/i18n/locales/en.ts` (alphabetical; key === value):

```ts
  Ended: "Ended",
  "Ends today": "Ends today",
  "Ends tomorrow": "Ends tomorrow",
  Ongoing: "Ongoing",
  "{count, plural, one {# day} other {# days}} left":
    "{count, plural, one {# day} other {# days}} left",
  "{count, plural, one {# month} other {# months}} left":
    "{count, plural, one {# month} other {# months}} left",
  "{count, plural, one {# week} other {# weeks}} left":
    "{count, plural, one {# week} other {# weeks}} left",
  "{count, plural, one {{n} click} other {{n} clicks}}":
    "{count, plural, one {{n} click} other {{n} clicks}}",
  "{count, plural, one {{n} view} other {{n} views}}":
    "{count, plural, one {{n} view} other {{n} views}}",
  "{weeks}w {days}d left": "{weeks}w {days}d left",
```

(If `Ended`/`Ongoing`/`Ends today`/`Ends tomorrow` already exist in `en.ts`, keep the existing entry — grep first.)

- [ ] **Step 6: Run the covering tests + suite slices**

```bash
cd apps/companion && npx vitest run src/lib/__tests__/gamification.test.ts src/lib/__tests__/ride-embed.test.ts src/i18n/locales/catalog.test.ts
npx vitest run RouteEmbedPanel
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx prettier --write apps/companion/src/lib/gamification.ts apps/companion/src/lib/ride-embed.ts "apps/companion/src/app/(dashboard)/achievements/page.tsx" "apps/companion/src/app/rides/shared/[token]/_components/RouteEmbedPanel.tsx" apps/companion/src/app/embed/rides/_components/SharedRideEmbedWidget.tsx apps/companion/src/lib/__tests__/gamification.test.ts apps/companion/src/lib/__tests__/ride-embed.test.ts apps/companion/src/i18n/locales/en.ts
git add -A apps/companion/src
git -c core.hooksPath=/dev/null commit -m "feat(companion): icu plurals for gamification countdown and ride embed stats"
```

**Visible changes:** view/click counts ≥1000 now render with the rider's format-locale grouping ("2,450 clicks" for en — previously already grouped via `format.integer`, so no change there; countdowns byte-identical).

---

### Task 5: Planner page plural rewrite (4 `{s}` sites)

**Files:**

- Modify: `apps/companion/src/app/(dashboard)/trips/planner/page.tsx:2168-2192,2570-2574,2799-2803`
- Modify: `apps/companion/src/i18n/locales/en.ts`
- Test: `apps/companion/src/app/(dashboard)/trips/planner/page.test.tsx` (only if a pin matches the old literals — grep first; none known)

**Interfaces:**

- Consumes: companion `t`.
- Produces: catalog key `"{count, plural, one {# day} other {# days}}"` — Tasks 6 and 7 REUSE this exact key for their day-count sites; do not vary its wording.

- [ ] **Step 1: Rewrite the four sites**

Site 1+2 (draft toasts, lines ~2168-2192). Replace:

```ts
? t(
    "Drafted ≈{distance} through {count} Fun Zone{s} on the way.",
    {
      distance: draftedDistance,
      count: result.vias.length,
      s: result.vias.length === 1 ? "" : "s",
    },
  )
```

with:

```ts
? t(
    "Drafted ≈{distance} through {count, plural, one {# Fun Zone} other {# Fun Zones}} on the way.",
    {
      distance: draftedDistance,
      count: result.vias.length,
    },
  )
```

and:

```ts
t("Drafted ≈{distance} through {count} Fun Zone{s}.", {
  distance: draftedDistance,
  count: result.vias.length,
  s: result.vias.length === 1 ? "" : "s",
}),
```

with:

```ts
t("Drafted ≈{distance} through {count, plural, one {# Fun Zone} other {# Fun Zones}}.", {
  distance: draftedDistance,
  count: result.vias.length,
}),
```

Site 3 (day chip, ~2570):

```ts
{
  t("{days} day{s}", {
    days: dayPlans.length,
    s: dayPlans.length === 1 ? "" : "s",
  });
}
```

becomes:

```ts
{
  t("{count, plural, one {# day} other {# days}}", {
    count: dayPlans.length,
  });
}
```

Site 4 (itinerary header, ~2799):

```ts
{
  t("Itinerary · {days} day{s}", {
    days: dayPlans.length,
    s: dayPlans.length === 1 ? "" : "s",
  });
}
```

becomes:

```ts
{
  t("Itinerary · {count, plural, one {# day} other {# days}}", {
    count: dayPlans.length,
  });
}
```

- [ ] **Step 2: Update the catalog**

Add to `en.ts` (alphabetical; key === value):

```ts
  "Drafted ≈{distance} through {count, plural, one {# Fun Zone} other {# Fun Zones}} on the way.":
    "Drafted ≈{distance} through {count, plural, one {# Fun Zone} other {# Fun Zones}} on the way.",
  "Drafted ≈{distance} through {count, plural, one {# Fun Zone} other {# Fun Zones}}.":
    "Drafted ≈{distance} through {count, plural, one {# Fun Zone} other {# Fun Zones}}.",
  "Itinerary · {count, plural, one {# day} other {# days}}":
    "Itinerary · {count, plural, one {# day} other {# days}}",
  "{count, plural, one {# day} other {# days}}":
    "{count, plural, one {# day} other {# days}}",
```

Then grep for the OLD keys and delete them from `en.ts` if present (they may be among the unregistered ~675 — delete only what exists):

```bash
grep -n 'Fun Zone{s}\|{days} day{s}\|Itinerary · {days}' apps/companion/src/i18n/locales/en.ts
```

- [ ] **Step 3: Verify**

```bash
grep -n '{s}' 'apps/companion/src/app/(dashboard)/trips/planner/page.tsx'
```

Expected: no matches.

```bash
cd apps/companion && npx vitest run src/app/\(dashboard\)/trips/planner/page.test.tsx src/i18n/locales/catalog.test.ts && npx tsc --noEmit
```

Expected: PASS (English render output is identical: "3 days", "1 day", "Itinerary · 2 days", "Drafted ≈42 km through 3 Fun Zones on the way.").

- [ ] **Step 4: Commit**

```bash
npx prettier --write "apps/companion/src/app/(dashboard)/trips/planner/page.tsx" apps/companion/src/i18n/locales/en.ts
git add -A apps/companion/src
git -c core.hooksPath=/dev/null commit -m "feat(companion): icu plurals for planner draft toasts and day counts"
```

**Visible changes:** none in English.

---

### Task 6: Component plural rewrite

**Files (all under `apps/companion/src/`):**

- Modify: `components/SegmentTrendChart.tsx:407,419-421`
- Modify: `components/RoadReviewsPanel.tsx:763,1037-1039`
- Modify: `components/TripRouteOverview.tsx:44`
- Modify: `components/PassesPanel.tsx:194,462-484`
- Modify: `components/ClosuresPanel.tsx:276-281`
- Modify: `components/planner/RoadPreviewPopover.tsx:298-306`
- Modify: `components/roads/SegmentDetailSidebar.tsx:171`
- Modify: `components/community/CollectionPreviewMap.tsx:155-156`
- Modify: `components/trips/DayByDayList.tsx:151-155`
- Modify: `app/(dashboard)/trips/[tripId]/page.tsx:441,455-464`
- Modify: `i18n/locales/en.ts`
- Tests: `components/SegmentTrendChart.test.tsx`, `components/RoadReviewsPanel.test.tsx`, `components/PassesPanel.test.tsx`, `components/ClosuresPanel.test.tsx` (English output identical except the two fixes below — only pins of "1 rider passes" or joined-fragment forms change)

**Interfaces:**

- Consumes: `"{count, plural, one {# day} other {# days}}"` catalog key from Task 5.
- Produces: catalog keys listed in Step 2.

- [ ] **Step 1: Rewrite each site**

`SegmentTrendChart.tsx:407`:

```ts
{
  t(repairCount === 1 ? "{count} repair" : "{count} repairs", {
    count: repairCount,
  });
}
```

→

```ts
{
  t("{count, plural, one {# repair} other {# repairs}}", {
    count: repairCount,
  });
}
```

and `:419-421` the deterioration twin →

```ts
{
  t("{count, plural, one {# deterioration} other {# deteriorations}}", {
    count: detCount,
  });
}
```

`RoadReviewsPanel.tsx:763` (raw aria-label — wrap it, it's part of this plural site):

```ts
aria-label={`${rating} ${rating === 1 ? "star" : "stars"}`}
```

→

```ts
aria-label={t("{count, plural, one {# star} other {# stars}}", {
  count: rating,
})}
```

`RoadReviewsPanel.tsx:1037-1039`:

```ts
{
  t(photos.length === 1 ? "{count} photo" : "{count} photos", {
    count: photos.length,
  });
}
```

→

```ts
{
  t("{count, plural, one {# photo} other {# photos}}", {
    count: photos.length,
  });
}
```

`TripRouteOverview.tsx:44`:

```ts
dayCount === 1 ? t("1 day") : t("{count} days", { count: dayCount }),
```

→

```ts
t("{count, plural, one {# day} other {# days}}", { count: dayCount }),
```

`PassesPanel.tsx` — thread `t` into the module-local helper and convert its strings (constraint 14: the function's raw strings convert with it). Replace `buildRouteSummary` (lines 462-484) with:

```ts
function buildRouteSummary(
  closedCount: number,
  unknownCount: number,
  t: LooseTranslate,
): string {
  const parts: string[] = [];
  if (closedCount > 0) {
    parts.push(
      t("{count, plural, one {# closed pass} other {# closed passes}}", {
        count: closedCount,
      }),
    );
  }
  if (unknownCount > 0) {
    parts.push(
      t("{count, plural, one {# unknown pass} other {# unknown passes}}", {
        count: unknownCount,
      }),
    );
  }
  if (parts.length === 0) {
    return t("No closed or unknown passes on your route.");
  }
  if (parts.length === 1) {
    return t("Current trip crosses {summary}.", { summary: parts[0] ?? "" });
  }
  return t("Current trip crosses {first} and {second}.", {
    first: parts[0] ?? "",
    second: parts[1] ?? "",
  });
}
```

Caller `:194`: `buildRouteSummary(routeClosedCount, routeUnknownCount, t)`. Import `LooseTranslate` from `@tarmoto/shared`; use the component's existing `t` binding, adding `import { t } from "@/i18n";` if the file lacks one (its summary strings were raw until now).

`ClosuresPanel.tsx:276-281`:

```ts
{
  t("Current trip crosses {count} active {closureLabel}.", {
    count: routeCounts.total,
    closureLabel: routeCounts.total === 1 ? "closure" : "closures",
  });
}
```

→

```ts
{
  t(
    "Current trip crosses {count, plural, one {# active closure} other {# active closures}}.",
    { count: routeCounts.total },
  );
}
```

`RoadPreviewPopover.tsx:298-306` — two sites. The low-confidence chip:

```tsx
{t("LOW CONFIDENCE ")}· {preview.passes}{" "}
{preview.passes === 1 ? t("PASS ") : t("PASSES ")}
```

→

```tsx
{t("LOW CONFIDENCE ")}·{" "}
{t("{count, plural, one {# PASS} other {# PASSES}}", {
  count: preview.passes,
})}
```

The rider-passes line just below (fragment concatenation AND a "1 rider passes" bug):

```tsx
{
  t("based on ");
}
{
  preview.passes;
}
{
  t("rider passes ");
}
```

→

```tsx
{
  t("based on {count, plural, one {# rider pass} other {# rider passes}}", {
    count: preview.passes,
  });
}
```

(Check the JSX right after for the continuation of that sentence — keep surrounding fragments untouched; trailing-space keys mean the replacement must preserve the same visible spacing. If the old keys `"PASS "`, `"PASSES "`, `"based on "`, `"rider passes "` exist in `en.ts` and have no remaining call sites after this change, delete them.)

`SegmentDetailSidebar.tsx:171` (word-only label used at `:227` `caption={passLabel}` and `:248`):

```ts
const passLabel = segment.reading_count === 1 ? t("pass") : t("passes");
```

→

```ts
const passLabel = t("{count, plural, one {pass} other {passes}}", {
  count: segment.reading_count ?? 0,
});
```

`CollectionPreviewMap.tsx:155-156`:

```tsx
{
  drawableCount;
}
{
  (" ");
}
{
  drawableCount === 1 ? t("route traced") : t("routes traced");
}
```

→

```tsx
{
  t("{count, plural, one {# route traced} other {# routes traced}}", {
    count: drawableCount,
  });
}
```

`DayByDayList.tsx:151-155`:

```ts
{
  t("{count} {waypointLabel}", {
    count: day.waypoints.length,
    waypointLabel: day.waypoints.length === 1 ? "waypoint" : "waypoints",
  });
}
```

→

```ts
{
  t("{count, plural, one {# waypoint} other {# waypoints}}", {
    count: day.waypoints.length,
  });
}
```

`app/(dashboard)/trips/[tripId]/page.tsx:441` (guarded by `days.length > 1` but rewrite for consistency — reuses Task 5's key):

```ts
{
  t("{count} days", { count: trip.days.length });
}
```

→

```ts
{
  t("{count, plural, one {# day} other {# days}}", {
    count: trip.days.length,
  });
}
```

and `:455-464` (members):

```ts
{
  t(loaded.members.length === 1 ? "{count} member" : "{count} members", {
    count: loaded.members.length,
  });
}
```

→

```ts
{
  t("{count, plural, one {# member} other {# members}}", {
    count: loaded.members.length,
  });
}
```

- [ ] **Step 2: Update the catalog**

Add (alphabetical; key === value):

```ts
  "Current trip crosses {count, plural, one {# active closure} other {# active closures}}.":
    "Current trip crosses {count, plural, one {# active closure} other {# active closures}}.",
  "Current trip crosses {first} and {second}.":
    "Current trip crosses {first} and {second}.",
  "Current trip crosses {summary}.": "Current trip crosses {summary}.",
  "No closed or unknown passes on your route.":
    "No closed or unknown passes on your route.",
  "based on {count, plural, one {# rider pass} other {# rider passes}}":
    "based on {count, plural, one {# rider pass} other {# rider passes}}",
  "{count, plural, one {# PASS} other {# PASSES}}":
    "{count, plural, one {# PASS} other {# PASSES}}",
  "{count, plural, one {# closed pass} other {# closed passes}}":
    "{count, plural, one {# closed pass} other {# closed passes}}",
  "{count, plural, one {# deterioration} other {# deteriorations}}":
    "{count, plural, one {# deterioration} other {# deteriorations}}",
  "{count, plural, one {# member} other {# members}}":
    "{count, plural, one {# member} other {# members}}",
  "{count, plural, one {# photo} other {# photos}}":
    "{count, plural, one {# photo} other {# photos}}",
  "{count, plural, one {# repair} other {# repairs}}":
    "{count, plural, one {# repair} other {# repairs}}",
  "{count, plural, one {# route traced} other {# routes traced}}":
    "{count, plural, one {# route traced} other {# routes traced}}",
  "{count, plural, one {# star} other {# stars}}":
    "{count, plural, one {# star} other {# stars}}",
  "{count, plural, one {# unknown pass} other {# unknown passes}}":
    "{count, plural, one {# unknown pass} other {# unknown passes}}",
  "{count, plural, one {# waypoint} other {# waypoints}}":
    "{count, plural, one {# waypoint} other {# waypoints}}",
  "{count, plural, one {pass} other {passes}}":
    "{count, plural, one {pass} other {passes}}",
```

Delete the keys this task orphans — for each, grep `apps/companion/src` (excluding `en.ts`) to confirm zero call sites first: `"{count} repair"`, `"{count} repairs"`, `"{count} deterioration"`, `"{count} deteriorations"`, `"{count} photo"`, `"{count} photos"`, `"{count} member"`, `"{count} members"`, `"Current trip crosses {count} active {closureLabel}."` (if registered), plus any of the RoadPreviewPopover fragment keys freed above. Do NOT delete `"1 day"`/`"{count} days"` yet — `trips/shared/[token]/page.tsx` still uses them until Task 7.

- [ ] **Step 3: Verify**

```bash
cd apps/companion && npx vitest run src/components/SegmentTrendChart.test.tsx src/components/RoadReviewsPanel.test.tsx src/components/PassesPanel.test.tsx src/components/ClosuresPanel.test.tsx src/i18n/locales/catalog.test.ts
npx tsc --noEmit
```

Expected: PASS. If a test pins "1 rider passes" or the old fragment layout, update the expectation to the fixed copy (list it in the report).

- [ ] **Step 4: Commit**

```bash
git diff --name-only | grep -E '\.(ts|tsx)$' | xargs npx prettier --write
git add -A apps/companion/src
git -c core.hooksPath=/dev/null commit -m "feat(companion): icu plurals across map, trip and review components"
```

**Visible changes:** "based on 1 rider passes" → "based on 1 rider pass" (singular fix); low-confidence chip spacing normalized around the PASS count (verify visually identical rendering — `·` separator preserved).

---

### Task 7: Page-level plural rewrite + obsolete-key sweep

**Files (all under `apps/companion/src/`):**

- Modify: `app/(dashboard)/page.tsx:604,610`
- Modify: `app/roads/best/[country]/page.tsx:63-65`
- Modify: `app/roads/best/page.tsx:31-34`
- Modify: `app/(dashboard)/settings/bikes/page.tsx:244-247`
- Modify: `app/(dashboard)/rides/_components/RidesTable.tsx:180-182`
- Modify: `app/(dashboard)/rides/stats/page.tsx:963-966`
- Modify: `app/(dashboard)/community/collections/[collectionId]/page.tsx:430-432`
- Modify: `app/(dashboard)/community/collections/page.tsx:377-379,464-466`
- Modify: `app/community/collections/shared/[slug]/page.tsx:38-48,141-142`
- Modify: `app/rides/shared/[token]/page.tsx:75-81`
- Modify: `app/trips/shared/[token]/page.tsx:105-107`
- Modify: `i18n/locales/en.ts`
- Tests: `app/(dashboard)/rides/_components/RidesTable.test.tsx` (total-rides label may pin), page tests that match

**Interfaces:**

- Consumes: `"{count, plural, one {# day} other {# days}}"` (Task 5), `"{count, plural, one {{n} view} other {{n} views}}"` / `"…{n} click…"` wording pattern (Task 4), `format` from `useFormat()` / `Formatters` where already present.
- Produces: the final plural-free state — the Step 4 grep gate is the task's acceptance criterion.

- [ ] **Step 1: Rewrite each site**

`app/(dashboard)/page.tsx:604` and `:610` (word-only unit chips; number renders separately in the bold span):

```tsx
{
  trip.num_days === 1 ? t("DAY") : t("DAYS");
}
```

→

```tsx
{
  t("{count, plural, one {DAY} other {DAYS}}", { count: trip.num_days });
}
```

```tsx
{
  trip.passes_count === 1 ? t("PASS") : t("PASSES");
}
```

→

```tsx
{
  t("{count, plural, one {PASS} other {PASSES}}", {
    count: trip.passes_count,
  });
}
```

`app/roads/best/[country]/page.tsx:63-65` (fragment concat collapses into the message):

```tsx
{
  regions.length;
}
{
  t("curated region");
}
{
  regions.length === 1 ? "" : "s";
}
```

→

```tsx
{
  t("{count, plural, one {# curated region} other {# curated regions}}", {
    count: regions.length,
  });
}
```

Spacing note (resolved): the old JSX puts each expression on its own line, and JSX drops whitespace-only text nodes containing a newline — so today these fragments render with NO separating space ("12curated regions"). The catalog entries `"curated region"` (en.ts:905) and `"region"` (en.ts:936) carry no padding either. The ICU rewrite intentionally fixes this to "12 curated regions" — list it under Visible changes; do not try to reproduce the missing space. Same on `app/roads/best/page.tsx:31-34`:

```tsx
{
  regionCount;
}
{
  t("region");
}
{
  regionCount === 1 ? "" : "s";
}
```

→

```tsx
{
  t("{count, plural, one {# region} other {# regions}}", {
    count: regionCount,
  });
}
```

(These two pages are the intentionally-raw dark-slate road pages — plural rewrite only, no other copy or style changes.)

`app/(dashboard)/settings/bikes/page.tsx:244-247` (unbounded → pre-formatted `n`):

```ts
const ridesLabel =
  typeof bike.totalRides === "number"
    ? `${format.integer(bike.totalRides)} ride${bike.totalRides === 1 ? "" : "s"}`
    : null;
```

→

```ts
const ridesLabel =
  typeof bike.totalRides === "number"
    ? t("{count, plural, one {{n} ride} other {{n} rides}}", {
        count: bike.totalRides,
        n: format.integer(bike.totalRides),
      })
    : null;
```

`app/(dashboard)/rides/_components/RidesTable.tsx:180-182` (was RAW `total` — now honest format-locale grouping, enumerate as visible change):

```tsx
{
  `${total} ride${total === 1 ? "" : "s"}`;
}
```

→

```tsx
{
  t("{count, plural, one {{n} ride} other {{n} rides}}", {
    count: total,
    n: format.integer(total),
  });
}
```

(`format` = the component's existing `useFormat()` binding; add it if the footer scope lacks it.)

`app/(dashboard)/rides/stats/page.tsx:963-966` (tooltip/title string, raw — wrap; per-day rides are bounded so `#` is fine):

```ts
const title =
  cell.rides === 0
    ? `${dayLabel}: no rides`
    : `${dayLabel}: ${cell.rides} ride${cell.rides === 1 ? "" : "s"}, ${format.distanceKm(cell.distanceKm)}`;
```

→

```ts
const title =
  cell.rides === 0
    ? t("{date}: no rides", { date: dayLabel })
    : t("{date}: {count, plural, one {# ride} other {# rides}}, {distance}", {
        date: dayLabel,
        count: cell.rides,
        distance: format.distanceKm(cell.distanceKm),
      });
```

Collections — three branch-pair sites unify on one key. `[collectionId]/page.tsx:430-432` and `collections/page.tsx:377-379` + `:464-466`:

```tsx
{
  collection.itemCount === 1
    ? t("1 route")
    : t("{count} routes", { count: collection.itemCount });
}
```

→

```tsx
{
  t("{count, plural, one {# route} other {# routes}}", {
    count: collection.itemCount,
  });
}
```

(adjust the receiver variable per site: `collection!.itemCount` at `[collectionId]:431`.)

`app/community/collections/shared/[slug]/page.tsx:141-142`:

```tsx
{
  detail.item_count;
}
{
  (" ");
}
{
  detail.item_count === 1 ? t("route") : t("routes");
}
```

→

```tsx
{
  t("{count, plural, one {# route} other {# routes}}", {
    count: detail.item_count,
  });
}
```

and the `generateMetadata` description at `:38-48` — this file's `generateMetadata` is a server context; resolve the locale the same way the root layout does (check `apps/companion/src/i18n/server.ts` for the exact export — `readLocale()` async or `getServerLocale()`), then:

```ts
description:
  detail.description ??
  t(
    "{count, plural, one {# curated route} other {# curated routes}} shared by {owner}",
    {
      count: detail.item_count,
      owner: detail.owner_name || t("a Tarmoto rider"),
    },
    locale,
  ),
```

(`t` accepts the explicit locale 3rd argument. If threading the locale here turns out to require reworking the whole metadata block, STOP and report DONE_WITH_CONCERNS proposing to defer this one site to PR 2's metadata task — do not build new machinery.)

`app/rides/shared/[token]/page.tsx:75-81` — reuse Task 4's view wording + the embed-click twin ("1 views" bug fixed; unbounded → pre-formatted; this page must have a `Formatters` binding — check for an existing `format`/`getServerFormatters` in the file and reuse it):

```tsx
{
  t("{count} views", { count: ride.view_count });
}
```

→

```tsx
{
  t("{count, plural, one {{n} view} other {{n} views}}", {
    count: ride.view_count,
    n: format.integer(ride.view_count),
  });
}
```

```tsx
{
  ride.embed_click_count === 1
    ? t("1 embed click")
    : t("{count} embed clicks", { count: ride.embed_click_count });
}
```

→

```tsx
{
  t("{count, plural, one {{n} embed click} other {{n} embed clicks}}", {
    count: ride.embed_click_count,
    n: format.integer(ride.embed_click_count),
  });
}
```

`app/trips/shared/[token]/page.tsx:105-107`:

```tsx
{
  summary.dayCount === 1
    ? t("1 day")
    : t("{count} days", { count: summary.dayCount });
}
```

→

```tsx
{
  t("{count, plural, one {# day} other {# days}}", {
    count: summary.dayCount,
  });
}
```

- [ ] **Step 2: Update the catalog**

Add (alphabetical; key === value):

```ts
  "a Tarmoto rider": "a Tarmoto rider",
  "{count, plural, one {# curated region} other {# curated regions}}":
    "{count, plural, one {# curated region} other {# curated regions}}",
  "{count, plural, one {# curated route} other {# curated routes}} shared by {owner}":
    "{count, plural, one {# curated route} other {# curated routes}} shared by {owner}",
  "{count, plural, one {# region} other {# regions}}":
    "{count, plural, one {# region} other {# regions}}",
  "{count, plural, one {# ride} other {# rides}}":
    "{count, plural, one {# ride} other {# rides}}",
  "{count, plural, one {# route} other {# routes}}":
    "{count, plural, one {# route} other {# routes}}",
  "{count, plural, one {DAY} other {DAYS}}":
    "{count, plural, one {DAY} other {DAYS}}",
  "{count, plural, one {PASS} other {PASSES}}":
    "{count, plural, one {PASS} other {PASSES}}",
  "{count, plural, one {{n} embed click} other {{n} embed clicks}}":
    "{count, plural, one {{n} embed click} other {{n} embed clicks}}",
  "{count, plural, one {{n} ride} other {{n} rides}}":
    "{count, plural, one {{n} ride} other {{n} rides}}",
  "{date}: no rides": "{date}: no rides",
  "{date}: {count, plural, one {# ride} other {# rides}}, {distance}":
    "{date}: {count, plural, one {# ride} other {# rides}}, {distance}",
```

Delete (grep-verify zero call sites for each, excluding `en.ts` itself): `"1 day"`, `"{count} day"`, `"{count} days"`, `"1 route"`, `"{count} routes"`, `"1 embed click"`, `"{count} embed clicks"`, `"{count} views"` (if registered), `"curated region"`, `"region"`, and the orphaned pair `"1 collection"`, `"{count} collections"` (pre-verified orphaned — grep to confirm).

- [ ] **Step 3: Run tests**

```bash
cd apps/companion && npx vitest run src/app/\(dashboard\)/rides/_components/RidesTable.test.tsx src/i18n/locales/catalog.test.ts && npx vitest run && npx tsc --noEmit
```

Expected: full suite PASS. RidesTable test may pin `"3 rides"` — output identical for <1000, so only an explicit large-number pin would change (update + report if so).

- [ ] **Step 4: The plural-hack gate (acceptance criterion)**

```bash
cd apps/companion
grep -rnE '=== 1 \? "" : "s"' src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'
grep -rn '{s}' src --include='*.ts' --include='*.tsx' | grep -v '\.test\.' | grep -v 'suggestion={s}'
grep -rnE '=== 1 \? t?\("' src --include='*.tsx' --include='*.ts' | grep -v '\.test\.'
```

Expected: all three EMPTY (the `suggestion={s}` exclusion is a JSX prop in `TripCollaborateModal.tsx:1117`, not a plural hack). Shared: `grep -rn '=== 1 ?' packages/shared/src --include='*.ts' | grep -v spec` must show only `formatJoinedLabel`'s legacy branch (the mobile contract) and `formatCount`'s unrelated logic — nothing else.

- [ ] **Step 5: Commit**

```bash
git diff --name-only | grep -E '\.(ts|tsx)$' | xargs npx prettier --write
git add -A apps/companion/src
git -c core.hooksPath=/dev/null commit -m "feat(companion): icu plurals for page counts and drop obsolete plural keys"
```

**Visible changes:** shared-ride page "1 views" → "1 view" and "N embed clicks/views" ≥1000 now group per format locale; rides-table footer total ≥1000 now groups (was raw digits); roads/best spacing must be byte-identical (verified in Step 1).

---

### Task 8: EN normalization + Motorways

**Files:**

- Modify: `apps/companion/src/i18n/locales/en.ts:72,117-118,231-232,546` (keys move to their new alphabetical slots)
- Modify: `apps/companion/src/app/(dashboard)/rides/road-map/page.tsx:581,584`
- Modify: `apps/companion/src/app/(dashboard)/settings/privacy/page.tsx:282,293`
- Modify: `apps/companion/src/components/TripPlannerMap.tsx:2782,2796`
- Modify: `apps/companion/src/components/TripPlannerMap.test.tsx:365,378,393`
- Modify: `apps/companion/src/app/(dashboard)/trips/planner/page.tsx:3204-3205`
- Modify: `apps/companion/src/app/(dashboard)/trips/planner/page.test.tsx:662,1152,1262,1424,1471,2583`
- Modify: `apps/companion/src/lib/planner/prefs.ts:197,217`
- Modify: `apps/companion/src/lib/planner/__tests__/prefs.test.ts:124`
- Modify: `apps/companion/e2e/tests/trip-planner.spec.ts:222,232`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: the exact copy set the PR body's ledger enumerates.

- [ ] **Step 1: Centre on me**

`en.ts:117-118`: rename both key AND value:

```ts
  "Centre on me": "Centre on me",
  "Centre on me ": "Centre on me ",
```

`road-map/page.tsx:581`: `title={t("Centre on me")}`; `:584`: `{t("Centre on me ")}`. Leave the file's PROSE COMMENTS mentioning "Center on me" (lines 147-567) unchanged or update them — comments are not copy; update them for consistency since the term they quote changed.

- [ ] **Step 2: Colour the route line**

`TripPlannerMap.tsx:2782`: `aria-label="Colour the route line by road quality"`; `:2796`: `aria-label="Colour the route line by surface"`. Update the three test pins in `TripPlannerMap.test.tsx:365,378,393` to the new spellings.

- [ ] **Step 3: Personalised recommendations**

`en.ts:546` key+value → `"Personalised recommendations ": "Personalised recommendations "`. `privacy/page.tsx:282`: `{t("Personalised recommendations ")}`; `:293`: `ariaLabel="Personalised recommendations consent"`. Then verify the API identifier is untouched:

```bash
grep -rn 'personalized_recommendations' apps/companion/src apps/backend/src packages/shared/src | grep -v test
```

Expected: the snake_case identifier appears unchanged wherever it did before (it must NOT be renamed).

- [ ] **Step 4: Delete the orphaned "Arrow color" entry**

```bash
grep -rn 'Arrow color' apps/companion/src --include='*.tsx' --include='*.ts' | grep -v locales/en.ts
```

Expected: empty (pre-verified). Delete the `en.ts:231-232` entry `"Delta column is B − A. Arrow color reflects whether higher values are better for that metric. "` entirely.

- [ ] **Step 5: Motorways**

- `planner/page.tsx:3204`: `label={t("Motorways")}`; `:3205`: `ariaLabel={t("Avoid motorways")}`.
- `en.ts:72`: delete `"Avoid highways "` (grep-verify no call site uses the trailing-space form) and add `"Avoid motorways": "Avoid motorways"` + `Motorways: "Motorways"` in alphabetical position.
- `lib/planner/prefs.ts:217`: `avoids.push("avoid motorways");` and update the doc comment at `:197` to `…avoid motorways +2`.
- `prefs.test.ts:124`: expected string → `"Maximum twisty · asphalt · Excellent only · avoid motorways +2"`.
- `planner/page.test.tsx`: `getByLabelText("Avoid highways")` → `"Avoid motorways"` (lines 662, 1424, 1471, 2583) and `getByLabelText(/avoid highways/i)` → `/avoid motorways/i` (lines 1152, 1262).
- `e2e/tests/trip-planner.spec.ts:232`: `page.getByLabel(/avoid highways/i)` → `/avoid motorways/i`; update the comment at `:222`.
- Do NOT touch `avoidHighways` / `avoid_highways` identifiers, URL params, store fields, or wire DTOs anywhere — grep after editing:

```bash
grep -rn 'avoid motorways\|Avoid motorways\|Motorways' apps/companion/src apps/companion/e2e --include='*.ts' --include='*.tsx' | grep -vE 'avoidHighways|avoid_highways'
```

and confirm `avoidHighways`/`avoid_highways` counts are unchanged vs `git diff` (identifier lines untouched).

- [ ] **Step 6: Run tests**

```bash
cd apps/companion && npx vitest run src/components/TripPlannerMap.test.tsx src/app/\(dashboard\)/trips/planner/page.test.tsx src/lib/planner/__tests__/prefs.test.ts src/i18n/locales/catalog.test.ts && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git diff --name-only | grep -E '\.(ts|tsx)$' | xargs npx prettier --write
git add -A apps/companion/src apps/companion/e2e
git -c core.hooksPath=/dev/null commit -m "feat(companion): normalise en copy to british english and motorways"
```

**Visible changes (the complete normalization ledger):** "Center on me"→"Centre on me" (2 forms), "Color the route line by road quality/surface"→"Colour …" (2 aria-labels), "Personalized recommendations"→"Personalised recommendations" (visible label + consent aria-label), orphaned "Arrow color" catalog entry deleted (never rendered), "Highways"→"Motorways" (checkbox label), "Avoid highways"→"Avoid motorways" (aria-label), "avoid highways +2"→"avoid motorways +2" (prefs summary line).

---

### Task 9: Registry/docs rewrite + catalog-completeness test

**Files:**

- Rewrite: `docs/process/i18n.md`
- Modify: `apps/companion/src/i18n/index.test.ts` (add completeness test)
- Modify: `apps/companion/src/i18n/locales/index.ts:4-11` (comment accuracy only)

**Interfaces:**

- Consumes: the Task-1 engine semantics (documented), `companionCatalogs`, `SUPPORTED_LOCALES`.
- Produces: the authoritative add-a-language checklist (spec §6).

- [ ] **Step 1: Add the completeness test**

Append to `apps/companion/src/i18n/index.test.ts` (inside the existing describe, using its imports plus `companionCatalogs` from `./locales`):

```ts
it("registers a companion catalog for every supported locale", () => {
  expect(Object.keys(companionCatalogs).sort()).toEqual(
    [...SUPPORTED_LOCALES].sort(),
  );
});

it("renders an ICU plural through the companion translator", () => {
  expect(
    translate("{count, plural, one {# day} other {# days}}", { count: 1 }),
  ).toBe("1 day");
  expect(
    translate("{count, plural, one {# day} other {# days}}", { count: 3 }),
  ).toBe("3 days");
});
```

Run: `cd apps/companion && npx vitest run src/i18n/index.test.ts` — expected PASS (en catalog exists; key registered in Task 5).

- [ ] **Step 2: Rewrite `docs/process/i18n.md`**

Replace the whole file with (verify every path/claim against the code before writing — especially `server.ts` export names and `LocaleSwitcher.tsx:22` hide behavior):

```markdown
# Internationalization

Tarmoto shares one i18n core across surfaces: the language registry,
locale resolution, and the ICU translation engine live in
`packages/shared/src/i18n.ts`. Each surface owns its own message catalog
and builds a translator over it with `makeTranslator`:

- **Companion UI** — catalogs in `apps/companion/src/i18n/locales/`,
  translator + React bindings in `apps/companion/src/i18n/`.
- **Backend email** — catalog in `apps/backend/src/modules/email/i18n/`,
  translator `translateEmail`. Recipient locale resolves from
  `users.language`.

English is the only registered locale today. The UI copy standard is
British English ("kilometres", "colour", "Motorways").

## The engine

`makeTranslator(catalogs)` looks a key up active-locale → English → the
raw key itself (companion keys ARE the English source text), then formats
with ICU MessageFormat (`intl-messageformat`):

- `{name}` placeholders, `{count, plural, one {# ride} other {# rides}}`,
  `{x, select, a {...} other {...}}`; `#` inside a plural renders the
  count.
- Plural rules follow the locale of the catalog that supplied the
  template — an English fallback string always pluralizes with English
  rules.
- Calls WITHOUT values return the template verbatim (no ICU parsing).
- A message that fails to parse or format degrades to the legacy
  `{placeholder}` substitution instead of throwing.
- Markup like `<strong>` is literal text (`ignoreTag`).
- Parsed messages are memoized module-wide (capped, cleared wholesale).

Pinned dependency note: `intl-messageformat` stays on the dual
CJS+ESM `^10.7` line until the workspace goes ESM (v11 is ESM-only and
breaks the backend CJS build).

## Authoring rules (companion)

- The English source text is the key: `t("Save changes")`. Register every
  key in `apps/companion/src/i18n/locales/en.ts` (key === value,
  alphabetical). `src/i18n/locales/catalog.test.ts` enforces that every
  entry parses as ICU and avoids `'{`, `'}`, `''`.
- Plurals: one ICU message per site — never `word{s}` hacks, `=== 1`
  ternaries, or split singular/plural keys. The selection argument is
  named `count` and every message has an `other` branch.
- Numbers a rider sees follow `preferences.format_locale`, NOT the UI
  language (see `docs/superpowers/specs/2026-07-16-companion-locale-formatting-design.md`).
  Use `#` only for counts that stay under 1,000; for unbounded counts pass
  `n: format.integer(value)` for display and the raw `count` for
  selection: `{count, plural, one {{n} ride} other {{n} rides}}`.
- No concatenated fragments — one key with placeholders.
- Pure helper functions take a translator as their LAST parameter
  (`LooseTranslate` from `@tarmoto/shared`), mirroring the `Formatters`
  threading convention.

## How the companion resolves the locale

1. Server: `apps/companion/src/i18n/server.ts` reads the `tarmoto-locale`
   cookie, then `Accept-Language`, then `DEFAULT_LOCALE`; the root layout
   applies it to `<html lang>` and `I18nProvider`.
2. Client: `LocaleSwitcher` POSTs `/api/locale` (which also PATCHes
   `users.language` for signed-in riders) and reloads. The switcher stays
   hidden while only one locale is registered.
3. Lookup: missing keys fall back to English, then to the key text.

## Adding a language (checklist)

Worked example: Czech (`cs`).

1. Create catalog modules
   `apps/companion/src/i18n/locales/cs.ts` exporting
   `Partial<TranslationCatalog>` — missing keys fall back to English, so
   partial catalogs ship safely.
2. Register it in `companionCatalogs`
   (`apps/companion/src/i18n/locales/index.ts`).
3. Add `cs: { label: "Čeština" }` to `LOCALES` in
   `packages/shared/src/i18n.ts`. This single edit:
   - un-hides the Settings → Language switcher (it renders only when
     more than one locale is registered),
   - activates `<html lang>`, the `/api/locale` bridge, and
     `users.language` validation for `cs`,
   - makes backend email resolve `cs` recipients — email catalogs fall
     back to English key-by-key until translated, so no email work is
     required up front.
4. Run the guards: the companion catalog-completeness test
   (`src/i18n/index.test.ts`) now requires the `cs` entry from step 2,
   and `catalog.test.ts` validates the new catalog's ICU syntax. The
   Czech-shaped engine tests in `packages/shared/src/i18n.spec.ts`
   already prove one/few/other plural handling.
5. Translate: work through `en.ts` (and per-domain modules once the
   catalog is split) — plural messages must be rewritten with the target
   language's plural branches, not word-for-word.

## Server vs. client translation

(keep the existing "Server vs. client translation" + "Strict per-request
isolation on the server" sections verbatim from the previous revision —
they are still accurate.)
```

Copy the final two sections verbatim from the current file (lines 94-127) — verify their claims (`readLocale`, `getServerLocale`, `React.cache`) against `apps/companion/src/i18n/server.ts` while doing so; fix any drift you find and note it in the report.

- [ ] **Step 3: Fix the locales/index.ts comment**

`apps/companion/src/i18n/locales/index.ts:4-11` — the comment is already accurate about the two-step registration; extend its last line to mention the completeness test:

```ts
// Missing keys fall back to English automatically. Register the language's
// label in the shared `LOCALES` registry (@tarmoto/shared/i18n) — the
// completeness test in ../index.test.ts fails until both edits are made.
```

- [ ] **Step 4: Run + commit**

```bash
cd apps/companion && npx vitest run src/i18n && npx tsc --noEmit
npx prettier --write docs/process/i18n.md apps/companion/src/i18n/index.test.ts apps/companion/src/i18n/locales/index.ts
git add docs/process/i18n.md apps/companion/src/i18n
git -c core.hooksPath=/dev/null commit -m "docs(cross): rewrite i18n guide for the icu engine and add-a-language checklist"
```

**Visible changes:** none (docs + tests).

---

## Final validation (before the whole-branch review)

```bash
pnpm --filter @tarmoto/shared build && pnpm --filter @tarmoto/shared test
cd apps/backend && npx jest --testPathPatterns 'templates.snapshot|catalog-icu'   # 45 snapshots byte-identical
cd apps/companion && npx vitest run && npx tsc --noEmit && npx eslint src
cd apps/companion && npx playwright test   # e2e incl. the motorways label change
git diff main --stat   # inspect for accidental churn; en.ts should show adds/deletes only where tasks say
```

Backend full suite (`cd apps/backend && npx jest`) and backend lint (`pnpm --filter @tarmoto/backend lint`) once at the end — shared changed under it.

**PR body ledger (collect from each task's "Visible changes"):** the ~12 intended copy changes (normalization + Motorways set), the two plural bug fixes ("1 views"→"1 view", "1 rider passes"→"1 rider pass"), and the ≥1000-count grouping honesty notes (rides-table footer, embed views/clicks). Everything else must be byte-identical English.
