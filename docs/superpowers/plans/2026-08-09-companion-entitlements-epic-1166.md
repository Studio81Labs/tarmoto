# Companion Entitlement & Billing Epic — Implementation Plan (#1166)

> **For agentic workers:** implement one PR per section, in the order given inside each track. Every PR must leave the repo green on its own. Steps use checkbox (`- [ ]`) syntax.

**Goal:** close every companion-side feature-flag, limit, system-switch and payment-surface gap found by the cross-app audit, so re-running it produces zero `Gap` and zero `Partial` rows.

**Epic:** #1166 · **Sub-issues:** #1169 (A), #1168 (B), #1170 (C), #1171 (D), #1172 (E), #1167 (F)
**Audited at:** `2d43dc7a` · **Plan verified against the same tree on 2026-08-09.**

---

## 0. Verification pass — what the code says that the issues do not

Five findings from reading the tree. Three change scope; two remove risk.

### 0.1 `advanced_analytics` has no endpoint to gate (changes #1167 substantially)

#1167 prescribes `@RequireFeature('advanced_analytics')` "on the stats endpoint". There is no such endpoint.

| Surface                                                                                     | Data source                                                                                                                | Gateable server-side?                                                                                                              |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `/rides/stats` totals, distance series, calendar heatmap, YoY, annual totals, quality trend | `fetchAllRides()` → `GET /api/v1/rides`, paged 100/req, **all aggregation is client-side `useMemo`** (`lib/ride-stats.ts`) | **No** — `GET /rides` is base ride history, owned by every tier                                                                    |
| `/rides/stats` surface + curviness breakdown cards                                          | `fetchRideBreakdown()` → `GET /api/v1/rides/stats/breakdown` (`lib/rides-breakdown.ts:64`)                                 | **Yes** — dashboard-exclusive                                                                                                      |
| Ride History KPI cards on `/rides`                                                          | `useRideStats()` → `GET /api/v1/rides/stats` (`app/(dashboard)/rides/page.tsx:49`)                                         | **Must stay open** — this is the endpoint whose name matches the issue, and gating it breaks the Free ride list, not the dashboard |

`GET /rides/stats/breakdown` is the only server aggregate exclusive to the analytics dashboard.

**Decision (2026-08-09):** gate the **whole `/rides/stats` route** client-side, and `@RequireFeature('advanced_analytics')` on `GET /rides/stats/breakdown`. Record in `docs/feature-flags.md` that the remainder is a **UI-capability gate**, not a data gate, because the inputs are the rider's own ride rows — a server gate there is architecturally unachievable while `GET /rides` returns full rows.

### 0.2 `next: { revalidate }` is a no-op in production (changes #1168's mechanism)

`apps/companion/open-next.config.ts` deliberately leaves `incrementalCache` unset:

> _"we deliberately leave incrementalCache unset: the companion has no ISR/SSG output today … **Revisit if we add cached fetch / `revalidate` routes.**"_

#1168 prescribes exactly a cached-fetch/`revalidate` route. Under the Workers in-memory default the cross-request cache is per-isolate and short-lived, so the flag read becomes a **blocking backend round-trip on the critical path of the highest-traffic public SEO pages**. (`fetchBestRoads`'s `revalidate: 604800` already has this latent problem.)

**Design answer for Workstream B:**

- React `cache()` for guaranteed **per-request** dedupe (works regardless of adapter) — one fetch per render even with several gated components.
- `next: { revalidate: 60 }` retained as a best-effort cross-request layer, matching the endpoint's `Cache-Control: public, max-age=60`.
- `AbortSignal.timeout(1500)` so a slow or dead `/config/flags` **fails safe fast** instead of hanging a public page.
- File the incremental-cache provisioning (R2/KV binding) as a separate ops follow-up — out of scope here.

### 0.3 All six public routes are already `force-dynamic` (removes risk from #1168)

`roads/best/[country]/[region]`, `.../[subregion]`, `community/collections/shared/[slug]`, `trips/shared/[token]`, `rides/shared/[token]`, `rides/road-map/shared/[token]` all declare `export const dynamic = "force-dynamic"`. No ISR page cache sits between an operator flip and the response, so #1168's "restores within the 60s window without a deploy" is achievable. Pin it with a comment so a future `revalidate` addition doesn't silently reintroduce a stale gate.

