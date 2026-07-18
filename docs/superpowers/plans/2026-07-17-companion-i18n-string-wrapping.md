# Companion i18n String Wrapping (PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every remaining user-facing English string that bypasses `t()` through the translator (pure libs, SEO metadata, table/tile/legend/pill labels, validation messages, toasts, aria/placeholder/alt/title props), so shipping language N+1 is a content task — PR 2 of the i18n-readiness spec (`docs/superpowers/specs/2026-07-17-companion-i18n-readiness-design.md`, §3).

**Architecture:** Pure `.ts` libs receive a `LooseTranslate` threaded as their LAST parameter (the convention Epic 1 established for `Formatters` and PR 1 extended to `formatDaysRemaining`); label constants either become translated at the render site (where `t` is already in scope) or the lib translates them internally. `generateMetadata` functions resolve the request locale via `readLocale()` and pass it as the explicit 3rd arg to every `t()` call. Every wrapped string is registered in `en.ts` (same discipline as PR 1). English output stays byte-identical except two stray plural-hacks that become ICU plurals.

**Tech Stack:** TypeScript strict, `intl-messageformat` (already live in the shared translator), `t`/`LooseTranslate` from `@tarmoto/shared` + companion `@/i18n`, `readLocale()` from `@/i18n/server`, vitest, Next.js App Router.

## Global Constraints

Every task implicitly includes these.

