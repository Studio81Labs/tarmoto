# i18n audit: 7 "pure lib" files in apps/companion

Read-only inventory. All line numbers verified against the working tree at time of audit.

## Methodology / rules applied

- **User-facing** = any string literal a rider could see rendered as text: names, descriptions, labels, feature copy, error messages, CTAs, unit words, month names — including short alphabetic unit abbreviations (`km`, `m`, `min`, `mi`, `ft`) because several locales (CJK, Arabic) do translate these, not just full words. Bare punctuation/mathematical glyphs (`—`, `+`/`−`, `/5`, `°`, `·` as pure separator, SVG path letters `M`/`L`) are excluded as non-linguistic.
- **Exclude** = object/Record keys, enum/union discriminant values (even when the identical word also appears elsewhere as display text), API field names, icon names, ids used only as identifiers, ISO timestamps, empty-string sentinels, values compared with `===` against wire/query data, developer-only assertion errors never surfaced in UI.
- For each file I traced every exported function's real callers (grep across `src/`) to confirm live-vs-dead code and whether the render site already has `t` in scope.
- Two functions across the 7 files (`buildDemoSnapshot` in gamification.ts, `buildShareSummary`+`groupUnriddenByRegion` in exploration.ts) are **confirmed dead in production** — referenced only from their own unit tests, per grep across all of `src/`. This is called out per-file, not silently folded into the live counts.

---

## 1. `src/lib/gamification.ts`

**Current translation-capability state:** imports both `Formatters` and `LooseTranslate` from `@tarmoto/shared` (line 18). `formatMilestoneLabel(progress, format)` takes `Formatters` only — no `t`, and contains raw English. `formatDaysRemaining(endsAt, now, t)` takes `LooseTranslate` as the last param and is **fully wrapped already** — this is the reference pattern named in the brief. Every other exported function (mappers, `buildLiveSnapshot`, `labelForDimension`, `unitForChallengeMetric`, `buildDemoSnapshot`, etc.) takes neither.

### User-facing strings needing wrap

| Line | Exact string                                                    | Enclosing fn/const                                                                       | How rendered                                                             | Suggested approach                                                                    |
| ---- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 254  | `` `Maxed at ${format.distanceKm(...)}` ``                      | `formatMilestoneLabel`                                                                   | return value, achievements page milestone row                            | thread `t` (already takes `format`; add `t` after)                                    |
| 258  | `` `${current.value} / ${target.value} ${target.unit}` ``       | `formatMilestoneLabel`                                                                   | return value                                                             | thread `t`, e.g. `t("{current} / {target} {unit}", {...})`                            |
| 262  | `` `Maxed at ${format.integer(...)} ${unit}` ``                 | `formatMilestoneLabel`                                                                   | return value                                                             | thread `t`                                                                            |
| 264  | `` `${format.integer(...)} / ${format.integer(...)} ${unit}` `` | `formatMilestoneLabel`                                                                   | return value                                                             | thread `t`                                                                            |
| 302  | `"km"`                                                          | `MILESTONE_UNITS` (const, live)                                                          | Record value via `MILESTONE_UNITS[metric]` inside `formatMilestoneLabel` | thread `t`                                                                            |
| 303  | `"roads"`                                                       | `MILESTONE_UNITS`                                                                        | ditto                                                                    | thread `t`                                                                            |
| 304  | `"reports"`                                                     | `MILESTONE_UNITS`                                                                        | ditto                                                                    | thread `t`                                                                            |
| 317  | `"Distance Traveller"`                                          | `DEFAULT_MILESTONES` (used by **both** `buildDemoSnapshot` and live `buildLiveSnapshot`) | `Milestone.name`, achievements page                                      | thread `t` in lib, or wrap at render site (achievements/page.tsx already imports `t`) |
| 318  | `"Cumulative kilometres ridden across every bike."`             | `DEFAULT_MILESTONES`                                                                     | `Milestone.description`                                                  | same                                                                                  |
| 323  | `"Road Cartographer"`                                           | `DEFAULT_MILESTONES`                                                                     | name                                                                     | same                                                                                  |
| 325  | `"Unique roads you were first to map."`                         | `DEFAULT_MILESTONES`                                                                     | description                                                              | same                                                                                  |
| 330  | `"Hazard Hunter"`                                               | `DEFAULT_MILESTONES`                                                                     | name                                                                     | same                                                                                  |
| 332  | `"Confirmed hazards reported to the community."`                | `DEFAULT_MILESTONES`                                                                     | description                                                              | same                                                                                  |
| 525  | `"km"`                                                          | `UNIT_BY_METRIC` (live, via `unitForChallengeMetric`→`mapChallengeDto`)                  | `Challenge.unit`                                                         | thread `t`                                                                            |
| 526  | `"km"`                                                          | `UNIT_BY_METRIC`                                                                         | ditto                                                                    | thread `t`                                                                            |
| 527  | `"rides"`                                                       | `UNIT_BY_METRIC`                                                                         | ditto                                                                    | thread `t`                                                                            |
| 528  | `"roads"`                                                       | `UNIT_BY_METRIC`                                                                         | ditto                                                                    | thread `t`                                                                            |
| 529  | `"reviews"`                                                     | `UNIT_BY_METRIC`                                                                         | ditto                                                                    | thread `t`                                                                            |
| 530  | `"reports"`                                                     | `UNIT_BY_METRIC`                                                                         | ditto                                                                    | thread `t`                                                                            |
| 531  | `"rides"`                                                       | `UNIT_BY_METRIC`                                                                         | ditto                                                                    | thread `t`                                                                            |
| 535  | `"units"` (fallback)                                            | `unitForChallengeMetric`                                                                 | return value                                                             | thread `t`                                                                            |
| 673  | `"Distance"`                                                    | `DIMENSION_LABELS` (live)                                                                | value via `labelForDimension`, achievements page dimension picker        | thread `t` in lib, or wrap at render site (achievements/page.tsx already has `t`)     |
| 674  | `"Roads discovered"`                                            | `DIMENSION_LABELS`                                                                       | ditto                                                                    | same                                                                                  |
| 675  | `"Hazards reported"`                                            | `DIMENSION_LABELS`                                                                       | ditto                                                                    | same                                                                                  |