### 0.4 `UpgradePrompt` already has the no-CTA path (shrinks Workstream A)

`components/entitlements/UpgradePrompt.tsx:60` resolves `target`; `target === null` already yields `modalTitle = "Limit reached"` and `cta = null`, on both variants. So "suppress the CTA under `sys_billing_checkout`" is a three-line change **inside the component**, covering all call sites (trip-limit modal, collaborator cap, GPX export menus, `LockedFeatureCard` teasers, the explore zoom nudge) at once. Do not edit call sites.

### 0.5 Smaller corrections

- Component paths in #1168 are stale: `BestRoadsList.tsx` / `BestRoadsSchemaOrg.tsx` live at `app/roads/best/[country]/[region]/_components/`.
- `KillSwitchGate` is typed `FreeToggleFeatureKey` and cannot take a `sys_*` key — Workstream C needs a sibling or a generalization.
- `trial_eligible` is already present in the subscription page's test fixtures; only `normalizeSubscriptionSnapshot` (`lib/subscription.ts:171`) drops it. D1's wire side is free.
- `PLAN_COPY` bullets are typed `EnglishMessageKey[]`, so D2's registry derivation must still produce typed keys.

### 0.6 Folded in from review of this plan (#1175)

Four defects in the plan's own prescriptions, all verified against the tree and corrected in place:

| Where | Defect                                                                                                                                                               |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR 12 | `@RequireFeature` alone attaches metadata nothing reads — `FeatureGuard` is **not** global, so the endpoint would have shipped ungated behind a passing-looking plan |
| PR 12 | `@RequireFeature` contributes no OpenAPI response, so `openapi:gen` would not have produced the promised 403 contract                                                |
| PR 8  | Stripe Checkout is a full cross-origin navigation — a trial marker held in React state does not survive the return, so the success banner could not have used it     |
| PR 3  | Returning `null` on a flags-fetch failure is correctly fail-safe but silent, leaving an operator unable to detect that killed public content is still being served   |

Second round:

| Where | Defect                                                                                                                                                                                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR 3  | **Hiding ≠ removing at a client boundary.** `BestRoadsPageBody` (server) passes `roads` — `quality_score` included — into `BestRoadsMap` (`"use client"`), so Next serializes every score into the Flight payload inside the HTML. Gating the list figure and the JSON-LD would have left the page failing its own `curl`-the-HTML acceptance criterion |
| PR 6  | `sys_gamification` was scoped to two surfaces; `CommunitySidebar`'s active-challenge card and the rider profile's badge shelf also render the emptied lists, so a kill would still read as genuine "nothing here yet" on both                                                                                                                           |
| PR 7  | The C4 task was unimplementable — the companion makes no closure-detail request for `ClosuresPanel` to classify. Dropped, with a note on why the list path must **not** be substituted for it                                                                                                                                                           |

The two P1s would each have produced a change that looked complete and enforced nothing: an ungated endpoint, and a public page still publishing the killed data. That is the failure mode this plan exists to prevent, so both are recorded rather than quietly fixed.

---

## 1. Decisions locked (2026-08-09)

| #   | Decision                                                                                      | Consequence                                                                                                |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| D-1 | `advanced_analytics` gates the **whole** `/rides/stats` route + `GET /rides/stats/breakdown`  | PR 11 / PR 12                                                                                              |
| D-2 | **Ship live** — no launch `force_on` seed. Genuinely Free riders lose `/rides/stats` on merge | **No migration.** #1104 stays at nine overrides. Call it out in the PR body and in `docs/feature-flags.md` |
| D-3 | D5 (plan step after registration) ships as a **follow-up issue**, not in this epic            | File the issue; record the rationale in #1171                                                              |

---

## 2. Global constraints