1. **Branch:** work on `feat/i18n-string-wrapping` (already created off the merged PR-1 main; you are on it — do NOT branch).
2. **English byte-identical** except the two enumerated plural-copy sites (C1 "Moved N folders…", D18 "Force N days") whose count=1/other rendering is unchanged in English anyway. If a test pins output this plan doesn't list as changing, the code is wrong, not the test.
3. **`t` is importable in plain `.ts`** as `import { t } from "@/i18n";` (already used this way in `lib/road-map-share.ts`) and takes `(key, values?, locale?)`. Libs that must stay locale-parameterizable take a `LooseTranslate` param instead of importing `t` — see per-task guidance.
4. **Translator threads as the LAST parameter** of a lib function, after any existing `Formatters` param (e.g. `formatMilestoneLabel(progress, format, t)`). This mirrors `formatDaysRemaining(endsAt, now, t)` and the `Formatters` threading convention. A required `t` may NOT follow an optional param — reorder or make prior params required as PR 1 did for `formatDaysRemaining`.
5. **PR 2 registers every key it wraps** in `apps/companion/src/i18n/locales/en.ts`: key === value, character-identical to the call-site literal, alphabetical insertion, and (for ICU messages) plural selection named `count` with an `other` branch. This keeps `catalog.test.ts` green. (The spec's "PR 3 backfills all missing keys" then means the pre-existing ~675 legacy raw-key-fallback strings, not what PR 2 wraps — a deliberate reading, consistent with how PR 1 registered as it went.)
6. **`generateMetadata` locale rule:** inside any `generateMetadata`, call `const locale = await readLocale();` and pass `locale` as the explicit 3rd arg to EVERY `t()` call reached from that function, including nested fallbacks (`t("a Tarmoto rider", undefined, locale)`). The module-global default is unsafe there — Next may resolve metadata outside the render that sets it. Reference: `community/collections/shared/[slug]/page.tsx` generateMetadata (already wired).
7. **Documented exclusions (do NOT wrap):**
   - `app/global-error.tsx` — stays hardcoded English with no `t` import; the i18n providers are dead when it renders (spec §3). D49 "Something skidded out" is NOT wrapped.
   - Numeric/notation strings: lean-degree ranges ("0–10°" etc.), example placeholder "2024", `"/5"`, `"°"`, math signs, SVG path letters.
   - Attribution/brand tooltips: "© OpenStreetMap contributors", "© Foursquare", "OpenStreetMap + Foursquare", "OpenStreetMap", "Tarmoto data", "Visa" — canonical attribution/brand text, kept invariant.
   - Machine values: enum/union values, Record keys, API field names, icon names, CSS classes, URL/canonical paths, `robots`/`revalidate`/`dynamic` config, ISO timestamps, error CODES (`social_account_conflict`), the `SOCIAL_ACCOUNT_CONFLICT_MESSAGE` CONSTANT (it is a cross-module `===` sentinel — translate only at the render boundary), `humanizeRewardBadgeKey` output (dynamic backend text, no fixed catalog key), and `exploration.ts` `formatDistance` (pinned Epic-1 exclusion).
   - Intentionally-dead test-fixture code: `buildDemoSnapshot` (gamification.ts), `buildShareSummary` + `groupUnriddenByRegion` (exploration.ts) — their strings render to no rider (comments confirm they are typed fixtures). Left raw; NOT wrapped, NOT deleted.
8. **Unit correctness:** where an aria-label bakes a unit ("…{max}m"), route the value through the existing `Formatters` (`format.elevation(...)`) instead of hardcoding the unit in the catalog message, so both i18n and the rider's metric/imperial preference are honoured (D31).
9. **Stray plural-hacks → ICU:** C1 and D18 are singular/plural ternaries the PR-1 grep gates (`{s}`, `=== 1 ? "" : "s"`) did not match. Convert them to ICU plural messages (`{count, plural, one {…} other {…}}`), same as PR 1.
10. **Stale-dist gotcha:** nothing in PR 2 changes `packages/shared`; but if a task's tsc picks up stale `.next/dev/types`, delete `.next/dev/types` and re-run (those are generated route validators, not source errors).
11. **Commits:** conventional `<type>(<scope>): <lowercase subject>`, scope `companion`. Git hooks are unusable in this environment — run `npx prettier --write <touched files>` before staging, commit with `git -c core.hooksPath=/dev/null commit`. The fsmonitor daemon has been known to wedge `git status`/`log` here; if a git command hangs, prefix with `git -c core.fsmonitor=false`.
12. **Test commands:** companion vitest → `cd apps/companion && npx vitest run <file>` (`pnpm test -- <name>` does NOT filter); typecheck → `npx tsc --noEmit` (delete `.next/dev/types` first if it errors on deleted routes; CI typechecks test files too); lint → `npx eslint src`; catalog guard → `npx vitest run src/i18n/locales/catalog.test.ts`. Use the Bash tool's `dangerouslyDisableSandbox: true` if a process is SIGKILLed (exit 137).
13. **Scope discipline:** no drive-by refactors beyond wrapping + registering. EXCEPTION: a lib function whose raw strings you are wrapping may have adjacent raw strings in the same function converted together (constraint mirrors PR 1's PassesPanel rule). Do not restructure unrelated code.

## Authoritative string inventories

Three committed inventory files hold the exhaustive, line-referenced string lists (audited at branch base `99bd7a55`). Each task names the inventory + section that is its complete checklist; the tables embedded in the tasks below are the same data in summary. **The committed inventory is authoritative** — a task is done only when every string in its inventory section is wrapped AND its acceptance grep returns empty. Locate each site by its quoted string, not the line number (anchors may drift).

- `docs/superpowers/plans/2026-07-17-pr2-inventory-purelibs.md` — Tasks 1–4 (per-file tables, exclude lists, exact new signatures)
- `docs/superpowers/plans/2026-07-17-pr2-inventory-metadata.md` — Tasks 5–6 (per-file metadata strings, the reference `generateMetadata`, the ISR caveat, the test pattern)
- `docs/superpowers/plans/2026-07-17-pr2-inventory-components.md` — Tasks 7–10 (Buckets A/B/C/D, one row per site with render-binding + wrap approach)

The inventories occasionally suggest options the plan has since decided (e.g. MONTH_NAMES via Formatters, or wrapping dead fixtures) — where an inventory note conflicts with this plan's Global Constraints or a task's stated decision, **the plan governs**.

## File Structure

- `src/lib/gamification.ts` (T1), `subscription.ts` (T2), `ride-compare.ts`+`closures-summary.ts` (T3), `passes-summary.ts`+`exploration.ts`+`auth-errors.ts` (T4) — pure-lib wrapping + threaded callers
- 10 metadata sites across `src/app/**` (T5 dynamic share pages, T6 roads/best + static layouts)
- Bucket A label constants/arrays (T7 tables/tiles, T8 filters/legends/config) across `rides`/`explore`/`planner`/`lib/utils`/`lib/planner`
- Bucket B validation (`lib/bikes.ts`/`trip-folders.ts`/`route-collections.ts`) + Bucket C toasts (T9)
- Bucket D props (T10) across many components/pages
- `src/i18n/locales/en.ts` — every task adds keys

---

### Task 1: Wrap `gamification.ts` (24 live strings)

**Files:**

- Modify: `src/lib/gamification.ts`
- Modify: `src/app/(dashboard)/achievements/page.tsx` (caller — thread `t` into `buildLiveSnapshot`/`labelForDimension`/`formatMilestoneLabel`; it already imports `t`)
- Modify: `src/i18n/locales/en.ts`
- Test: `src/lib/__tests__/gamification.test.ts`

**Interfaces:**

- Consumes: `LooseTranslate` (already imported in gamification.ts).
- Produces: new signatures — `formatMilestoneLabel(progress, format, t)`, `unitForChallengeMetric(metric, t)`, `mapChallengeDto(dto, myProgress, t)`, `buildLiveSnapshot(input, t)`, `labelForDimension(dim, t)`. Task 3/others do not depend on these.

**Strings to wrap (all live-reachable):**

| Line    | String                                                                  | Where                                                                                                       |
| ------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 254     | `Maxed at {value}` (was `` `Maxed at ${format.distanceKm(...)}` ``)     | `formatMilestoneLabel` — pass `value: format.distanceKm(progress.current)`                                  |
| 258     | `{current} / {target} {unit}`                                           | `formatMilestoneLabel`                                                                                      |
| 262     | `Maxed at {value} {unit}`                                               | `formatMilestoneLabel`                                                                                      |
| 264     | `{current} / {target} {unit}` (integer variant — reuse the 258 key)     | `formatMilestoneLabel`                                                                                      |
| 302-304 | `km`, `roads`, `reports`                                                | `MILESTONE_UNITS` — translate at use inside `formatMilestoneLabel`: `t(MILESTONE_UNITS[metric])`            |
| 317,318 | `Distance Traveller`, `Cumulative kilometres ridden across every bike.` | `DEFAULT_MILESTONES` name/description                                                                       |
| 323,325 | `Road Cartographer`, `Unique roads you were first to map.`              | same                                                                                                        |
| 330,332 | `Hazard Hunter`, `Confirmed hazards reported to the community.`         | same                                                                                                        |
| 525-531 | `km`,`km`,`rides`,`roads`,`reviews`,`reports`,`rides`                   | `UNIT_BY_METRIC` — translate at use inside `unitForChallengeMetric`: `t(UNIT_BY_METRIC[metric] ?? "units")` |
| 535     | `units` (fallback)                                                      | `unitForChallengeMetric`                                                                                    |
| 673-675 | `Distance`, `Roads discovered`, `Hazards reported`                      | `DIMENSION_LABELS` — translate in `labelForDimension`: `t(DIMENSION_LABELS[dim])`                           |

**Approach:** Keep the constant maps (`MILESTONE_UNITS`, `UNIT_BY_METRIC`, `DIMENSION_LABELS`, `DEFAULT_MILESTONES`) as canonical English-keyed data. Thread `t` into the functions that READ them and wrap at the read: `t(MILESTONE_UNITS[metric])`, `t(DIMENSION_LABELS[dim])`. For `DEFAULT_MILESTONES` (name/description objects consumed as `Milestone.name`/`.description`), the cleanest fix is to translate at the achievements-page render site if it maps milestones to JSX, OR translate inside `buildLiveSnapshot` when it produces the snapshot — inspect `buildLiveSnapshot` and the achievements page and choose the single site where each milestone's name/description is first rendered; wrap there. EXCLUDE `buildDemoSnapshot` (dead fixture), `humanizeRewardBadgeKey` (dynamic), and every machine value in the audit's exclude list.

- [ ] **Step 1: Read the current code + verify the caller chain**

Read `src/lib/gamification.ts` fully and `src/app/(dashboard)/achievements/page.tsx` where it calls `buildLiveSnapshot`, `labelForDimension`, `formatMilestoneLabel`. Confirm each is reached from the page (the audit verified this) and that `t` is in scope there.

- [ ] **Step 2: Write/extend the failing test**

In `src/lib/__tests__/gamification.test.ts`, add a describe that builds a real translator over an `en`-style catalog containing the new keys and asserts English output is unchanged, e.g.:

```ts
import { makeTranslator } from "@tarmoto/shared";
const t = makeTranslator<string>({
  en: {
    Distance: "Distance",
    "Roads discovered": "Roads discovered",
    "Hazards reported": "Hazards reported",
    km: "km",
    roads: "roads",
    reports: "reports",
    rides: "rides",
    reviews: "reviews",
    units: "units",
    "{current} / {target} {unit}": "{current} / {target} {unit}",
    "Maxed at {value}": "Maxed at {value}",
    "Maxed at {value} {unit}": "Maxed at {value} {unit}",
  },
});
it("labelForDimension returns English via the translator", () => {
  expect(labelForDimension("total_distance_km", t)).toBe("Distance");
});
it("unitForChallengeMetric returns English via the translator", () => {
  expect(unitForChallengeMetric("total_distance", t)).toBe("km");
});
```

Run: `cd apps/companion && npx vitest run src/lib/__tests__/gamification.test.ts` → FAIL (arity/type errors).

- [ ] **Step 3: Thread `t` and wrap**

Change the five signatures (t last), wrap each string per the table, update the mapper chain so `buildLiveSnapshot` passes `t` down to `mapChallengeDto`→`unitForChallengeMetric`. Update the achievements-page caller to pass `t`. Register all keys in `en.ts` (alphabetical, key===value).

- [ ] **Step 4: Run the covering tests + catalog guard + tsc**

```bash
cd apps/companion && npx vitest run src/lib/__tests__/gamification.test.ts src/i18n/locales/catalog.test.ts && npx tsc --noEmit
```

Expected: PASS. Also run the achievements page test if one exists (`npx vitest run achievements`); English output must be identical.

- [ ] **Step 5: Acceptance grep + commit**

```bash
# every non-excluded English label in the live functions is now inside t(...)
grep -nE '"(Distance Traveller|Road Cartographer|Hazard Hunter|Distance|Roads discovered|Hazards reported)"' src/lib/gamification.ts
```

Expected: matches appear only inside the constant maps (data), never as a raw return/JSX value. Then:

```bash
git diff --name-only | grep -E '\.(ts|tsx)$' | xargs npx prettier --write
git add -A src/lib/gamification.ts "src/app/(dashboard)/achievements/page.tsx" src/lib/__tests__/gamification.test.ts src/i18n/locales/en.ts
git -c core.hooksPath=/dev/null commit -m "feat(companion): route gamification labels through the translator"
```

**Visible changes:** none (English identical).

---

### Task 2: Wrap `subscription.ts` (45 strings)

**Files:**

- Modify: `src/lib/subscription.ts`
- Modify: `src/app/(dashboard)/settings/subscription/page.tsx` (and any other caller of the wrapped exports — grep `from "@/lib/subscription"`)
- Modify: `src/i18n/locales/en.ts`
- Test: `src/lib/__tests__/subscription.test.ts` (create if absent)

**Interfaces:**

- Produces: `buildFallbackSubscriptionSnapshot(t)`, `normalizeSubscriptionSnapshot(raw, t)`, `tierLabel(tier, t)`, `planActionLabel(planTier, currentTier, t)`, `describeRenewal(plan, format, t)`, `formatPaymentMethodLabel(pm, t)`, `formatPaymentMethodExpiry(pm, t)`, `invoiceStatusLabel(status, t)` (+ internal `normalizePlans`/`normalizeInvoices`/`buildPlanFromCurrent`/`titleCase` gain `t`).

**Full checklist:** `docs/superpowers/plans/2026-07-17-pr2-inventory-purelibs.md` §2 (45 rows + exclude list + the exact new signatures) — READ IT; it is the authoritative list. Summary of the 45: plan features (`DEFAULT_PLAN_FEATURES` free/pro/premium + the `buildFallbackSubscriptionSnapshot` free/pro/premium feature lists + plan names), `tierLabel` (`Pro`/`Premium`/`Free`), `planActionLabel` (`Current plan`/`Upgrade`/`Downgrade`), `describeRenewal` (`soon`, `Downgrades {date}`, `Trial ends {date}`, `Canceled`, `Access ends {date}`, `Renews {date}`, `Billing cycle managed in the portal`), `formatPaymentMethodLabel` (`{brand} ending in {last4}`), `formatPaymentMethodExpiry` (`Expires {mm}/{yyyy}`), `invoiceStatusLabel` (`Open`/`Refunded`/`Paid`), `normalizeInvoices` (`Unavailable`), `titleCase` (`Card`). EXCLUDE all enum/status/tier values, ISO timestamps, ids, protocol strings, and `"Visa"` (brand).

**Approach:** This file has ZERO `t` today but already threads `Formatters` through two functions — the plumbing pattern is established. Thread `t` through the normalize chain: `normalizeSubscriptionSnapshot(raw, t)` passes `t` to `buildFallbackSubscriptionSnapshot`, `normalizePlans`, `tierLabel`. Convert the interpolated returns to ICU messages (`` `Renews ${date}` `` → `t("Renews {date}", { date })`). For `{mm}/${yyyy}` keep the slash in the message (`Expires {mm}/{yyyy}`).

- [ ] **Step 1: Read + map callers**

Read `subscription.ts` fully; `grep -rn 'from "@/lib/subscription"' src` to find every caller and confirm each has `t` available (or can get it). The subscription settings page is the primary consumer.

- [ ] **Step 2: Failing test**

Create/extend `src/lib/__tests__/subscription.test.ts`: build a real translator over the new keys, assert `tierLabel("pro", t) === "Pro"`, `planActionLabel("premium","free",t) === "Upgrade"`, `describeRenewal(<active plan>, format, t)` renders `Renews <date>`, `invoiceStatusLabel("open", t) === "Open"`. Run → FAIL.

- [ ] **Step 3: Thread + wrap + register**

Apply the 45 wraps, thread `t` through all listed signatures, update callers, register all keys (alphabetical, key===value; the `{date}`/`{mm}`/`{yyyy}`/`{brand}`/`{last4}` messages register verbatim).

- [ ] **Step 4: Verify**

```bash
cd apps/companion && npx vitest run src/lib/__tests__/subscription.test.ts src/i18n/locales/catalog.test.ts && npx vitest run subscription && npx tsc --noEmit
```

Expected: PASS; subscription page test (if any) English-identical.

- [ ] **Step 5: Acceptance grep + commit**

```bash
grep -nE '"(Basic navigation|Unlimited trip planning|Current plan|Upgrade|Downgrade|Renews|Paid|Refunded|Open)"' src/lib/subscription.ts
```

Expected: bare literals appear only inside data constants; every rendered/returned label is inside `t(...)`. Commit:

```bash
git -c core.hooksPath=/dev/null commit -m "feat(companion): route subscription plan and billing copy through the translator"
```

**Visible changes:** none.

---

### Task 3: Wrap `ride-compare.ts` (15) + `closures-summary.ts` (3)

**Files:**

- Modify: `src/lib/ride-compare.ts`, `src/lib/closures-summary.ts`
- Modify: callers — `src/app/(dashboard)/rides/compare/page.tsx` (calls `computeStatRows`), `src/app/(dashboard)/trips/planner/page.tsx` + `trips/[tripId]/page.tsx` + `components/TripPlannerMap.tsx` (call `buildTripClosureRoutes`), `components/ClosuresPanel.tsx` + `components/map/MapPointPopover.tsx` (call `formatClosureWindow`)
- Modify: `src/i18n/locales/en.ts`
- Test: `src/lib/__tests__/ride-compare.test.ts`, `src/lib/__tests__/closures-summary.test.ts` (create if absent)

**Interfaces:**

- Produces: `computeStatRows(a, b, t)`, `buildTripClosureRoutes(trip, t)`, `formatClosureWindow(closure, format, t)`.

**ride-compare STAT_DEFS (15):** labels `Distance`/`Duration`/`Avg speed`/`Max speed`/`Elevation gain`/`Elevation loss`/`Avg road quality`/`Curve count`/`Max lean`; units `km`/`min`/`km/h`(×2)/`m`(×2). Thread `t` into `computeStatRows(a,b,t)` and translate `STAT_DEFS[i].label`/`.unit` inline when building each row. EXCLUDE `StatRow.key`, `/5`, `°`, delta symbols, `improved`/`regressed`/`neutral`.

**closures-summary (3):** `Day {dayNumber} · {title}` and `Day {dayNumber}` (`buildTripClosureRoutes`), and `{date} onward` (`formatClosureWindow`). EXCLUDE severity enum, the `RangeError` message, the `day-{n}` id.

- [ ] **Step 1: Read + failing tests**

Read both libs + their render sites (verify `row.label`/`row.unit` render raw at `compare/page.tsx`, and the closure label/window sites). Write unit tests: `computeStatRows(a, b, t)` first row `.label === "Distance"`, `.unit === "km"`; `buildTripClosureRoutes(trip, t)[0].label === "Day 1 · <title>"`; `formatClosureWindow(closure, format, t)` contains "onward" for the open-ended case. Run → FAIL.

- [ ] **Step 2: Wrap + thread + register + update callers**

`computeStatRows`: `label: t(def.label), unit: def.unit ? t(def.unit) : undefined`. `buildTripClosureRoutes`: `t("Day {dayNumber} · {title}", { dayNumber, title })` / `t("Day {dayNumber}", { dayNumber })`. `formatClosureWindow`: `t("{date} onward", { date: format.calendarDate(...) })`. Update every caller to pass `t`. Register keys.

- [ ] **Step 3: Verify + acceptance + commit**

```bash
cd apps/companion && npx vitest run src/lib/__tests__/ride-compare.test.ts src/lib/__tests__/closures-summary.test.ts src/i18n/locales/catalog.test.ts && npx vitest run compare ClosuresPanel && npx tsc --noEmit
grep -nE '"(Avg speed|Elevation gain|Curve count|Max lean)"|onward' src/lib/ride-compare.ts src/lib/closures-summary.ts
```

Expected: PASS; bare labels only in `STAT_DEFS` data. Commit:

```bash
git -c core.hooksPath=/dev/null commit -m "feat(companion): route ride-compare and closure labels through the translator"
```

**Visible changes:** none.

---

### Task 4: `passes-summary` MONTH_NAMES (12) + `exploration` TIME_PERIOD_LABELS (4) + `auth-errors` (2)

**Files:**

- Modify: `src/components/PassesPanel.tsx` (render-site wrap of `MONTH_NAMES.map`), `src/components/ClosuresPanel.tsx` (`monthLabel` caller) — and `src/lib/passes-summary.ts` if `monthLabel` is threaded
- Modify: `src/app/rides/road-map/shared/[token]/page.tsx` (render-site wrap of `TIME_PERIOD_LABELS`)
- Modify: `src/lib/auth-errors.ts` + `src/app/(auth)/login/LoginForm.tsx` (caller)
- Modify: `src/i18n/locales/en.ts`
- Test: `src/lib/__tests__/auth-errors.test.ts` (create if absent); `src/components/PassesPanel.test.tsx` if it pins month text

**Interfaces:**

- Produces: `getLoginErrorMessage(errorCode, t)`. `MONTH_NAMES` and `TIME_PERIOD_LABELS` stay canonical English arrays/maps, wrapped at render sites.

**Decisions locked (per plan header):**

- MONTH_NAMES → `t()` (UI language), NOT `Formatters.month()` — a month PICKER is UI chrome bound to `users.language`, not `format_locale`; Epic 1 pinned the month selector as translated-copy. Wrap at the render sites which already import `t`: `MONTH_NAMES.map((name, idx) => ({ value: idx + 1, label: t(name) }))` and `monthLabel(m)` render site `t(monthLabel(m))` (or thread `t` into `monthLabel`).
- `SOCIAL_ACCOUNT_CONFLICT_MESSAGE` stays the raw English constant (it is a `===` sentinel in `auth.ts`/`social-auth-bridge.ts`). Wrap ONLY at the return: `getLoginErrorMessage` returns `t(SOCIAL_ACCOUNT_CONFLICT_MESSAGE)` and `t("We couldn't complete social sign-in. Try again or use your password.")`.
- exploration.ts: wrap ONLY the 4 live `TIME_PERIOD_LABELS` values at the road-map share render site (`t(TIME_PERIOD_LABELS[snapshot.period])`). Leave the dead `buildShareSummary`/`groupUnriddenByRegion` strings raw (documented exclusion).

**Strings:** MONTH_NAMES `January…December` (12); TIME_PERIOD_LABELS `All time`/`This year`/`Last 90 days`/`Last 30 days` (4); auth `This email already has a Tarmoto password account. Sign in with your password instead.` + `We couldn't complete social sign-in. Try again or use your password.` (2).

- [ ] **Step 1: Failing test (auth-errors) + read render sites**

Test: `getLoginErrorMessage("social_account_conflict", t)` returns the password-account message; `getLoginErrorMessage("social_signin_failed", t)` returns the social-fail message; `getLoginErrorMessage(null, t) === ""`. Run → FAIL. Read the PassesPanel/ClosuresPanel/road-map-share render sites to confirm `t` is imported.

- [ ] **Step 2: Wrap all three + register**

Thread `t` into `getLoginErrorMessage`; update `LoginForm.tsx` (already has `const { t } = useI18n()`). Wrap MONTH_NAMES + TIME_PERIOD_LABELS at render sites. Register the 18 keys (12 months + 4 periods + 2 auth). NOTE: `All time`/`This year`/`Last 90 days`/`Last 30 days` may already be registered by PR 1 (grep `en.ts` first; keep existing).

- [ ] **Step 3: Verify + acceptance + commit**

```bash
cd apps/companion && npx vitest run src/lib/__tests__/auth-errors.test.ts src/components/PassesPanel.test.tsx src/i18n/locales/catalog.test.ts && npx tsc --noEmit
grep -n 'MONTH_NAMES' src/components/PassesPanel.tsx   # confirm the .map wraps label in t()
```

Expected: PASS; the constant `SOCIAL_ACCOUNT_CONFLICT_MESSAGE` in auth-errors.ts is UNCHANGED (only the return wraps it). Commit:

```bash
git -c core.hooksPath=/dev/null commit -m "feat(companion): wrap month, time-window and login-error copy"
```

**Visible changes:** none.

---

### Task 5: Dynamic share-page metadata (4 pages)

**Files:**

- Modify: `src/app/rides/shared/[token]/page.tsx`, `src/app/rides/road-map/shared/[token]/page.tsx`, `src/app/trips/shared/[token]/page.tsx` (each: 2 raw strings in `generateMetadata`), `src/app/community/collections/shared/[slug]/page.tsx` (2 raw titles; description already wrapped)
- Modify: `src/i18n/locales/en.ts`
- Test: create `src/app/rides/shared/[token]/metadata.test.ts` (or one shared metadata test) mirroring `roads/best/metadata.test.ts`

**Interfaces:** consumes `readLocale` from `@/i18n/server`, `t` from `@/i18n`. All four pages run `dynamic = "force-dynamic"` (safe for `readLocale()`).

**Strings:**

| File                                | Raw metadata strings                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| rides/shared/[token]                | `Shared ride — Tarmoto`, `Public Tarmoto shared ride page.`                                               |
| rides/road-map/shared/[token]       | `Shared road map — Tarmoto`, `Public Tarmoto personal road map.`                                          |
| trips/shared/[token]                | `Shared trip — Tarmoto`, `Public Tarmoto shared trip page.`                                               |
| community/collections/shared/[slug] | `{title} — Tarmoto collection` (found; `title` = `detail.title` data), `Collection — Tarmoto` (not-found) |

**Approach:** In each `generateMetadata`, add `const locale = await readLocale();` and wrap: `title: t("Shared ride — Tarmoto", undefined, locale)`, `description: t("Public Tarmoto shared ride page.", undefined, locale)`. For collections: `title: t("{title} — Tarmoto collection", { title: detail.title }, locale)` (found) and `t("Collection — Tarmoto", undefined, locale)` (not-found). Leave `robots` untouched.

- [ ] **Step 1: Write the regression-pin test**

These 4 pages are a transparency refactor — English output is unchanged, so this is a regression pin, not a red-green cycle. Create a metadata test that imports each page's `generateMetadata`, calls it (with a mocked `params` promise where the signature needs one), and asserts the exact English `title`/`description` these pages already produce (e.g. `expect((await generateMetadata()).title).toBe("Shared ride — Tarmoto")`). Run it now — it passes against the current raw strings. After Step 2 it must STILL pass, proving the `readLocale()`+`t()` wrap returns byte-identical English. Additionally add one locale-follows-cookie assertion using the real translator: since only `en` is registered, assert the output equals the English string for the default locale (a full non-English assertion is out of scope until a locale ships).

- [ ] **Step 2: Wire `readLocale()` + `t` in all four**

Apply the wraps. Register keys (the 3 share pages' 6 strings + `{title} — Tarmoto collection` + `Collection — Tarmoto`).

- [ ] **Step 3: Verify + commit**

```bash
cd apps/companion && npx vitest run <the metadata test> src/i18n/locales/catalog.test.ts && npx tsc --noEmit
```

Expected: PASS (English identical). Commit:

```bash
git -c core.hooksPath=/dev/null commit -m "feat(companion): localise dynamic share-page metadata"
```

**Visible changes:** none.

---

### Task 6: roads/best metadata + static-layout conversions

**Files:**

- Modify: `src/app/roads/best/[country]/page.tsx`, `.../[region]/page.tsx`, `.../[region]/[subregion]/page.tsx` (title + imageAlt templates)
- Modify: `src/app/layout.tsx`, `src/app/explore/layout.tsx`, `src/app/roads/best/layout.tsx` — convert static `export const metadata` → `export async function generateMetadata()` routing through `readLocale()`+`t()`
- Modify: `src/i18n/locales/en.ts`
- Test: extend `src/app/roads/best/metadata.test.ts`

**Interfaces:** consumes `readLocale`, `t`. The 3 roads/best pages run `revalidate = 604800` (ISR).

**Strings:**

| File                                      | Strings                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| roads/best/[country]                      | `Best motorcycle roads in {name} — Tarmoto` (title), `Ranked lists of the top-rated motorcycle roads in {name}, scored by quality and curviness.` (description), `Best motorcycle roads in {name}` (imageAlt) |
| roads/best/[country]/[region]             | `Best motorcycle roads in {name} — Tarmoto` (title, reuse key), `Best motorcycle roads in {name}` (imageAlt, reuse key); `description = r.description` is DATA — EXCLUDE                                      |
| roads/best/[country]/[region]/[subregion] | same two reused keys; `r.description` EXCLUDE                                                                                                                                                                 |
| layout.tsx (root)                         | `Tarmoto` (title), `Know the road before you ride it` (description)                                                                                                                                           |
| explore/layout.tsx                        | `Road Quality Explorer — Tarmoto`, the explorer description, `Tarmoto` (siteName)                                                                                                                             |
| roads/best/layout.tsx                     | `Best Motorcycle Roads — Tarmoto`, the best-roads description, `Tarmoto` (siteName)                                                                                                                           |

**ISR caveat (document in the commit body + a code comment):** under weekly background regen, `readLocale()` has no request context and falls back to `DEFAULT_LOCALE`, so these pages serve English metadata regardless of visitor until locale-segmented routing exists. That is acceptable today (English-only) and correct once a real locale ships via the ship-a-language project; SEO per-locale metadata properly belongs to locale-routing, out of scope here. Wrap anyway to keep the "no raw metadata strings" invariant.

**Static→dynamic conversion:** replace `export const metadata: Metadata = {...}` with `export async function generateMetadata(): Promise<Metadata> { const locale = await readLocale(); return {...}; }`, moving the shared `title`/`description` consts inside and wrapping via `t(..., undefined, locale)`. Keep `metadataBase`, `openGraph.url`, `twitter.card`, etc. as-is. For the root `layout.tsx`, verify no other code imports the `metadata` const (it shouldn't) before converting.

- [ ] **Step 1: Extend the metadata test**

In `roads/best/metadata.test.ts`, keep the existing English assertions (they must stay green). Add assertions on the converted layout `generateMetadata` outputs (call them, assert English title/description). Run → the layout ones FAIL (still static) / country ones still pass.

- [ ] **Step 2: Convert + wrap + register**

Wrap the 3 roads/best pages (title/imageAlt via `t("Best motorcycle roads in {name} — Tarmoto", { name }, locale)` etc.); convert the 3 layouts to `generateMetadata`. Register keys (dedupe the two reused best-roads keys). Add the ISR caveat comment to `roads/best/[country]/page.tsx`.

- [ ] **Step 3: Verify + acceptance + commit**

```bash
cd apps/companion && npx vitest run src/app/roads/best/metadata.test.ts src/i18n/locales/catalog.test.ts && npx tsc --noEmit
grep -rn 'export const metadata' src/app/layout.tsx src/app/explore/layout.tsx src/app/roads/best/layout.tsx
```

Expected: PASS; the grep returns EMPTY (all three converted). Commit:

```bash
git -c core.hooksPath=/dev/null commit -m "feat(companion): localise roads/best and layout metadata"
```

**Visible changes:** none.

---

### Task 7: Bucket A part 1 — table + tile labels (A1–A4)

**Files:**

- Modify: `src/app/(dashboard)/rides/_components/RidesTable.tsx` (A1), `src/app/(dashboard)/_home/RecentRidesTable.tsx` (A2 — add `import { t } from "@/i18n"`), `src/app/(dashboard)/rides/[rideId]/page.tsx` (A3 tiles + A4 RoadSegments columns)
- Modify: `src/i18n/locales/en.ts`
- Test: `src/app/(dashboard)/rides/_components/RidesTable.test.tsx` (already pins headers — update to expect `t()`-wrapped which is English-identical)

**Full checklist:** `docs/superpowers/plans/2026-07-17-pr2-inventory-components.md` Bucket A rows A1–A4.

**Strings (wrap each `label:` in `t()`; `DataTable`/`MetricTile` render `label` verbatim — never wrap inside the shared component):**

| Site                        | Labels                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1 RidesTable columns       | `DATE`, `RIDE`, `DURATION`, `AVG ` (prefix of `` `AVG ${unit}` `` — wrap as `t("AVG {unit}", { unit })`), `LEAN`, `QUALITY` (unit label at :73 is formatter-derived — EXCLUDE) |
| A2 RecentRidesTable columns | `DATE`, `RIDE`, `DURATION`, `AVG {unit}`, `QUALITY` (unit label EXCLUDE)                                                                                                       |
| A3 ride-detail tiles        | `Distance`, `Duration`, `Avg speed`, `Top speed`, `Max lean`, `Ascent`                                                                                                         |
| A4 RoadSegments columns     | `SEGMENT`, `AVG {unit}`, `MAX {unit}`, `LEAN`, `QUALITY` (`#` at :687 EXCLUDE — symbol)                                                                                        |

**Approach:** RecentRidesTable has no `t` import — add it. The `AVG ${unit}`/`MAX ${unit}` templates become `t("AVG {unit}", { unit })` / `t("MAX {unit}", { unit })` (register those). Everything else is a plain label wrap.

- [ ] **Step 1: Update RidesTable.test.tsx expectations**

The test pins header text (e.g. `DATE`, `QUALITY`). Since wrapping is English-identical, the assertions stay the same text — only run to confirm they still pass after wrapping. If any header is built from `AVG {unit}`, confirm the rendered value is unchanged.

- [ ] **Step 2: Wrap + register**

Wrap all `label:` fields; add the `t` import to RecentRidesTable; register keys.

- [ ] **Step 3: Verify + acceptance + commit**

```bash
cd apps/companion && npx vitest run src/app/\(dashboard\)/rides/_components/RidesTable.test.tsx src/i18n/locales/catalog.test.ts && npx vitest run rideId && npx tsc --noEmit
grep -nE 'label:\s*"(DATE|RIDE|DURATION|LEAN|QUALITY|SEGMENT|Distance|Duration|Avg speed|Top speed|Max lean|Ascent)"' src/app/\(dashboard\)/rides/_components/RidesTable.tsx "src/app/(dashboard)/_home/RecentRidesTable.tsx" "src/app/(dashboard)/rides/[rideId]/page.tsx"
```

Expected: PASS; grep returns EMPTY (no raw `label:` literals remain). Commit:

```bash
git -c core.hooksPath=/dev/null commit -m "feat(companion): wrap ride table and metric-tile labels"
```

**Visible changes:** none.

---

### Task 8: Bucket A part 2 — filter/legend/config labels (A6–A19)

**Files:**

- Modify: `src/lib/utils.ts` (A8 `QUALITY_CONFIG` labels, A9 `HAZARD_CONFIG` labels), `src/app/explore/page.tsx` (A6/A7 — if not covered by wrapping the utils source; the audit says A6 reuses A8's words, so wrap at the `QUALITY_CONFIG`/`HAZARD_CONFIG` source and confirm explore renders via those), `src/lib/planner/quality-bands.ts` (A12/A13 + their consuming files `MapToolbar.tsx`/`RouteQualityStrip.tsx`/`RoadPreviewPopover.tsx`/`TripPlannerMap.tsx` — add `t` imports where missing), `src/components/map/MapLegend.tsx` (A11 surface labels — add a `SURFACE_LABELS` lookup), `src/app/(dashboard)/rides/stats/page.tsx` (A15 `RIDE_TYPE_OPTIONS`, A18 `STATS_WINDOWS` + inline fallbacks), `src/app/(dashboard)/rides/_components/RidesFilters.tsx` (A16), `src/app/(dashboard)/rides/_components/TimeWindowPills.tsx` (A17 — add `t`), `src/lib/ride-stats.ts` (A18 `STATS_WINDOWS`), `src/app/(dashboard)/rides/compare/page.tsx` (A19 `SLOT_LABEL`)
- Modify: `src/i18n/locales/en.ts`

**Full checklist:** `docs/superpowers/plans/2026-07-17-pr2-inventory-components.md` Bucket A rows A6–A19 (A5 excluded; A10/A14 already wrapped).

**Strings (wrap the label VALUES; where a constant feeds multiple render sites, wrap once at the constant or at a shared render helper — see per-row):**

| Row   | Constant / site                                                                             | Labels                                                                                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A6/A8 | `lib/utils.ts` QUALITY_CONFIG (single source for explore filter + legend + segment Pill)    | `Excellent`, `Good`, `Fair`, `Poor`, `Very Poor`                                                                                                                                                   |
| A7    | `explore/page.tsx` SURFACE_OPTIONS                                                          | `Asphalt`, `Concrete`, `Cobblestone`, `Gravel`, `Dirt`                                                                                                                                             |
| A9    | `lib/utils.ts` HAZARD_CONFIG                                                                | `Pothole`, `Gravel`, `Oil spill`, `Roadworks`, `Animals`, `Police`, `Flooding`, `Ice`, `Other`                                                                                                     |
| A11   | `MapLegend.tsx` surface swatches (currently render the enum KEY)                            | add `SURFACE_LABELS: Record<SurfaceKey,string>` = {asphalt:"Asphalt",concrete:"Concrete",cobblestone:"Cobblestone",gravel:"Gravel",dirt:"Dirt",unknown:"Unknown"}, render `t(SURFACE_LABELS[key])` |
| A12   | `lib/planner/quality-bands.ts` QUALITY_BAND_LABELS                                          | `Good or better`, `Fair`, `Rough`, `No data`                                                                                                                                                       |
| A13   | same file QUALITY_BAND_LABELS_SHORT                                                         | `Good+`, `Fair`, `Rough`, `No data`                                                                                                                                                                |
| A15   | `stats/page.tsx` RIDE_TYPE_OPTIONS                                                          | `All`, `Free`, `Commute`, `Trip`, `Tracked`                                                                                                                                                        |
| A16   | `RidesFilters.tsx` OPTIONS/TYPE_OPTIONS                                                     | `Any`, `All`, `Free`, `Commute`, `Trip`, `Tracked`                                                                                                                                                 |
| A17   | `TimeWindowPills.tsx` OPTIONS                                                               | `All time`, `This year`, `Last 90 days`, `Last 30 days` (may already be registered — reuse)                                                                                                        |
| A18   | `lib/ride-stats.ts` STATS_WINDOWS + `stats/page.tsx` `?? "All time"` and `"Last 12 months"` | same window words + `Last 12 months`                                                                                                                                                               |
| A19   | `compare/page.tsx` SLOT_LABEL                                                               | `Ride A`, `Ride B`                                                                                                                                                                                 |

**Approach:** Prefer wrapping at the render site (`{t(item.label)}`) when the constant is consumed via `.map` in a component that has (or can add) `t` — this keeps the constant as canonical English data. For `QUALITY_CONFIG`/`HAZARD_CONFIG` in `lib/utils.ts`, the values feed multiple render sites raw; the cleanest single fix is to wrap at EACH render site (explore filter, MapLegend, SegmentDetailSidebar Pill) via `t(config.label)` rather than mutating the shared constant (which is also used for non-UI purposes). Verify each render site and wrap there; add `t` imports to `MapToolbar.tsx`, `RouteQualityStrip.tsx`, `TimeWindowPills.tsx` (no `t` today). A10/A14 are already `t()`-wrapped — only register their key values if not already registered (grep first). EXCLUDE A5 (lean degree ranges).

- [ ] **Step 1: Trace each constant to its render sites**

For A6/A8/A9 (utils configs) and A12/A13 (quality bands), grep every consumer and confirm where the label renders raw. Decide per constant: wrap-at-render (preferred) vs wrap-at-constant. Record the choice.

- [ ] **Step 2: Wrap + add missing `t` imports + A11 lookup + register**

Apply wraps at the chosen sites; add the `SURFACE_LABELS` lookup for A11; add `t` imports to the three importless files; register all label values (dedupe words shared across rows — e.g. `Fair`, `Gravel`, `All time` appear multiple times but register once).

- [ ] **Step 3: Verify + acceptance + commit**

```bash
cd apps/companion && npx vitest run src/i18n/locales/catalog.test.ts && npx vitest run explore stats RidesFilters compare && npx tsc --noEmit && npx eslint src/app/explore/page.tsx src/lib/planner/quality-bands.ts src/components/map/MapLegend.tsx
grep -rnE '(label|label:)\s*"(Excellent|Very Poor|Pothole|Good or better|Ride A|Commute)"' src/app src/lib src/components | grep -v i18n/locales
```

Expected: PASS; grep shows these words only inside data constants, with render sites wrapping them. Commit:

```bash
git -c core.hooksPath=/dev/null commit -m "feat(companion): wrap explorer, planner and filter legend labels"
```

**Visible changes:** none (A11 surface legend now shows the same capitalized words via a lookup instead of CSS-capitalized enum keys — verify byte-identical, e.g. "Asphalt" both before and after).

---

### Task 9: Bucket B (validation) + Bucket C (toasts)

**Files:**

- Modify: `src/lib/bikes.ts` (B1–B6), `src/lib/trip-folders.ts` (B7–B9), `src/lib/route-collections.ts` (B10–B13)
- Modify: toast sites — `src/app/(dashboard)/trips/page.tsx` (C1 plural), `src/app/(dashboard)/trips/planner/page.tsx` (C2–C7), `src/app/(dashboard)/community/collections/page.tsx` (C8/C9), `src/app/trips/shared/[token]/SharedTripJoinCta.tsx` (C10 — add `t`), `src/components/RoadReviewsPanel.tsx` (C11), `src/components/TripExportButton.tsx` (C12/C13)
- Modify: `src/i18n/locales/en.ts`
- Test: `src/lib/__tests__/bikes.test.ts` / `trip-folders.test.ts` / `route-collections.test.ts` (extend/create); existing planner tests must stay green

**Validation strings (wrap each returned message at source; all three libs' callers already have `t`):**

| Row   | String                                                                              |
| ----- | ----------------------------------------------------------------------------------- |
| B1–B4 | `Make is required`, `Model is required`, `Year is required`, `Enter a 4-digit year` |
| B5    | `Year must be between {min} and {max}` (was `` `…${MIN_BIKE_YEAR} and ${max}` ``)   |
| B6    | `Photo URL must start with http:// or https://`                                     |
| B7    | `Folder name is required`                                                           |
| B8    | `Folder name must be {max} characters or fewer`                                     |
| B9    | `A folder with that name already exists`                                            |
| B10   | `Collection name is required`                                                       |
| B11   | `Collection name must be {max} characters or fewer`                                 |
| B12   | `A collection with that name already exists`                                        |
| B13   | `Description must be {max} characters or fewer`                                     |

Thread `t` into `validateBikeForm`/`validateFolderName`/`validateCollectionName`/`validateCollectionDescription` (last param) and wrap each message; update callers to pass `t`. Register keys (the `{min}`/`{max}` messages verbatim).

**Toast strings:**

| Row     | Site                   | Action                                                                                                                                                   |
| ------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1      | trips/page.tsx         | CONVERT manual plural to ICU: `t("{count, plural, one {Moved # folder} other {Moved # folders}} to your Tarmoto account.", { count: result.succeeded })` |
| C2      | planner:1422           | `t("Imported routes need at least two route points before saving.")`                                                                                     |
| C3      | planner:1452           | `t("Select at least one paved surface or turn off Avoid unpaved roads before saving.")`                                                                  |
| C4      | planner:1462           | `t("Add a start waypoint before saving this trip.")`                                                                                                     |
| C5      | planner:1515           | `t("Could not save this trip. Please try again.")`                                                                                                       |
| C6      | planner:2351           | `t("Add a start waypoint before selecting this route.")`                                                                                                 |
| C7      | planner:2392           | `t("Could not select this route option. Please try again.")`                                                                                             |
| C8      | collections:92         | wrap fallback `t("Failed to unfollow collection")`                                                                                                       |
| C9      | collections:126        | wrap fallback `t("Failed to delete collection")`                                                                                                         |
| C10     | SharedTripJoinCta:84   | add `import { t } from "@/i18n"`; wrap fallback `t("Could not join this shared trip. Ask the owner for a fresh link.")`                                  |
| C11     | RoadReviewsPanel:981   | wrap fallback `t("Could not submit vote.")`                                                                                                              |
| C12/C13 | TripExportButton:35,37 | `t("GPX downloaded")`, `t("Could not generate GPX")`                                                                                                     |

(C8–C11 keep the `err instanceof Error ? err.message : t("…")` shape — only the literal fallback is wrapped, the dynamic `err.message` stays.)

- [ ] **Step 1: Failing validation tests**

Extend/create the three validator tests to call each with a real `t` and assert English messages unchanged (e.g. `validateBikeForm({make:""}, t).make === "Make is required"`). Run → FAIL.

- [ ] **Step 2: Wrap validation + toasts + register**

Thread `t` through validators + callers; wrap all 13 toasts (C1 as ICU plural); add `t` to SharedTripJoinCta. Register keys.

- [ ] **Step 3: Verify + acceptance + commit**

```bash
cd apps/companion && npx vitest run src/lib/__tests__/bikes.test.ts src/lib/__tests__/trip-folders.test.ts src/lib/__tests__/route-collections.test.ts src/i18n/locales/catalog.test.ts && npx vitest run trips planner collections && npx tsc --noEmit
grep -rnE 'toast\.(error|success)\(\s*"' src/app src/components | grep -v i18n
```

Expected: PASS; the toast grep returns EMPTY (no raw-literal toast args remain). Commit:

```bash
git -c core.hooksPath=/dev/null commit -m "feat(companion): wrap form validation and toast copy"
```

**Visible changes:** none in English (C1 renders "Moved 1 folder…"/"Moved N folders…" identically).

---

### Task 10: Bucket D — aria/alt/title props (~48)

**Full checklist:** `docs/superpowers/plans/2026-07-17-pr2-inventory-components.md` Bucket D rows D1–D48 (each row = file:line + attribute + exact string + binding + wrap approach). EXCLUDE D49–D53.

**Files:** the ~30 component/page files listed in the inventory's Bucket D (D1–D48), plus `src/i18n/locales/en.ts`. EXCLUDE D49 (`global-error.tsx` — spec exception, no `t`), D50–D53 (attribution/brand/numeric — invariant).

**Approach:** wrap each raw `aria-label`/`ariaLabel`/`alt`/`title` string in `t()`. For template-literal props, convert to an ICU message with a placeholder for the dynamic part, e.g.:

- ``aria-label={`Edit ${formatBikeTitle(bike)}`}`` → `aria-label={t("Edit {bike}", { bike: formatBikeTitle(bike) })}`
- ``aria-label={`${challenge.name}: ${format.percent(fraction)} complete`}`` → `t("{name}: {pct} complete", { name: challenge.name, pct: format.percent(fraction) })`
- D18 (plural): `` `Force ${n} days` `` → `t("Force {n, plural, one {# day} other {# days}}", { n })`
- D31 (unit correctness): `` `Elevation profile from ${Math.round(ext.min)}m to ${Math.round(ext.max)}m` `` → `t("Elevation profile from {min} to {max}", { min: format.elevation(ext.min), max: format.elevation(ext.max) })` (route values through `format.elevation` — the file must obtain a `Formatters`; if it has no `useFormat`, add it or thread `format` from the parent; do NOT bake "m" into the message)
- D29/D30 (flag labels): `flag.label` is pre-composed in `lib/planner/api.ts:223` from `QUALITY_BAND_LABELS_SHORT` (wrapped in Task 8) — for D30's embedded phrases, split per branch: `t("Reroute around flagged section: {label}", { label })` / `t("Inspect flagged section: {label}", { label })`; for D29 `t("Preview flagged section: {label}", { label })`
- Files with no `t` import (RecentRidesTable D43, \_RidesTabsBar D44, TimeWindowPills D45, \_CommunityTabsBar D46, RouteQualityStrip D33) → add `import { t } from "@/i18n"` (some added already in Tasks 7/8 — check).

The exhaustive list is the 48 non-excluded Bucket D rows (D1–D48) in the audit; each is `t()`-wrapped with placeholders for interpolated values. Register every key (dedupe shared phrasings like `{label} route preview` used by D26/D35/D36).

- [ ] **Step 1: Split into sub-commits by area (optional but recommended)**

This task touches ~30 files; group the edits into 3–4 logical commits (planner props, settings props, table/tab props, review/collection props) so review is tractable. Each group: wrap → register → tsc → commit.

- [ ] **Step 2: Wrap all D1–D48 + register**

Apply every wrap per the audit; add missing `t` imports; handle D18 (plural), D29/D30 (branch split), D31 (format.elevation). Do NOT touch D49–D53.

- [ ] **Step 3: Verify + acceptance + commit(s)**

```bash
cd apps/companion && npx vitest run src/i18n/locales/catalog.test.ts && npx vitest run && npx tsc --noEmit && npx eslint src
# acceptance: raw aria-label/ariaLabel/alt/title string literals gone (excluding global-error + attribution)
grep -rnE '(aria-label|ariaLabel|alt|title)=\{?"' src/app src/components --include='*.tsx' | grep -vE 'i18n|global-error|OpenStreetMap|Foursquare|Tarmoto data|"2024"|alt=""'
```

Expected: full suite PASS; grep returns EMPTY (or only the documented exclusions). Commit each group:

```bash
git -c core.hooksPath=/dev/null commit -m "feat(companion): wrap aria and alt prop copy"
```

**Visible changes:** none (aria/alt are non-visible; D18/D31 render English-identical for current values).

---

## Final validation (before whole-branch review)

```bash
cd apps/companion && rm -rf .next/dev/types && npx tsc --noEmit && npx vitest run && npx eslint src
npx playwright test   # English UI unchanged; metadata/aria wraps are transparent
git diff main --stat   # en.ts should show ~250-290 key additions; no source deletions beyond wraps
```

Backend/shared are untouched by PR 2 — no need to run their suites unless `git diff main -- packages apps/backend` is non-empty (it should be empty).

**Acceptance summary (the PR is done when):**

1. Each task's acceptance grep is empty.
2. `catalog.test.ts` green (every new key valid ICU, `count`+`other` on plurals).
3. Full companion vitest + tsc + eslint + Playwright green.
4. `git diff main` shows English output byte-identical except C1/D18 plural-copy (which render identically for English counts).
5. Documented exclusions untouched: `global-error.tsx`, attribution tooltips, `SOCIAL_ACCOUNT_CONFLICT_MESSAGE` constant, dead fixtures, `formatDistance`.

**PR-body ledger:** "no user-visible copy change — this PR only routes existing English strings through the translator and registers them; two toast/aria plural-ternaries (C1, D18) became ICU plural messages with identical English rendering." Note the roads/best ISR metadata caveat and the out-of-scope follow-ups (region `r.description` content translation; `social-auth-bridge.ts` thrown errors; D31 elevation unit now honoured).