**Subtotal, live-reachable: 24**

### `buildDemoSnapshot` — confirmed dead in production (test-fixture only)

Grep confirms `buildDemoSnapshot` has **zero callers outside `src/lib/__tests__/gamification.test.ts`** — matches its own doc comment ("retained as a typed test fixture only"). Listed for completeness since they're still bypassing `t()`, but they are not reachable from any live route today, so wrapping is optional/low-priority.

| Line    | Exact string                                                                            | Field                      | Note      |
| ------- | --------------------------------------------------------------------------------------- | -------------------------- | --------- |
| 360/361 | `"Pioneer"` / `"First to map 100 roads."`                                               | Badge name/description     | test-only |
| 367/368 | `"Mountain hunter"` / `"Ride 10 mountain passes."`                                      | Badge name/description     | test-only |
| 374/375 | `"Night owl"` / `"Finish 5 rides after sunset."`                                        | Badge name/description     | test-only |
| 381/382 | `"Hazard hunter"` / `"Report 25 confirmed hazards."`                                    | Badge name/description     | test-only |
| 388/389 | `"1000 curves"` / `"Link 1,000 curves in a single month."`                              | Badge name/description     | test-only |
| 394/395 | `"Legend"` / `"Reach 100,000 km on a single bike."`                                     | Badge name/description     | test-only |
| 403/404 | `"Spring warm-up"` / `"Clock 500 km during April."`                                     | Challenge name/description | test-only |
| 408     | `"km"`                                                                                  | Challenge unit             | test-only |
| 410     | `"Spring 2026 badge"`                                                                   | Challenge reward           | test-only |
| 414/415 | `"Ten new roads"` / `"Map 10 roads never ridden before."`                               | Challenge name/description | test-only |
| 419     | `"roads"`                                                                               | Challenge unit             | test-only |
| 424/425 | `"Community watch"` / `"Report 5 hazards this week."`                                   | Challenge name/description | test-only |
| 429     | `"reports"`                                                                             | Challenge unit             | test-only |
| 434/435 | `"Group ride"` / `"Join a group ride with another Tarmoto rider."`                      | Challenge name/description | test-only |
| 439     | `"ride"`                                                                                | Challenge unit             | test-only |
| 446     | `"Alpine Spring"`                                                                       | Seasonal name              | test-only |
| 447     | `"Chase the thaw across Europe's reopening passes."`                                    | Seasonal tagline           | test-only |
| 449     | `"Ride 1,500 km featuring at least 10 alpine passes before the season closes in June."` | Seasonal description       | test-only |
| 455     | `"km"`                                                                                  | Seasonal unit              | test-only |

**Subtotal, test-fixture only: 29**

### Exclude list

| Line                                     | String                                                                                                  | Why                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 26–30, 405/416/426/436                   | `"distance"`, `"discovery"`, `"safety"`, `"social"`, `"seasonal"`                                       | `ChallengeCategory` enum discriminant  |
| 58–67                                    | `"total_distance_km"`, `"roads_discovered"`, `"hazards_reported"` (type + `LEADERBOARD_DIMENSION_KEYS`) | wire-format enum keys                  |
| 127, 450                                 | `"spring"` etc.                                                                                         | `SeasonalChallenge.season` enum        |
| 249                                      | `metric === "totalKm"`                                                                                  | comparison, not display                |
| 301, 305 (keys), 316/322/329             | `totalKm`/`roadsDiscovered`/`hazardsReported` keys; milestone `id`s                                     | Record keys / ids                      |
| 319/326/333                              | `"totalKm"` etc.                                                                                        | `Milestone.metric` enum value          |
| 359/366/373/380/386/392                  | badge `id`s (`"pioneer"` etc.)                                                                          | identifiers                            |
| 362/369/376/383/390/396                  | `"compass"`, `"mountain"`, `"moon"`, `"alert-triangle"`, `"wind"`, `"trophy"`                           | icon names                             |
| 402/406/413/417/423/427/433/437, 445/450 | challenge/seasonal `id`/`category`                                                                      | ids / enum                             |
| 479–487                                  | `BADGE_ICON_BY_KEY` keys+values, `"medal"` fallback (490)                                               | icon names + backend keys              |
| 509–520                                  | `CHALLENGE_CATEGORY_BY_METRIC` keys+values, `"distance"` fallback                                       | backend keys + enum                    |
| 524–531 (keys)                           | `total_distance`, `single_ride`, etc.                                                                   | backend metric keys                    |
| 546                                      | `return ""`                                                                                             | empty-string sentinel (no reward text) |
| 672–675 (keys)                           | `total_distance_km` etc.                                                                                | Record keys                            |