- **i18n:** every new user-facing string needs a key in `apps/companion/src/i18n/locales/en/<module>.ts` (`common`, `settings`, `rides`, `community`, `achievements`, `map`, `trips`, `auth`, `regions`). The typed `t()` → `EnglishMessageKey` guard and the ESLint rule fail the build otherwise. Reuse `"This feature is temporarily unavailable. Please try again later."` (`common.ts:18`) for switch-off states so the four Workstream C surfaces read consistently.
- **Fail-safe direction is not negotiable.** `useSystemSwitch` / `useFeatureKillSwitch` report **enabled** until a `force_off` is confirmed. The new server reader must match. A kill switch that blanked surfaces on a slow load causes more outage than it prevents.
- **Fail-closed direction for entitlements.** Tier gates key on `isSuccess`, never `isLoading` — see `hooks/useEntitlements.ts:281-287` for the auth-hydration window where the `/users/me` query is disabled and reports `isLoading:false, isSuccess:false`.
- Companion CI typechecks **test files** — run `tsc --noEmit` after editing tests, not just source.
- Conventional commits, lowercase subject, scope required. Link the issue. Add scope labels.
- No broad `try/catch`, no silent fallbacks.

**Per-PR validation (companion):**

```bash
pnpm --filter @tarmoto/companion test
pnpm --filter @tarmoto/companion lint
pnpm --filter @tarmoto/companion exec tsc --noEmit
pnpm companion:build          # PRs 3, 4 (RSC changes) and 8-10
```

**Additional for backend / shared PRs:** `pnpm --filter @tarmoto/backend test`, `pnpm shared:build`, `pnpm openapi:gen` (also the strict-tsc oracle — local `nest build` misses `noUncheckedIndexedAccess`).

---

## 3. PR sequence — 14 small PRs in 6 tracks

Tracks are mutually independent and can run in parallel. **The one hard serialization** is the three PRs touching `app/(dashboard)/settings/subscription/page.tsx` (908 lines): **PR 2 → PR 8 → PR 9**. PR 10 also follows PR 8 (both touch `lib/subscription.ts`). PR 14 lands last.

| PR  | Title                                                                | Track | Issue | Size | Depends on |
| --- | -------------------------------------------------------------------- | ----- | ----- | ---- | ---------- |
| 1   | suppress upgrade CTAs when `sys_billing_checkout` is off             | A     | #1169 | XS   | —          |
| 2   | disable checkout on the billing page, keep the portal open           | A     | #1169 | S    | —          |
| 3   | server-side operator flag reader + best-roads quality/JSON-LD        | B     | #1168 | M    | —          |
| 4   | take public share routes down when `community_access` is killed      | B     | #1168 | S    | PR 3       |
| 5   | gate the review composer on `sys_poi_ratings` (+ `SystemSwitchGate`) | C     | #1170 | S    | —          |
| 6   | gate achievements + exploration on `sys_gamification`                | C     | #1170 | S    | PR 5       |
| 7   | explain killed discover feed + NAP-closure detail 404                | C     | #1170 | XS   | PR 5       |
| 8   | surface the 14-day trial before checkout                             | D     | #1171 | M    | PR 2       |
| 9   | cancelled-but-entitled state, resume action, store links             | D     | #1171 | S    | PR 8       |
| 10  | derive plan-card copy from the feature registry                      | D     | #1171 | M    | PR 8       |
| 11  | gate `/rides/stats` behind `advanced_analytics` (companion)          | F     | #1167 | S    | —          |
| 12  | gate `GET /rides/stats/breakdown` on `advanced_analytics` (backend)  | F     | #1167 | XS   | PR 11      |
| 13  | delete the unused `FeatureGate` component                            | E     | #1172 | XS   | —          |
| 14  | reconcile the feature-flag catalog with the registry                 | E     | #1172 | S    | 1-12       |

Plus two issues to file, no code: **D5 registration plan step**, **OpenNext incremental cache provisioning**.

---

## Track A — revenue containment (#1169, P1)

### PR 1 — `fix(companion): suppress upgrade CTAs when sys_billing_checkout is off`

The highest value-per-line change in the epic: one component, every upsell in the app.

**Files:** `components/entitlements/UpgradePrompt.tsx`, `UpgradePrompt.test.tsx`