### Already wrapped (`formatDaysRemaining`, lines 267–299) — 8

`t("Ongoing")` (273), `t("Ended")` (275), `t("Ends today")` (277), `t("Ends tomorrow")` (278), `t("{count, plural, one {# day} other {# days}} left", …)` (280), `t("{count, plural, one {# week} other {# weeks}} left", …)` (288), `t("{weeks}w {days}d left", …)` (291), `t("{count, plural, one {# month} other {# months}} left", …)` (296).

### Signatures

- `formatMilestoneLabel(progress: MilestoneProgress, format: Formatters)` → **+ `t: LooseTranslate`** (last param)
- `unitForChallengeMetric(metric: string)` → **+ `t: LooseTranslate`**
- `mapChallengeDto(dto: ChallengeDto, myProgress?: number | null)` → **+ `t: LooseTranslate`** (threads to `unitForChallengeMetric`)
- `buildLiveSnapshot(input: {...})` → **+ `t: LooseTranslate`** (threads to `mapChallengeDto`)
- `labelForDimension(dim: LeaderboardDimensionKey)` → **+ `t: LooseTranslate`**
- `buildDemoSnapshot(riderId: string, now: Date = new Date())` → optionally **+ `t: LooseTranslate`** (low priority — test-only)
- `formatDaysRemaining(...)` — no change, already correct.
- No change needed: `iconForBadgeKey`, `categoryForChallengeMetric`, `mapBadgeDto`, `mapRegionalLeaderboardEntry`, `mapDimensionLeaderboard`, `mapRegionalLeaderboards`, `riderStatsFromBadges`, `riderStatsFromMeProfile`, `challengeProgress`, `seasonalProgress`, `activeChallenges`, `milestoneProgress`, `pickNextMilestone`.

**Caveat:** `humanizeRewardBadgeKey` (line 544) turns a **dynamic backend key** (e.g. `reward_badge_key: "spring_explorer"`) into display text algorithmically. It cannot be routed through a static `t()` catalog — there's no fixed key to translate against. This is a real backend-localization gap, out of scope for a catalog-based `t()` wrap; flagging so PR 2 doesn't try to force it in.

**File count needing wrap: 53** (24 live + 29 demo/test-fixture-only) · **Already wrapped: 8**

---

## 2. `src/lib/subscription.ts`

**Current translation-capability state:** imports `Formatters` (used only by `describeRenewal`/`formatInvoiceDate`) — **no `LooseTranslate`/`t` anywhere in this file.** Every copy string is hardcoded English with zero translation capability today. All strings below are confirmed live (this file has no dead-code branches — `buildFallbackSubscriptionSnapshot()` is the real 404-preview fallback rendered in `settings/subscription/page.tsx`).

### User-facing strings needing wrap