- [ ] `const { enabled: checkoutEnabled } = useSystemSwitch("sys_billing_checkout")`
- [ ] `const target = suppressUpgrade || !checkoutEnabled ? null : resolveTarget(...)` — reuses the existing `target === null` no-CTA path, so `modalTitle` becomes "Limit reached" and `cta` is `null` on both variants with no new branch
- [ ] Tests: `force_off` → no CTA on `inline` **and** `modal`; portal-independent; unresolved flag map → CTA present (fail safe); live flip within the poll interval

**Do not** touch call sites. **Do not** add upsell framing — an operator kill is not something a rider can buy past.

### PR 2 — `fix(companion): disable checkout on the billing page, keep the portal open`

**Files:** `app/(dashboard)/settings/subscription/page.tsx`, `page.test.tsx`

- [ ] Read `useSystemSwitch("sys_billing_checkout")` in `SubscriptionPageInner`
- [ ] Disable every control routing to `openCheckout` (`:222`, plus the `:291`/`:304` branches of the plan-action handler) with an explanatory note
- [ ] **Leave every `openPortal` path reachable** — header "Open billing portal" (`:334`), `payment_method_update` (`:413`), `subscription_cancel` (`:477`), `subscription_update` (`:313`), and the retention dialog. The backend leaves `createPortalSession` ungated on purpose (`account.service.ts:357-361`): trapping a paying rider is worse than the failure the switch contains.
- [ ] Handle `paidPlanNeedsCheckout` (`:277`): that rider routes **every** plan action through Checkout, so with the switch off they have no action at all — the card must explain why rather than sit inert
- [ ] Tests: checkout disabled under `force_off`; **each** portal flow still opens; `paidPlanNeedsCheckout` card explains itself; unresolved → enabled; live flip

---

## Track B — server-side enforcement (#1168, P1)

### PR 3 — `feat(companion): read operator flags server-side and strip killed quality from best-roads`

Introduces the capability and its first consumer together, so nothing lands unused.

**New:** `lib/serverFlags.ts` + test
**Modify:** `app/roads/best/[country]/[region]/_components/BestRoadsList.tsx`, `BestRoadsSchemaOrg.tsx`, `BestRoadsPageBody.tsx`, `[region]/page.tsx`, `[subregion]/page.tsx` + tests

- [ ] `getServerFlagStates()`: `apiServer.GET("/api/v1/config/flags", { next: { revalidate: 60 }, signal: AbortSignal.timeout(1500) })`, wrapped in React `cache()` for per-request dedupe (see §0.2). Returns `null` on failure/timeout.
- [ ] Thin typed helpers over the shared resolvers — `serverKillSwitch(key)` / `serverSystemSwitch(key)` delegating to `resolveFeatureKillSwitch` / `resolveSystemSwitch`. **Do not re-implement the precedence.**
- [ ] Fails **safe**: `null` states → enabled.
- [ ] **Report the failure — do not swallow it.** Fail-safe is the right behaviour, silence is not: an operator who flips a kill switch has no way to tell it isn't taking effect, and the failure mode is "killed public content keeps being served". Emit a scoped `console.warn` on timeout/error (distinguishing the two) before returning `null`. Cloudflare captures worker logs — `wrangler.jsonc` has `"observability": { "enabled": true }` — so this is visible without new infrastructure, and it matches the companion's existing convention (`lib/socket.ts:110`, `lib/unit-preference.ts:28`). AGENTS.md forbids silent fallbacks; a safety mechanism that degrades invisibly is exactly the case it has in mind.
- [ ] Resolve `road_quality_overlay` in the region/subregion pages. Killed → **strip `quality_score` from the road objects themselves, server-side, before anything renders or crosses a client boundary.** Then:
  - `BestRoadsList`: renders the row without the quality figure (curviness + distance remain, so no 404 is needed)
  - `BestRoadsSchemaOrg`: omits quality from the JSON-LD `description` entirely — no placeholder