| Line    | Exact string                                                                                         | Enclosing fn/const                  | How rendered                                          | Suggested approach                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 63      | `"Basic navigation"`, `"Hazard alerts"`, `"1 active trip"`                                           | `DEFAULT_PLAN_FEATURES.free`        | `SubscriptionPlanSummary.features[]`, plan cards      | thread `t` into consumers (`normalizePlans`, `buildPlanFromCurrent`); map each feature through `t()` |
| 64      | `"Unlimited trip planning"`, `"Offline maps"`, `"GPX export"`                                        | `DEFAULT_PLAN_FEATURES.pro`         | ditto                                                 | same                                                                                                 |
| 65      | `"Unlimited group rides"`, `"Priority hazard alerts"`, `"API access"`                                | `DEFAULT_PLAN_FEATURES.premium`     | ditto                                                 | same                                                                                                 |
| 78      | `"Pro"`                                                                                              | `buildFallbackSubscriptionSnapshot` | `currentPlan.name`                                    | thread `t` (add param)                                                                               |
| 88      | `"Free"`                                                                                             | `buildFallbackSubscriptionSnapshot` | plan name                                             | thread `t`                                                                                           |
| 91–94   | `"Basic navigation"`, `"Road quality overlay (limited)"`, `"Hazard alerts"`, `"1 active trip"`       | `buildFallbackSubscriptionSnapshot` | free plan features                                    | thread `t`                                                                                           |
| 99      | `"Pro"`                                                                                              | `buildFallbackSubscriptionSnapshot` | plan name                                             | thread `t`                                                                                           |
| 103–106 | `"Unlimited trip planning"`, `"Full road quality zoom"`, `"Offline maps"`, `"GPX export"`            | `buildFallbackSubscriptionSnapshot` | pro plan features                                     | thread `t`                                                                                           |
| 111     | `"Premium"`                                                                                          | `buildFallbackSubscriptionSnapshot` | plan name                                             | thread `t`                                                                                           |
| 114–117 | `"Everything in Pro"`, `"Unlimited group rides"`, `"Priority hazard alerts"`, `"Advanced analytics"` | `buildFallbackSubscriptionSnapshot` | premium plan features                                 | thread `t`                                                                                           |
| 196     | `"Pro"`                                                                                              | `tierLabel`                         | return value, used app-wide for tier display          | thread `t`                                                                                           |
| 197     | `"Premium"`                                                                                          | `tierLabel`                         | return value                                          | thread `t`                                                                                           |
| 198     | `"Free"`                                                                                             | `tierLabel` (fallback)              | return value                                          | thread `t`                                                                                           |
| 205     | `"Current plan"`                                                                                     | `planActionLabel`                   | plan CTA button                                       | thread `t`                                                                                           |
| 207     | `"Upgrade"`                                                                                          | `planActionLabel`                   | CTA button                                            | thread `t`                                                                                           |
| 208     | `"Downgrade"`                                                                                        | `planActionLabel`                   | CTA button                                            | thread `t`                                                                                           |
| 220     | `"soon"`                                                                                             | `describeRenewal`                   | fragment feeding `Renews ${date}` etc.                | thread `t` (already takes `format`; add `t`)                                                         |
| 222     | `` `Downgrades ${date}` ``                                                                           | `describeRenewal`                   | return value                                          | thread `t`                                                                                           |
| 225     | `` `Trial ends ${date}` ``                                                                           | `describeRenewal`                   | return value                                          | thread `t`                                                                                           |
| 228     | `"Canceled"`                                                                                         | `describeRenewal`                   | return value                                          | thread `t`                                                                                           |
| 228     | `` `Access ends ${date}` ``                                                                          | `describeRenewal`                   | return value                                          | thread `t`                                                                                           |
| 230     | `` `Renews ${date}` ``                                                                               | `describeRenewal`                   | return value                                          | thread `t`                                                                                           |
| 230     | `"Billing cycle managed in the portal"`                                                              | `describeRenewal`                   | return value                                          | thread `t`                                                                                           |
| 236     | `` `${titleCase(brand)} ending in ${last4}` `` (the word "ending in")                                | `formatPaymentMethodLabel`          | payment method row                                    | thread `t`                                                                                           |
| 242     | `` `Expires ${mm}/${yyyy}` `` (the word "Expires")                                                   | `formatPaymentMethodExpiry`         | payment method row                                    | thread `t`                                                                                           |
| 255     | `"Open"`                                                                                             | `invoiceStatusLabel`                | billing history row                                   | thread `t`                                                                                           |
| 256     | `"Refunded"`                                                                                         | `invoiceStatusLabel`                | billing history row                                   | thread `t`                                                                                           |
| 257     | `"Paid"` (fallback)                                                                                  | `invoiceStatusLabel`                | billing history row                                   | thread `t`                                                                                           |
| 324     | `"Unavailable"` (fallback)                                                                           | `normalizeInvoices`                 | `amountLabel` when backend omits it                   | thread `t` into `normalizeInvoices`                                                                  |
| 377     | `"Card"` (fallback)                                                                                  | `titleCase`                         | brand name fallback, feeds `formatPaymentMethodLabel` | thread `t` into `titleCase`                                                                          |

### Exclude list

| Line            | String                                                                                                    | Why                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 10–15           | `SubscriptionStatus`/`InvoiceStatus` union values                                                         | enum types                                               |
| 68–72           | `TIER_ORDER` keys                                                                                         | Record keys matching `SubscriptionTier`                  |
| 77, 87, 98, 110 | `"pro"`, `"free"`, `"premium"` (tier fields)                                                              | enum value                                               |
| 79, 132         | `"active"`, `"paid"` (status fields)                                                                      | enum value                                               |
| 81, 130, 137    | ISO timestamps                                                                                            | not display text (formatted downstream via `Formatters`) |
| 122             | `"Visa"`                                                                                                  | brand name — **ambiguous**, see note below               |
| 123             | `"4242"`                                                                                                  | fixture digits, not linguistic                           |
| 129, 136        | `"preview-invoice-2026-03"` etc.                                                                          | ids                                                      |
| 338–357         | `"free"`/`"premium"`/`"pro"`/`"active"`/... in `normalizeTier`/`normalizeStatus`/`normalizeInvoiceStatus` | compared against wire data                               |
| 403–404         | `"http:"`, `"https:"`                                                                                     | protocol strings, not displayed                          |

**Note (ambiguous):** `"Visa"` (line 122) is real displayed text but a trademarked brand name — brand names are conventionally left untranslated across locales. Listed as exclude but flagging it as a judgment call rather than a clear-cut machine value.

### Already wrapped: **none** — this file has zero `t()` usage today, despite `describeRenewal`/`formatInvoiceDate` already threading `Formatters`. This is the starkest gap of the 7 files: full translation plumbing (`Formatters`) exists in the same functions that still hardcode English copy.

### Signatures

- `buildFallbackSubscriptionSnapshot()` → `buildFallbackSubscriptionSnapshot(t: LooseTranslate)`
- `normalizeSubscriptionSnapshot(raw: unknown)` → `normalizeSubscriptionSnapshot(raw: unknown, t: LooseTranslate)` (threads to `buildFallbackSubscriptionSnapshot`, `normalizePlans`, `tierLabel`)
- `tierLabel(tier: SubscriptionTier)` → `tierLabel(tier: SubscriptionTier, t: LooseTranslate)`
- `planActionLabel(planTier, currentTier)` → `planActionLabel(planTier: SubscriptionTier, currentTier: SubscriptionTier, t: LooseTranslate)`
- `describeRenewal(plan, format: Formatters)` → `describeRenewal(plan: CurrentSubscriptionPlan, format: Formatters, t: LooseTranslate)`
- `formatPaymentMethodLabel(paymentMethod)` → `formatPaymentMethodLabel(paymentMethod: SubscriptionPaymentMethod, t: LooseTranslate)`
- `formatPaymentMethodExpiry(paymentMethod)` → `formatPaymentMethodExpiry(paymentMethod: SubscriptionPaymentMethod, t: LooseTranslate)`
- `invoiceStatusLabel(status)` → `invoiceStatusLabel(status: InvoiceStatus, t: LooseTranslate)`
- (internal) `normalizePlans(rawPlans, fallbackPlans)` → `+ t: LooseTranslate`; `normalizeInvoices(raw)` → `+ t: LooseTranslate`; `buildPlanFromCurrent(currentPlan)` → `+ t: LooseTranslate`; `titleCase(value)` → `+ t: LooseTranslate`
- `formatInvoiceDate(date, format)` — no change (only literal is the excluded `"—"` dash).

**File count needing wrap: 45** · **Already wrapped: 0**

---

## 3. `src/lib/ride-compare.ts`

**Current translation-capability state:** imports `Formatters` only (no `LooseTranslate`). `formatDelta(delta, digits, format)` threads `Formatters` as the last param. `STAT_DEFS` (module-private, not exported) and `computeStatRows` take no translation capability at all. Confirmed live: `computeStatRows` is called from `rides/compare/page.tsx:363`, and both `row.label` (line 552) and `row.unit` (line 471) are rendered as literal text there — verified by reading the render code directly.

### User-facing strings needing wrap

| Line | Exact string         | Enclosing fn/const | How rendered                                                     | Suggested approach                         |
| ---- | -------------------- | ------------------ | ---------------------------------------------------------------- | ------------------------------------------ |
| 75   | `"Distance"`         | `STAT_DEFS`        | `row.label`, rendered directly (`compare/page.tsx:552`)          | thread `t` into `computeStatRows(a, b, t)` |
| 76   | `"km"`               | `STAT_DEFS`        | `row.unit`, appended to formatted value (`compare/page.tsx:471`) | thread `t`                                 |
| 82   | `"Duration"`         | `STAT_DEFS`        | label                                                            | thread `t`                                 |
| 83   | `"min"`              | `STAT_DEFS`        | unit                                                             | thread `t`                                 |
| 89   | `"Avg speed"`        | `STAT_DEFS`        | label                                                            | thread `t`                                 |
| 90   | `"km/h"`             | `STAT_DEFS`        | unit                                                             | thread `t`                                 |
| 96   | `"Max speed"`        | `STAT_DEFS`        | label                                                            | thread `t`                                 |
| 97   | `"km/h"`             | `STAT_DEFS`        | unit                                                             | thread `t`                                 |
| 103  | `"Elevation gain"`   | `STAT_DEFS`        | label                                                            | thread `t`                                 |
| 104  | `"m"`                | `STAT_DEFS`        | unit                                                             | thread `t`                                 |
| 110  | `"Elevation loss"`   | `STAT_DEFS`        | label                                                            | thread `t`                                 |
| 111  | `"m"`                | `STAT_DEFS`        | unit                                                             | thread `t`                                 |
| 117  | `"Avg road quality"` | `STAT_DEFS`        | label                                                            | thread `t`                                 |
| 124  | `"Curve count"`      | `STAT_DEFS`        | label (no unit)                                                  | thread `t`                                 |
| 130  | `"Max lean"`         | `STAT_DEFS`        | label                                                            | thread `t`                                 |

### Exclude list

| Line                            | String                                                    | Why                                                                                                                             |
| ------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 74/81/88/95/102/109/116/123/129 | `"distance_km"`, `"duration_min"`, etc.                   | `StatRow.key`, internal discriminant                                                                                            |
| 118                             | `"/5"`                                                    | fraction-marker glyph, not a linguistic unit word                                                                               |
| 131                             | `"°"`                                                     | degree symbol, non-linguistic                                                                                                   |
| 277                             | `"M"` / `"L"` (SVG path commands)                         | machine format, not text                                                                                                        |
| 319, 326                        | `"—"`, `"+"`, `"−"` in `formatDelta`                      | missing-value dash + mathematical sign glyphs, repo convention                                                                  |
| 331, 338–342                    | `"improved"`/`"regressed"`/`"neutral"` (`DeltaDirection`) | verified at render site (`compare/page.tsx:701-708`): drives an arrow glyph + CSS color class only, never shown as literal text |

### Already wrapped: none

### Signatures

- `computeStatRows(a: ComparableRide, b: ComparableRide)` → `computeStatRows(a: ComparableRide, b: ComparableRide, t: LooseTranslate)` (translate `STAT_DEFS.label`/`.unit` inline, or convert `STAT_DEFS` to a `buildStatDefs(t)` factory)
- No change: `diffQualityBreakdown`, `buildUnifiedRoutePreview`, `formatDelta` (already takes `format`; its only literals are excluded symbols), `deltaDirection`.

**File count needing wrap: 15** · **Already wrapped: 0**

---

## 4. `src/lib/passes-summary.ts`

**Current translation-capability state:** imports only the OpenAPI `paths` type — **no `Formatters`, no `LooseTranslate`, no translation capability whatsoever.** Confirmed live consumers: `PassesPanel.tsx` (imports `MONTH_NAMES`, `monthLabel`, `STATUS_DISPLAY_ORDER` directly — and already imports `LooseTranslate`/`t` for its own use) and `ClosuresPanel.tsx` (`monthLabel`), both of which render the raw English month name with **no** wrapping today.