- [ ] **Hiding is not removing at a client boundary.** `BestRoadsPageBody` is a server component that passes `roads={roads}` — `quality_score` included — into `BestRoadsMap`, which is `"use client"`. Next serializes client-component props into the RSC Flight payload **embedded in the HTML**, so gating the map layer inside the client hook leaves every score in `view-source:` regardless. Sanitising the data at the source is what actually satisfies the acceptance criterion; per-component hiding cannot. Applies to both prop sites (`BestRoadsPageBody:116` map, `:179` schema.org) and to any client component added later.
- [ ] Check the country index and `roads/best` hub for the same fields (prose mentions of "quality scores" in marketing copy are static, not data — leave them, note the decision)
- [ ] Comment on each page that `dynamic = "force-dynamic"` is what makes the 60s restore window real (§0.3)
- [ ] Tests assert **rendered RSC output** (`render(await Page({ params }))`, the existing pattern in `[country]/page.test.tsx`): no quality figure in the list, no quality value in the JSON-LD, a failing flags fetch renders normally, **and the failure path warns**
- [ ] **One test must assert on the serialized payload, not the rendered tree** — the props handed to the client component must not contain `quality_score` at all. A DOM-text assertion passes while the score sits in the Flight payload, which is precisely the bug this PR exists to fix. Manual check is `view-source:`, not devtools.

### PR 4 — `fix(companion): take public share routes down when community_access is killed`

**Files:** `app/community/collections/shared/[slug]/page.tsx`, `app/trips/shared/[token]/page.tsx`, `app/rides/shared/[token]/page.tsx`, `app/rides/road-map/shared/[token]/page.tsx` + tests

- [ ] Resolve `community_access` **before** the content fetch in each route — the acceptance criterion is that the collection is not fetched at all
- [ ] Killed → a neutral "temporarily unavailable" body (preferred over `notFound()`, which miscommunicates a moderation pause as a dead link). **No upsell.**
- [ ] Keep the existing client gates (`KillSwitchShareCta`, `SharedMap.client.tsx`) as defence in depth
- [ ] **Sweep deliverable:** enumerate all 12 non-client `page.tsx` files and record coverage or an explicit reason. Current inventory:
      `(auth)/login`, `(auth)/register` — no flag-gated content
      `(dashboard)/community/page`, `(dashboard)/community/rides/[rideId]` — behind `community/layout.tsx`'s `KillSwitchGate`, authenticated, not crawlable → client gate sufficient
      `roads/best` hub + `[country]` — no per-road data
      the four share routes + two best-roads region routes — covered by PR 3/PR 4
- [ ] Tests on rendered RSC output; assert the fetch was **not** called under `force_off`

---

## Track C — remaining operator switches (#1170, P2)

### PR 5 — `feat(companion): gate the review composer on sys_poi_ratings`

**New:** `components/entitlements/SystemSwitchGate.tsx` + test — sibling of `KillSwitchGate` typed to `SystemFeatureKey`, same `Card` + `CircleSlash` + copy. (Generalizing `KillSwitchGate` to a union key is the alternative; a sibling keeps each component's key type exact.)
**Modify:** `components/RoadReviewsPanel.tsx` + test

- [ ] Gate the **compose affordance** on `useSystemSwitch("sys_poi_ratings")` so the rider never composes a review, uploads photos and meets a 503 at `roadsApi.createReview` (`:329`) with the form still full
- [ ] **Leave the read side rendered** — the backend keeps reads open
- [ ] Cover the vote endpoints if they share the `@RequireSystemSwitch` guard (verify in the backend controller before deciding)
- [ ] Existing `community_access` gate at `:926` stays; the two compose independently

### PR 6 — `feat(companion): gate achievements and exploration on sys_gamification`

**Files:** `app/(dashboard)/achievements/page.tsx`, `app/(dashboard)/rides/road-map/` exploration panel, `components/community/CommunitySidebar.tsx`, `app/(dashboard)/community/[riderId]/page.tsx` + tests

- [ ] Gate on `useSystemSwitch("sys_gamification")` across **all four** consumers, not just the achievements page. The switch makes the backend return empty lists, so any surface that renders those lists misreports an operator kill as genuine "you have nothing yet" — the exact failure the epic's definition of done forbids:
  - `achievements/page.tsx` — the module
  - `rides/road-map` — the exploration panel
  - `CommunitySidebar.tsx:54` (`fetchActiveChallengeCard`) — the active-challenge card silently disappears
  - `community/[riderId]/page.tsx:81` (`fetchPublicBadges` → `BadgesSection`) — renders an empty badge shelf on someone's profile
- [ ] Verified **not** consumers despite mentioning the word: `(dashboard)/page.tsx` and `community/feed/page.tsx` make no gamification call. Recorded so the sweep isn't redone.
- [ ] The backend degrades three ways at once — 503 on challenge join (`:232`), 404 on challenge detail, silent-empty on lists/exploration. All three must land on the **same** explained state; in particular the challenge-detail deep link must not render a not-found page
- [ ] Existing `community_access` gate at `:1181` stays

### PR 7 — `fix(companion): explain a killed discover feed`

- [ ] `sys_community_collections`: swap the discover **empty state** for the unavailable notice when killed. **Do not** gate the rest of the collections surface — the backend scopes this switch to `listDiscover` only and deliberately keeps `getBySlug`, previews, followed collections and follow actions open.

**C4 (`sys_nap_conditions`) is dropped — the task it describes cannot be done.** #1170 asks to classify a NAP-closure _detail_ 404 in `ClosuresPanel`, but the companion issues no such request: `lib/api/closures.ts` exposes only `GET /api/v1/closures` (`:34`) and `POST /api/v1/closures/check-route` (`:41`). The backend does have `GET closures/:id` (`closures.controller.ts:71`) — it simply has no companion consumer, which is why the 404 has nowhere to surface.

Do **not** substitute the list path for it. A list error or an empty result is not evidence of a kill: NAP-sourced closures vanishing is the switch working as designed, and plenty of regions legitimately have no NAP data. Treating either as "temporarily unavailable" would misreport ordinary failures and empty regions.

- [ ] Record the finding on #1170 and close C4 as not-applicable
- [ ] If a closure-detail view is ever built, the 404 handling ships **with** it — same rule the epic applies to every other unbuilt surface

**Track C shared tests, per switch:** killed state, fail-safe default, live flip, and that the deliberately-open paths stay open.

---

## Track D — billing surface (#1171, P2)

### PR 8 — `feat(cross): surface the 14-day trial before checkout`

**Files:** `packages/shared/src/…` (new `INTRO_TRIAL_DAYS`), `apps/backend/src/modules/account/account.service.ts:59` (re-point), `apps/companion/src/lib/subscription.ts`, `app/(dashboard)/settings/subscription/page.tsx`, tests, i18n `settings.ts`

- [ ] Move `INTRO_TRIAL_DAYS = 14` into `@tarmoto/shared` and re-point the backend constant in the same commit; the companion copy interpolates it rather than hardcoding "14"
- [ ] Carry `trial_eligible` → `trialEligible` through `SubscriptionSnapshot` and `normalizeSubscriptionSnapshot` (`:171`), plus `buildFallbackSubscriptionSnapshot` (fallback: `false`, the safe claim)
- [ ] Paid plan cards: "14 days free" badge and CTA "Start free trial" when eligible
- [ ] Success banner (`page.tsx:361`): stop inferring trial state from `currentPlan.status === "trialing"` — that status usually hasn't landed because the webhook is still in flight, so a rider who just started a trial currently reads "Subscription confirmed"
- [ ] **Carry the trial marker durably across Checkout.** Stripe is a full cross-origin navigation: the page unmounts and remounts on `?checkout=success`, so a value held in React state before `window.location.assign` is gone by the time the banner renders. Have the backend append the marker to its `success_url` when it actually passed `trialDays` (e.g. `?checkout=success&trial=1`) — server-authoritative, so it reflects what Stripe was _told_ rather than eligibility at click time, and the existing `router.replace` that strips `?checkout` cleans it up for free (`page.tsx:119-124`). Client-side `sessionStorage` is the fallback if the `success_url` cannot be changed, but it records the wrong fact and needs its own cleanup.
- [ ] Tests: badge on/off, CTA copy, banner copy under a not-yet-arrived webhook, **the marker surviving a hard navigation** (remount with the query param, not a state transition), `shared:build` + backend green

### PR 9 — `feat(companion): show the cancelled-but-entitled state and link store-managed plans`

**Files:** `app/(dashboard)/settings/subscription/page.tsx` (`CancelPlanCard` `:765`, `StoreManagedPanel` `:802`), `lib/subscription.ts`, tests, i18n

- [ ] `cancelAtPeriodEnd === true` → replace the danger-styled cancel card with a "Scheduled to end {date}" state, and add **Resume subscription** opening `openPortal("subscription_update")`
- [ ] Reflect the scheduled end in the plan grid, not only in the `describeRenewal` sentence (`lib/subscription.ts:246`)
- [ ] `StoreManagedPanel` says "Open it to change or cancel your plan" and renders no link — add `https://apps.apple.com/account/subscriptions` and `https://play.google.com/store/account/subscriptions`, selected by `managedBy`
- [ ] Resume must remain reachable under `sys_billing_checkout` `force_off` (it is a portal flow, not checkout) — assert it, it is the exact trap PR 2 exists to avoid

### PR 10 — `refactor(companion): derive plan-card copy from the feature registry`

**Files:** `lib/subscription.ts`, `lib/__tests__/subscription.test.ts`, i18n

- [ ] Replace the static `PLAN_COPY` feature lists with derivation from `FEATURE_DEFINITIONS`: tier grants for toggles, tier values for limits
- [ ] Per-key copy map typed as an **exhaustive** `Record<ToggleFeatureKey | LimitFeatureKey, { label: EnglishMessageKey; platform: "web" | "mobile" | "all" }>` — exhaustiveness is what makes a retired or re-tiered flag a typecheck failure instead of a stale marketing claim. Keeps `packages/shared` untouched.
- [ ] `platform: "mobile"` annotates capabilities the companion does not implement (`offline_maps`, `group_rides`, …) rather than implying they work on web — registry derivation alone does **not** fix this, since the registry grants them regardless of platform
- [ ] Adds the currently-omitted `max_trip_collaborators` (Pro = 5), one of the few limits the web app actually enforces
- [ ] Keeps "Advanced analytics" on the Premium card — correct once PRs 11/12 land (D-1)
- [ ] Test: a bullet cannot claim a capability the registry does not grant that tier; adding a registry key without a copy entry fails typecheck

---

## Track F — `advanced_analytics` (#1167, P1)

Companion **before** backend: gating the client first means Free riders lose the page while the endpoint stays open (invisible). The reverse order shows two broken cards on an otherwise-working page.

### PR 11 — `feat(companion): gate /rides/stats behind advanced_analytics`

**Files:** `app/(dashboard)/rides/stats/page.tsx`, test, i18n `rides.ts`, `docs/feature-flags.md`

- [ ] `useFeature("advanced_analytics")`, failing closed on `isSuccess` (never `isLoading` — `useEntitlements.ts:281-287`)
- [ ] Non-entitled → keep `StatsPageHeader` and render a `LockedFeatureCard` teaser, so the route never shows an unexplained gap; `UpgradePrompt` resolves the target via `upgradeTierForFeature`
- [ ] Skip `fetchAllRides()` when locked — it pages the entire ride history 100 at a time and there is no reason to pay for it behind a gate
- [ ] Record the scope decision **and** its rationale in `docs/feature-flags.md` §6.2: whole route gated client-side; only `stats/breakdown` is server-enforced; the rest is a UI-capability gate because the inputs are the rider's own ride rows (§0.1)
- [ ] **State D-2 explicitly in the PR body:** no launch seed, genuinely Free riders lose the page on merge, #1104 stays at nine overrides
- [ ] Tests: entitled renders, non-entitled locked, unresolved locked, live upgrade unlocks without reload, no ride fetch while locked

### PR 12 — `feat(backend): gate the ride breakdown aggregate on advanced_analytics`

**Files:** `apps/backend/src/modules/rides/rides.controller.ts:189`, spec, `pnpm openapi:gen`

- [ ] **`@UseGuards(FeatureGuard)` _and_ `@RequireFeature('advanced_analytics')`** on `GET stats/breakdown` only. `FeatureGuard` is **not** global — `RidesController` installs only `AuthGuard` at class scope (`:51`), and `@RequireFeature` alone just attaches metadata nothing reads. Every existing gated handler pairs them: `:81/:82` (`gpx_import`), `:142/:143` and `:240/:241` (`gpx_export`). Decorator without guard = an endpoint that looks gated, is not, and whose 403 test would be written against the wrong behaviour.
- [ ] **Declare the 403 explicitly:** `@ApiResponse({ status: 403, type: FeatureForbiddenDto })`. `@RequireFeature` contributes nothing to the OpenAPI document, so `openapi:gen` alone will not emit the contract — `:89-90` is the existing precedent, and `FeatureForbiddenDto` already exists at `modules/features/dto/feature-forbidden.dto.ts`. Without this the runtime behaviour and the generated client drift.
- [ ] **Do not touch** `GET stats` (`:177`) — it serves the Ride History KPI cards for every tier (§0.1). Add a comment saying so; the two routes sit twelve lines apart and the next reader will assume they belong together.
- [ ] Spec: entitled 200, non-entitled 403, **and** a Free rider still gets 200 from `GET /rides/stats` (regression guard on the miswiring above)
- [ ] `pnpm openapi:gen` (the path gains a 403) and regenerate the companion client

---

## Track E — cleanup (#1172, P3)

### PR 13 — `chore(companion): delete the unused FeatureGate component`

**Files:** delete `components/entitlements/FeatureGate.tsx` + `FeatureGate.test.tsx`; check `components/entitlements/index.ts` for an export

Zero production call sites. It gates on `isLoading`, not `isSuccess`, so during the auth-hydration window it renders `children` — the exact fail-open every real gate avoids. Today `!tier` covers it incidentally; a refactor dropping that check would silently fail open. Deleting is lower-risk than keeping a tested, unused invitation to adopt a weaker contract.

### PR 14 — `docs: reconcile the feature-flag catalog with the registry`

Lands last so it documents shipped behaviour.

- [ ] Add `sys_billing_checkout` to §3 and the Phase 2b enforcement table, with the operationally decisive detail: **gates new checkout sessions (503); the billing portal stays open so existing subscribers can still manage or cancel**
- [ ] Correct the counts at `docs/feature-flags.md:18, :200, :211, :213, :256` → **15 switches, 14 of 15 enforced**, `sys_booking_affiliate` the sole pending one
- [ ] Update §6.2 for `advanced_analytics` (now enforced, no launch seed — the "9 seeded dark" note is unchanged, and say why)
- [ ] Update §6.3 companion coverage for tracks A-D
- [ ] Cross-read `packages/shared/src/feature-flags.ts` against the catalog rather than trusting the prose counts

---

## 4. Follow-up issues — filed, no code here

1. **#1173 — plan selection after registration** (D-3). `app/(auth)/register/page.tsx` has no plan step; a new rider must find `/settings/subscription` unaided. Its own onboarding UX (skip path, post-checkout return, trial framing). Reuses PR 8's `trial_eligible` snapshot and PR 10's registry-derived copy; sequenced **after #1104**, since a plan step sells nothing coherent while the `launch_tier` gift is active.
2. **#1174 — provision an OpenNext incremental cache.** `open-next.config.ts` leaves `incrementalCache` unset, so `next: { revalidate }` on `fetchBestRoads` (weekly) and the new flag reader has no durable store. Needs an R2/KV binding. **Not blocking PR 3** — §0.2's per-request `cache()` + timeout bounds the cost.

---

## 5. Definition of done for the epic

1. Re-running the audit produces zero `Gap` and zero `Partial` rows across all three matrices.
2. Every remaining `N/A` matches the permanent list in #1166's "Definition of green".
3. Flipping `sys_billing_checkout`, `sys_poi_ratings`, `sys_gamification`, `sys_community_collections` to `force_off` produces an **explained** unavailable state — never a raw 503/404, never a silent empty state.
4. With `road_quality_overlay` or `community_access` at `force_off`, `view-source:` on every public route shows no killed content and no killed JSON-LD.
5. Checkout CTAs are disabled under `sys_billing_checkout` `force_off` while **every** portal flow stays reachable.
6. `trial_eligible` is surfaced before Checkout; plan-card copy is registry-derived.
7. `docs/feature-flags.md` counts match the registry.
8. No regression in the three already-green limits (`max_active_trips`, `max_trip_collaborators`, `road_quality_max_zoom`).

**Manual operator pass before closing:** flip each of the five switches in Admin → System switches and walk each surface, including a **hard reload** (not client nav) for Track B — the client gate hides the content either way, so only the raw HTML proves the server fix.