### User-facing strings needing wrap

| Line | Exact string  | Enclosing fn/const | How rendered                                                            | Suggested approach    |
| ---- | ------------- | ------------------ | ----------------------------------------------------------------------- | --------------------- |
| 10   | `"January"`   | `MONTH_NAMES`      | dropdown option label (`PassesPanel.tsx:221`) and `monthLabel()` return | see design note below |
| 11   | `"February"`  | `MONTH_NAMES`      | same                                                                    | same                  |
| 12   | `"March"`     | `MONTH_NAMES`      | same                                                                    | same                  |
| 13   | `"April"`     | `MONTH_NAMES`      | same                                                                    | same                  |
| 14   | `"May"`       | `MONTH_NAMES`      | same                                                                    | same                  |
| 15   | `"June"`      | `MONTH_NAMES`      | same                                                                    | same                  |
| 16   | `"July"`      | `MONTH_NAMES`      | same                                                                    | same                  |
| 17   | `"August"`    | `MONTH_NAMES`      | same                                                                    | same                  |
| 18   | `"September"` | `MONTH_NAMES`      | same                                                                    | same                  |
| 19   | `"October"`   | `MONTH_NAMES`      | same                                                                    | same                  |
| 20   | `"November"`  | `MONTH_NAMES`      | same                                                                    | same                  |
| 21   | `"December"`  | `MONTH_NAMES`      | same                                                                    | same                  |

### Exclude list

| Line  | String                                                     | Why                                                                                                                                                                                                                                        |
| ----- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 27    | `return ""` (invalid month)                                | empty-string sentinel                                                                                                                                                                                                                      |
| 84–86 | `"closed"`, `"unknown"`, `"open"` (`STATUS_DISPLAY_ORDER`) | `PassStatus` enum, used for iteration order — a caller maps these to its own localized labels rather than displaying the raw string (worth a quick confirm in `PassesPanel.tsx` when PR 2 lands, but out of scope for this lib-only audit) |

### Already wrapped: none

### Design note (surprise, worth flagging to PR 2 authors)

`Formatters` (in `@tarmoto/shared`) already exposes `month(value: DateInput): string` ("Locale month name only, e.g. 'Apr'") and this exact pattern — an Intl-backed month label rather than a hand-rolled English array — is already used elsewhere in the companion (`src/lib/ride-stats.ts:195,506` calls `format.monthYear`/`format.month` against a synthetic anchor date). `MONTH_NAMES`/`monthLabel()` reimplements a solved problem with 12 raw strings that also happen to be **full** names ("January") where `Formatters.month()` currently only produces the **abbreviated** form ("Apr"). Two real options for PR 2:

1. Wrap the 12 names via `t()` (mechanical, matches the brief's `LooseTranslate`-threading convention), or
2. Add a full-month-name method to `Formatters` (mirroring `month()`/`monthYear()`) and delete `MONTH_NAMES` entirely, consistent with how the rest of the app already handles month names.
   Either is valid; (2) avoids 12×N-locale catalog entries for something `Intl.DateTimeFormat` already solves, but is a slightly bigger lib-boundary change than the brief's threading pattern.

### Signatures

- `monthLabel(month: number)` → `monthLabel(month: number, t: LooseTranslate)` **or** `monthLabel(month: number, format: Formatters)` per the note above.
- `MONTH_NAMES` (exported const array) — consumed directly as an array by `PassesPanel.tsx` for `.map()`-building dropdown options, not solely through `monthLabel()`. Recommend leaving it as the canonical English-keyed array and wrapping at each render site (`MONTH_NAMES.map((name, idx) => ({ value: idx + 1, label: t(name) }))`) rather than converting the export itself, since both consumers already have `t` imported directly.

**File count needing wrap: 12** · **Already wrapped: 0**

---

## 5. `src/lib/closures-summary.ts`

**Current translation-capability state:** imports `Formatters` only (no `LooseTranslate`). `formatClosureWindow(closure, format)` threads `Formatters` as the last param already. `buildTripClosureRoutes` takes neither. Confirmed live consumers: `trips/planner/page.tsx`, `trips/[tripId]/page.tsx`, `TripPlannerMap.tsx` (`buildTripClosureRoutes`); `ClosuresPanel.tsx`, `map/MapPointPopover.tsx` (`formatClosureWindow`) — all real, non-test call sites.

### User-facing strings needing wrap

| Line | Exact string                                                   | Enclosing fn/const       | How rendered                                                 | Suggested approach                                |
| ---- | -------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------ | ------------------------------------------------- |
| 110  | `` `Day ${day.dayNumber} · ${day.title}` ``                    | `buildTripClosureRoutes` | `PlannerClosureRoute.label`, trip planner map route selector | thread `t` into `buildTripClosureRoutes(trip, t)` |
| 111  | `` `Day ${day.dayNumber}` ``                                   | `buildTripClosureRoutes` | same field, no-title branch                                  | thread `t`                                        |
| 135  | `` `${format.calendarDate(...)} onward` `` (the word "onward") | `formatClosureWindow`    | closure card/popover window text                             | thread `t` (already takes `format`; add `t`)      |

### Exclude list

| Line  | String                                         | Why                                                                                |
| ----- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| 21–25 | `full`/`partial`/`advisory` (`SEVERITY_ORDER`) | enum keys matching wire `severity`                                                 |
| 29    | `"month must be an integer between 1 and 12"`  | `RangeError` — programmer-facing assertion for invalid input, never surfaced in UI |
| 108   | `` `day-${day.dayNumber}` ``                   | `PlannerClosureRoute.id`, internal identifier/React key, not displayed             |

### Already wrapped: none

### Signatures

- `buildTripClosureRoutes(trip: Trip | null)` → `buildTripClosureRoutes(trip: Trip | null, t: LooseTranslate)`
- `formatClosureWindow(closure: PlannerClosure, format: Formatters)` → `formatClosureWindow(closure: PlannerClosure, format: Formatters, t: LooseTranslate)`
- No change: `previewDateForMonth`, `countClosuresBySeverity`, `sortClosures`, `dedupeClosures`, `detourLengthKm`.

**File count needing wrap: 3** · **Already wrapped: 0**

---

## 6. `src/lib/exploration.ts`

**Current translation-capability state:** imports `kmToMiles`, `metersToFeet`, `UnitSystem` from `@tarmoto/shared` — **no `Formatters`, no `LooseTranslate`.** `buildShareSummary`/`formatDistance` thread a plain `UnitSystem` parameter (a pre-existing, unrelated mechanism, not the `Formatters`/`t` convention).

**Important finding:** grep across all of `src/` shows `groupUnriddenByRegion` and `buildShareSummary` have **no callers outside `src/lib/__tests__/exploration.test.ts`** — both are dead code in production today (the file's own doc comment on `formatDistance` independently admits `buildShareSummary`'s "only real caller is its own unit test"). Only `TIME_PERIOD_LABELS` (imported directly by `src/app/rides/road-map/shared/[token]/page.tsx:169`) and the `TimePeriod` type / `periodStartDate` (referenced, not called, by `road-map-layer.ts`) are confirmed live.

### User-facing strings needing wrap

| Line    | Exact string                                                                                        | Enclosing fn/const                             | How rendered                              | Live?          | Suggested approach                                                                                                                                                                                    |
| ------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 28      | `"All time"`                                                                                        | `TIME_PERIOD_LABELS`                           | direct Record lookup, road-map share page | **yes**        | leave raw + wrap at render site — `src/app/rides/road-map/shared/[token]/page.tsx` already does `import { t } from "@/i18n"`; change the one call site to `t(TIME_PERIOD_LABELS[snapshot.period])`    |
| 29      | `"This year"`                                                                                       | `TIME_PERIOD_LABELS`                           | ditto                                     | **yes**        | same                                                                                                                                                                                                  |
| 30      | `"Last 90 days"`                                                                                    | `TIME_PERIOD_LABELS`                           | ditto                                     | **yes**        | same                                                                                                                                                                                                  |
| 31      | `"Last 30 days"`                                                                                    | `TIME_PERIOD_LABELS`                           | ditto                                     | **yes**        | same                                                                                                                                                                                                  |
| 141     | `"Unnamed"`                                                                                         | `regionLabelFor` (via `groupUnriddenByRegion`) | `RegionBucket.label`                      | no (test-only) | thread `t` into `groupUnriddenByRegion(segments, t)` → `regionLabelFor(roadName, t)` if/when wired to a live UI                                                                                       |
| 143     | `"Unnamed"` (duplicate fallback)                                                                    | `regionLabelFor`                               | same                                      | no (test-only) | same                                                                                                                                                                                                  |
| 191     | `` `I've explored ${...}% of Tarmoto's road network 🏍️` ``                                          | `buildShareSummary`                            | share-text line                           | no (test-only) | thread `t`                                                                                                                                                                                            |
| 193–196 | `` `${...} of ${...} road segments ridden — ${formatDistance(...)} in total.` ``                    | `buildShareSummary`                            | share-text line                           | no (test-only) | thread `t` — note the words need translating even though the **number formatting** (`.toLocaleString()`) is a deliberately pinned exclusion from the separate locale-formatting migration (see below) |
| 200–203 | `` `${TIME_PERIOD_LABELS[...]}: ${...} rides, ${formatDistance(...)} across ${...} active days.` `` | `buildShareSummary`                            | share-text line                           | no (test-only) | thread `t`; also re-consumes `TIME_PERIOD_LABELS` internally here (this usage **does** need lib-side `t`, unlike the direct-render-site usage above)                                                  |
| 206     | `"Join me on Tarmoto."`                                                                             | `buildShareSummary`                            | share-text line                           | no (test-only) | thread `t`                                                                                                                                                                                            |

### Exclude list

| Line    | String                                                                                                     | Why                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 24      | `"all"`, `"year"`, `"90d"`, `"30d"` (`TIME_PERIOD_LABELS` keys, `TIME_PERIOD_LABELS` type)                 | `TimePeriod` enum keys                                                                                                                                                                                                                                                                                                                                                                               |
| 164–178 | entire `formatDistance` helper: `"0 mi"`, `` `${...} ft` ``, `` `${...} mi` ``, `"0 m"`, `` `${...} km` `` | **Pinned exclusion**: this module-private helper's own doc comment states it's a "dead-code candidate, deliberately left off the `src/format` seam" per the locale-formatting migration plan, and its one call site has an explicit `eslint-disable-next-line no-restricted-syntax` marking it a pinned exclusion. Also 100% numeric+unit-abbreviation content with no other natural-language words. |

### Already wrapped: none

### Signatures

- `buildShareSummary(stats: ExplorationStats, period: PeriodStats, units: UnitSystem = "metric")` → `buildShareSummary(stats: ExplorationStats, period: PeriodStats, units: UnitSystem = "metric", t: LooseTranslate)` — low priority, currently dead code.
- `groupUnriddenByRegion(segments: readonly UnriddenSegment[])` → `groupUnriddenByRegion(segments: readonly UnriddenSegment[], t: LooseTranslate)` — low priority, currently dead code.
- `TIME_PERIOD_LABELS` — no lib signature change; fix at the one live render site instead (see table).
- No change: `periodStartDate`, `computePeriodStats`.

**File count needing wrap: 10** (4 confirmed live + 6 in currently-dead code paths) · **Already wrapped: 0**

---

## 7. `src/lib/auth-errors.ts`

**Current translation-capability state:** no `Formatters`, no `LooseTranslate` — the smallest and least-equipped file of the 7. Confirmed live consumer: `getLoginErrorMessage` is called from `LoginForm.tsx:31`, a **client component that already has `const { t } = useI18n();` in scope one line above** (line 23) — trivial to thread.

### User-facing strings needing wrap

| Line | Exact string                                                                               | Enclosing fn/const                                                 | How rendered                                          | Suggested approach                                                                                        |
| ---- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 4–5  | `"This email already has a Tarmoto password account. Sign in with your password instead."` | `SOCIAL_ACCOUNT_CONFLICT_MESSAGE` (const) → `getLoginErrorMessage` | rendered in `LoginForm.tsx` as the login error banner | **do not wrap the constant itself** — see gotcha below; wrap at the `getLoginErrorMessage` return instead |
| 13   | `"We couldn't complete social sign-in. Try again or use your password."`                   | `getLoginErrorMessage`                                             | same error banner                                     | thread `t`, straightforward (not exported/reused elsewhere)                                               |

### Exclude list

| Line | String                      | Why                                                                   |
| ---- | --------------------------- | --------------------------------------------------------------------- |
| 1    | `"social_account_conflict"` | error code, compared/round-tripped via URL query param, not displayed |
| 2    | `"social_signin_failed"`    | same                                                                  |
| 16   | `return ""`                 | empty-string sentinel for "no error to show"                          |

### Already wrapped: none

### Gotcha (surprise — flag prominently for PR 2)

`SOCIAL_ACCOUNT_CONFLICT_MESSAGE` is not only returned by `getLoginErrorMessage` for display — it is **also** used as a cross-module `===` sentinel:

- `src/lib/social-auth-bridge.ts:112` throws `new Error(SOCIAL_ACCOUNT_CONFLICT_MESSAGE)` (server-side, inside a NextAuth callback).
- `src/lib/auth.ts:111` catches it and does `error.message === SOCIAL_ACCOUNT_CONFLICT_MESSAGE` to decide whether to redirect to `/login?error=social_account_conflict` vs. the generic `social_signin_failed`.

Neither of those two call sites is inside the 7 audited files, but they consume this file's export, so the hazard belongs here: **if the constant itself is translated (e.g. by making it a function of `t`, or having `social-auth-bridge.ts` throw a localized message), the `auth.ts` string-equality check will silently stop matching for any non-English locale**, misrouting affected users to the generic sign-in-failed message and losing the specific "you already have a password account" guidance. The safe fix is to leave `SOCIAL_ACCOUNT_CONFLICT_MESSAGE` as the stable English sentinel/key exactly as-is, and have `getLoginErrorMessage` call `t(SOCIAL_ACCOUNT_CONFLICT_MESSAGE)` at the return boundary only — translation happens where the text is displayed, not where it's used as an internal discriminant.

### Signatures

- `getLoginErrorMessage(errorCode: string | null)` → `getLoginErrorMessage(errorCode: string | null, t: LooseTranslate)`
- `SOCIAL_ACCOUNT_CONFLICT_MESSAGE`, `SOCIAL_ACCOUNT_CONFLICT_ERROR`, `SOCIAL_SIGNIN_FAILED_ERROR` — no change (kept as raw English sentinel / error codes).

**File count needing wrap: 2** · **Already wrapped: 0**

### Bonus finding (out of scope, flagged only in passing)

`social-auth-bridge.ts` (not one of the 7 audited files) has 4 more hardcoded English error strings thrown from the same auth flow ("Social sign-in requires an email address.", "AUTH_SECRET must be configured for social sign-in.", "Could not finish social sign-in.", "Could not sign in with this social account."). Worth a follow-up ticket since they're adjacent to this exact surface, but excluded from counts here as explicitly out of scope.

---

## Grand total

| File                |                        Needing wrap | Already wrapped |
| ------------------- | ----------------------------------: | --------------: |
| gamification.ts     | 53 (24 live + 29 test-fixture-only) |               8 |
| subscription.ts     |                                  45 |               0 |
| ride-compare.ts     |                                  15 |               0 |
| passes-summary.ts   |                                  12 |               0 |
| closures-summary.ts |                                   3 |               0 |
| exploration.ts      |           10 (4 live + 6 dead-code) |               0 |
| auth-errors.ts      |                                   2 |               0 |
| **Total**           |                             **140** |           **8** |
