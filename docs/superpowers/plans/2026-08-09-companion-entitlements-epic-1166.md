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

Third round:

| Where | Defect                                                                                                                                                                                                                                                                                                                                                                                         |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR 4  | **`generateMetadata` is a second entry point.** Next runs it independently of the page component; on the shared-collection route it fetches the collection itself and builds `<head>` title/description from it. Gating only the page still fetched the killed content and serialized it into the HTML. Applies to every route in Track B — all four share routes have one, best-roads has two |
| PR 5  | The vote instruction said to check for a controller `@RequireSystemSwitch`. There is none — the check is service-level in `castVote`, so the plan's own verification step would have concluded votes are ungated. `clearVote` is deliberately open so a rider can retract mid-incident                                                                                                         |

Fourth round:

| Where | Defect                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR 4  | The share routes were gated on `community_access` only. The flags are independent: with `road_quality_overlay` killed and `community_access` on, `rides/shared/[token]:109-112` still prints `avg_road_quality` and `rides/road-map/shared/[token]:164-169` still ships `last_quality_score` into a client component — the same Flight-payload leak as best-roads, on a route the sweep had already "covered" |
| PR 6  | `sys_gamification` is defined as _"Badges, challenges, personal road map"_ (`feature-flags.ts:312`), so the public shared road map is in scope and was missing. It serves anonymous visitors, so it needs a server gate; the backend's `getByToken` has no switch check either (filed separately)                                                                                                             |

Fifth round:

| Where | Defect                                                                                                                                                                                                                                                                |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR 4  | A **third** share route leaks quality under `road_quality_overlay`: `fetchSharedCollectionPreview()` carries `quality_avg`, rendered at `collection-route-atoms.tsx:200` and passed whole into the `"use client"` `CollectionPreviewMap`                              |
| PR 5  | **The epic's premise was wrong.** `sys_poi_ratings` does _not_ keep reads open — `listForSegment` returns `[]` before querying (`reviews.service.ts:210-214`), so "leave the read side rendered" produces the exact silent empty state the definition of done forbids |

Sixth round — both are the **trap-user-content** rule, which the plan had been applying case by case instead of as a principle:

| Where | Defect                                                                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PR 5  | `ReviewsService.delete` (`:414`) is ungated, but the new unavailable read state hides the rider's own review — the only place the panel offers deletion. After a reload their review is stranded, still published, unremovable |
| #1176 | The backend follow-up was scoped to `getByToken`. `MapSharesService.create` (`:24`) is equally ungated, so clients keep minting and persisting new snapshots during a shutdown                                                 |

**The rule, stated once so it stops being rediscovered:** a kill switch may stop new content and hide published content, but it must **never** remove a rider's ability to withdraw what is already theirs. It holds for the billing portal under `sys_billing_checkout`, `clearVote` and `delete` under `sys_poi_ratings`, and share `revoke` under `sys_gamification`. When gating any surface, ask what the rider can no longer take back.

Seventh round:

| Where | Defect                                                                                                                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR 6  | The challenge-detail 404 clause is unreachable, for the same reason C4's closure-detail task was: no companion route, and both `fetchChallengeDetail` call sites derive their id from the list, which is empty when the switch is off |

**Fourth rule, from the two unimplementable tasks:** `docs/feature-flags.md`'s per-switch degradation table describes **backend** behaviour. A documented 503/404 only becomes companion work if the companion actually calls that endpoint — check the call site before turning a degradation shape into a task. Both dropped tasks came from reading that table as a companion to-do list.

Eighth round — two of these correct **fixes made earlier in this same review**, which is worth recording as its own lesson:

| Where | Defect                                                                                                                                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PR 8  | The round-1 fix was wrong. A `?trial=1` marker is rider-forgeable once it round-trips through the browser, so it can assert a trial that never happened — and it regressed the deliberately neutral copy the current code was built for. Server-_generated_ ≠ server-_authoritative_ |
| PR 5  | The round-6 fix was unbuildable as specified. There is no own-review read contract (`GET /roads/:id/reviews` returns `[]`, no own-review endpoint), so the companion cannot tell "you have a review" from "you don't" and could only hide deletion or show everyone a 404-ing button |
| Plan  | The PR-sequence table still advertised the dropped NAP task, contradicting the corrected PR 7 section                                                                                                                                                                                |
| Plan  | The operator pass said "five switches in System switches"; the plan touches **six** keys across **two** admin sections — the two feature kill switches are under Feature flags                                                                                                       |

**Fifth rule:** a fix creates new surface. Each of the two above was introduced by a correction, not by the original plan — closing a silent-empty state manufactured a trap, and making a value survive a redirect made it forgeable. Re-verify the fix, not just the finding.

**The recurring shape across all six rounds:** every P1 was a gate placed at the wrong layer, or at only one of the layers that reach the same data — metadata not attached to the endpoint, props hidden instead of stripped, a decorator without its guard, one of two fetch entry points, one of two independent flags on the same route. The plan now names the layer explicitly in each case, because "gate X" is exactly the instruction that produces work which looks complete and enforces nothing.

**Two rules that fall out of it, applied throughout:**

1. **Strip the data, don't hide the rendering.** Any killed value must be removed server-side before it can reach a client boundary, `<head>`, or JSON-LD. Every leak found here came from gating a render path while the data travelled another one.
   **Corollary for derived scalars:** a killed list usually feeds more than its own rendering — counts, totals and KPI tiles computed from it survive the gate and quietly report `0` as fact. When gating a list, grep for everything derived from the same array.
2. **Sweep per flag, not per route.** A route can be correctly covered for one switch and wide open for another. Every PR 4 miss was on a route the sweep had already marked done.
3. **Verify each endpoint's degradation; never generalise from the switch.** The audit's own "the backend keeps reads open" was wrong for `sys_poi_ratings`, whose three paths degrade three different ways. Before gating a surface, read the service method that backs it.

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

Tracks are **almost** independent. One cross-track dependency: **PR 6 needs PR 3**, because the public shared road map is anonymous and its `sys_gamification` gate must be server-side — which means the `serverSystemSwitch` reader PR 3 introduces. Duplicating that reader to keep the tracks parallel would defeat the point of building it once. **The one hard serialization** is the three PRs touching `app/(dashboard)/settings/subscription/page.tsx` (908 lines): **PR 2 → PR 8 → PR 9**. PR 10 also follows PR 8 (both touch `lib/subscription.ts`). PR 14 lands last.

| PR  | Title                                                                       | Track | Issue | Size | Depends on     |
| --- | --------------------------------------------------------------------------- | ----- | ----- | ---- | -------------- |
| 1   | suppress upgrade CTAs when `sys_billing_checkout` is off                    | A     | #1169 | XS   | —              |
| 2   | disable checkout on the billing page, keep the portal open                  | A     | #1169 | S    | —              |
| 3   | server-side operator flag reader + best-roads quality/JSON-LD               | B     | #1168 | M    | —              |
| 4   | take public share routes down when `community_access` is killed             | B     | #1168 | S    | PR 3           |
| 5   | gate `sys_poi_ratings` compose + read (**cross-app**, + `SystemSwitchGate`) | C     | #1170 | M    | —              |
| 6   | gate achievements + exploration on `sys_gamification`                       | C     | #1170 | M    | PR 5, **PR 3** |
| 7   | explain killed discover feed (NAP task dropped — see PR 7)                  | C     | #1170 | XS   | PR 5           |
| 8   | surface the 14-day trial before checkout                                    | D     | #1171 | M    | PR 2           |
| 9   | cancelled-but-entitled state, resume action, store links                    | D     | #1171 | S    | PR 8           |
| 10  | derive plan-card copy from the feature registry                             | D     | #1171 | M    | PR 8           |
| 11  | gate `/rides/stats` behind `advanced_analytics` (companion)                 | F     | #1167 | S    | —              |
| 12  | gate `GET /rides/stats/breakdown` on `advanced_analytics` (backend)         | F     | #1167 | XS   | PR 11          |
| 13  | delete the unused `FeatureGate` component                                   | E     | #1172 | XS   | —              |
| 14  | reconcile the feature-flag catalog with the registry                        | E     | #1172 | S    | 1-12           |

Plus two issues to file, no code: **D5 registration plan step**, **OpenNext incremental cache provisioning**.

---

## Track A — revenue containment (#1169, P1)

### PR 1 — `fix(companion): suppress upgrade CTAs when sys_billing_checkout is off`

The highest value-per-line change in the epic: one component, every upsell in the app.

**Files:** `components/entitlements/UpgradePrompt.tsx`, `UpgradePrompt.test.tsx`

- [ ] `const { enabled: checkoutEnabled } = useSystemSwitch("sys_billing_checkout")`
- [ ] Suppress the CTA **only when this rider's upgrade actually needs Checkout** — which is _not_ the same as `currentTier === "free"`. `paidPlanNeedsCheckout` (`page.tsx:277`) routes **every** plan action to Checkout for a rider on an operator-granted or cancelled paid tier, so a Pro rider in that state would otherwise get a Premium CTA leading to a page where nothing can proceed.
      Extract the predicate once — an `upgradeNeedsCheckout(snapshot)` helper in `lib/subscription.ts` covering both `currentPlan.tier === "free"` and `paidPlanNeedsCheckout` — and have the billing page (PR 2) and `UpgradePrompt` share it, rather than each re-deriving "is this rider's route Checkout or portal". Three findings in this review have come from that question being answered inconsistently in different places. Reuses the existing `target === null` no-CTA path, so `modalTitle` becomes "Limit reached" and `cta` is `null` on both variants with no new branch.
- [ ] **Do not suppress it for a paid rider.** A Pro rider hitting a Premium-only feature changes plan through `openPortal("subscription_update")` (`page.tsx:312`), which this switch deliberately leaves open — blanking their CTA would contradict PR 2's own "every portal flow stays reachable" requirement and strand them with no route to an upgrade they can still complete. Same distinction as the trial badge in PR 8: the question is never "is the switch off" but "does _this_ rider's action route to Checkout".
- [ ] Tests: `force_off` → no CTA for a free rider on `inline` **and** `modal`; **CTA retained for a paid rider whose upgrade routes to the portal**; **suppressed again under `paidPlanNeedsCheckout`**; unresolved flag map → CTA present (fail safe); live flip within the poll interval

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
- [ ] **Gate Fun Zones on `/explore` — a public client route the sweep's own definition excluded.** `showFunZones` is independent of `qualityOverlayEnabled` (the existing gate only produces `qualityOverlayOn = showQualityOverlay && qualityOverlayEnabled`), so with the flag killed an anonymous visitor can still open the panel and read quality: the zone list renders `zone.avg_quality` (`explore/page.tsx:~1451-1469`) and `FunZonePanel` renders both `zone.avg_quality` (`:129-130`) and every `top_roads[].quality_score` (`:163-164`). Gate the control, the `/roads/fun-zones` fetch and the detail path, and cover the live flip.
- [ ] **Gate the community quality cluster — authenticated, and currently ungated.** `road_quality_overlay` is a global operator kill, so it must hide quality for signed-in riders too, not only anonymous ones. Verified ungated: `components/community/CommunityRideCard.tsx:27` (`scoreToQualityTier(ride.avg_road_quality)` — the file imports `useFeatureKillSwitch` but only for `trip_planning` at `:50`), `components/community/SharedRidesSection.tsx:160` (same call on rider profiles), `community/collections/[collectionId]/page.tsx:839-842` (`QualityBars`), the discover collection detail via `CollectionRouteRow`, and the feed's `highest_quality` sort option (`community/feed/page.tsx:45`). Gate the rendering **and** the quality-dependent controls — a sort the operator killed should not remain selectable.
- [ ] **Gate the personal ride-quality cluster too — a fifth group, all verified with zero `road_quality_overlay` references.** `rides/_components/RidesTable.tsx:134-141` renders _and sorts on_ `avg_road_quality`; `rides/[rideId]/page.tsx` exposes aggregate and per-segment quality; `rides/compare/page.tsx` compares it across rides; `_home/RecentRidesTable.tsx:91-93` displays it even though its parent `(dashboard)/page.tsx:75` already reads the switch and simply never threads it down. Gate rendering **and** the quality sort, with live-flip coverage.
- [ ] **Widen the sweep definition accordingly.** "Every non-client `page.tsx`" was the wrong frame: it answers _what leaks into the HTML_ but not _what a visitor can still see_, and a kill switch is about both. The sweep is over **every surface rendering flag-gated data** — public or authenticated, client or server — server ones need the data stripped (HTML, `<head>`, JSON-LD, Flight payload), client ones need the affordance and its fetch gated.
- [ ] Check the country index and `roads/best` hub for the same fields (prose mentions of "quality scores" in marketing copy are static, not data — leave them, note the decision)
- [ ] Comment on each page that `dynamic = "force-dynamic"` is what makes the 60s restore window real (§0.3)
- [ ] Tests assert **rendered RSC output** (`render(await Page({ params }))`, the existing pattern in `[country]/page.test.tsx`): no quality figure in the list, no quality value in the JSON-LD, a failing flags fetch renders normally, **and the failure path warns**
- [ ] **One test must assert on the serialized payload, not the rendered tree** — the props handed to the client component must not contain `quality_score` at all. A DOM-text assertion passes while the score sits in the Flight payload, which is precisely the bug this PR exists to fix. Manual check is `view-source:`, not devtools.

> **Split note.** PR 3 has grown across this review from "reader + best-roads" into a full `road_quality_overlay` sweep. Land it as **3a** (server reader + best-roads + share-route stripping — the HTML/SEO half, and the one with real urgency) and **3b** (client surfaces: `/explore` Fun Zones + the community cluster). 3b needs only 3a's shared helper, so splitting costs nothing and preserves the small-PR goal this plan is built around.

### PR 4 — `fix(companion): take public share routes down when community_access is killed`

**Files:** `app/community/collections/shared/[slug]/page.tsx`, `app/trips/shared/[token]/page.tsx`, `app/rides/shared/[token]/page.tsx`, `app/rides/road-map/shared/[token]/page.tsx` + tests

- [ ] Resolve `community_access` **before** the content fetch in each route — the acceptance criterion is that the collection is not fetched at all
- [ ] Killed → a neutral "temporarily unavailable" body (preferred over `notFound()`, which miscommunicates a moderation pause as a dead link). **No upsell.**
- [ ] **Gate `generateMetadata` too — it is a second entry point, not part of the page.** Next runs it independently of the page component, and on the shared-collection route it calls `fetchSharedCollection(slug)` itself (`:37`) and builds `title` from `detail.title` (`:50`) and `description` from `detail.description` (`:51`). Gating only the page component still fetches the killed collection _and_ serializes its title and description into `<head>` — failing both the no-fetch assertion and the raw-HTML criterion. Note the page then fetches a **second** time at `:79`, so the flag must be resolved in both places.
- [ ] **The killed metadata branch must keep `robots: { index: false, follow: false }`.** Today that flag is derived from `detail.visibility`, which the killed branch can no longer fetch — so a metadata object that returns only neutral title text (or `{}`) silently **inherits indexable defaults** and can push an unlisted share URL into search results _because_ of the shutdown. The route already has exactly this shape for its unavailable case; reuse it rather than inventing a new return. Assert the robots flag in the `generateMetadata` test, not just the absent title.
      Worth stating generally: a kill switch must not make anything **more** exposed than it was. Removing content is the goal; removing a protection alongside it is the failure.
- [ ] **Applies to every route in this track, not just the collection one.** All four share routes have a `generateMetadata`, and the best-roads region page has two — so PR 3's `road_quality_overlay` work needs the same treatment wherever metadata is derived from road data.
- [ ] Keep the existing client gates (`KillSwitchShareCta`, `SharedMap.client.tsx`) as defence in depth
- [ ] **The two flags are independent — sweep for `road_quality_overlay` on these routes too.** PR 4 gates them on `community_access`; with `road_quality_overlay` at `force_off` and `community_access` still on, killed quality data stays public on:
  - `rides/shared/[token]/page.tsx:109-112` — a "Quality" `MetricTile` rendering `ride.avg_road_quality` directly into the HTML
  - `rides/road-map/shared/[token]/page.tsx:164-169` — passes `snapshot.segments` (carrying `last_quality_score`) into `<SharedMap>`, a client component, so the scores land in the Flight payload. `SharedMap.client.tsx:24-26` gates `road_quality_overlay` **client-side only** — its own comment notes the popover shows "the killed data itself", so the sensitivity was understood but the fix was hiding, not stripping.
  - `community/collections/shared/[slug]` — `fetchSharedCollectionPreview()` returns items carrying `quality_avg`; `CollectionRouteRow` renders it (`components/community/collection-route-atoms.tsx:200`) **and** the page hands the full items to `CollectionPreviewMap`, which is `"use client"`. So both a visible quality bar and the raw score in the Flight payload, on the same route PR 4 already touches for `community_access`.
    Same server-side-stripping rule as PR 3, same serialized-output assertion.
- [ ] **Sweep deliverable:** enumerate all 12 non-client `page.tsx` files and record coverage or an explicit reason **per flag** — a route can be covered for one switch and open for another, which is exactly how these were missed. Three of the four public share routes carry quality data under a `community_access`-shaped gate, so treat "this route is done" as a per-flag claim that has to be re-made for each switch. Current inventory:
      `(auth)/login`, `(auth)/register` — no flag-gated content
      `(dashboard)/community/page`, `(dashboard)/community/rides/[rideId]` — behind `community/layout.tsx`'s `KillSwitchGate`, authenticated, not crawlable → client gate sufficient
      `roads/best` hub + `[country]` — no per-road data
      the four share routes + two best-roads region routes — covered by PR 3/PR 4
- [ ] Tests on rendered RSC output; assert the fetch was **not** called under `force_off` — and test **`generateMetadata()` under `force_off` as its own case**, since it runs on a separate path the page-component test never exercises. The existing `metadata.test.ts` files on these routes are the natural home.

---

## Track C — remaining operator switches (#1170, P2)

### PR 5 — `feat(cross): gate the review composer and read surface on sys_poi_ratings`

> **Cross-app, not companion-only.** The read-side fix changes `ReviewsService.listForSegment`'s contract, and that endpoint is shared with mobile (see below). Scope, commit type and validation must all reflect backend + companion — plus mobile if the shared-endpoint option is taken.

**New:** `components/entitlements/SystemSwitchGate.tsx` + test — sibling of `KillSwitchGate` typed to `SystemFeatureKey`, same `Card` + `CircleSlash` + copy. (Generalizing `KillSwitchGate` to a union key is the alternative; a sibling keeps each component's key type exact.)
**Modify:** `components/RoadReviewsPanel.tsx` + test · `apps/backend/src/modules/reviews/reviews.service.ts` + spec (own-review read, neutral aggregates) · **mobile `RoadPreviewScreen.tsx` + tests if the shared endpoint changes**
**Validation:** `pnpm --filter @tarmoto/backend test` as well as the companion suite; `pnpm openapi:gen` if the response shape moves

- [ ] Gate the **compose affordance** on `useSystemSwitch("sys_poi_ratings")` so the rider never composes a review, uploads photos and meets a 503 at `roadsApi.createReview` (`:329`) with the form still full
- [ ] **The read side needs the unavailable state too — the epic's "backend keeps reads open" premise is wrong.** `ReviewsService.listForSegment` short-circuits and returns `[]` when the switch is off, before it touches the DB (`reviews.service.ts:203`, guard at `:210-214`; the road-detail aggregate is neutralised the same way). So a road that genuinely has reviews renders as "no reviews yet" — a silent empty state indistinguishable from real absence, which is precisely what this epic's definition of done forbids. Classify the switch state explicitly and say "temporarily unavailable"; do not infer from an empty list, and note that a reload cannot surface the rider's **own** review either while it is off.
      This correction applies to #1170's C1 and to the epic body, both of which assert reads stay open — see the comment on #1170.
- [ ] **Keep the rider's own review deletable — which needs a backend change, so this PR is `feat(cross)`.** `ReviewsService.delete` (`:414`) has no switch check, so deletion stays permitted; but the unavailable read state above hides the rider's own review, the only place `RoadReviewsPanel` exposes deletion from. After a reload their review is stranded — still published, still theirs, unremovable.
      **A companion-only fix is impossible here.** The sole read is `GET /roads/{segmentId}/reviews` (`reviews.controller.ts:96`), which returns `[]` under the switch, and there is no own-review endpoint — so the client cannot tell "you have a review" from "you don't", and would have to either hide deletion (the trap) or show every rider a delete button that 404s.
      **Preferred fix:** have `listForSegment` return **only the viewer's own review** when the switch is off, instead of `[]`. **That branch must bypass `aggregateVotes` (`:238`) and construct neutral vote fields** — falling through the normal pipeline would serialize `helpful_count` / `not_helpful_count` / `my_vote` and reopen exactly the vote data the switch neutralises everywhere else, including in `clearVote`'s own response (`:704`). Regression test on the killed state. It already takes `viewerUserId`, so this is a small change, it keeps the kill intact (the community's reviews stay hidden) and it gives the companion a truthful contract with no new endpoint. Alternative is a dedicated own-review read path, which costs an endpoint, an OpenAPI regen and a companion contract update for the same outcome.
      **`GET /roads/{segmentId}/reviews` is shared with mobile — this is not a companion-only contract.** `RoadPreviewScreen.tsx` fetches personalised reviews from it (`:722`, `:814`) and exposes "Edit your review", while edits stay gated and 503 under the switch. Changing `[]` → own-review therefore silently changes mobile behaviour, which AGENTS.md forbids leaving unaligned. Either ship the mobile delete-only / unavailable state and its tests **in the same change** — making PR 5 span three apps — or take the dedicated companion-only endpoint. Decide before starting; it is the difference between a two-app and a three-app PR, and it may flip which option is actually cheaper.
- [ ] Test the deletion path **after a hard reload**, not only on a live flip — the reload is what strands the review.
- [ ] **Out of scope, filed as #1177: vote withdrawal is unreachable while the switch is off.** With no other author's review rendered (and self-voting forbidden), the rider has no review id from which to retract a vote they already cast, so the backend deliberately leaving `clearVote` open buys nothing. Note this is **not** introduced by the own-review change — today's `return []` hides every review, so the affordance is already gone; own-review-only is strictly more visible. Closing it needs an authenticated "my votes" discovery path with its DTO, OpenAPI and companion contract, which is a backend feature rather than a companion gate. Same split as #1176.
- [ ] Note the asymmetry within this one switch: reads zeroed, `castVote` 503, `clearVote` open, `delete` open. "Degradation is per-endpoint, not uniform per switch" is the epic's own warning, and `sys_poi_ratings` is the sharpest example — verify each path rather than generalising from any one.
- [ ] **Votes: disable casting, keep withdrawal.** Do **not** look for a controller decorator — there isn't one, and its absence would wrongly read as "votes aren't gated". The check is service-level: `ReviewsService.castVote` (`reviews.service.ts:627`) calls `isSystemSwitchEnabled('sys_poi_ratings')` and throws 503. `clearVote` (`:676`) is deliberately left open, with the reasoning in the code: _"a kill switch must never trap user content — a rider must be able to retract a vote mid-incident."_ Same principle as leaving the billing portal open in PR 2. So: disable cast/change while the switch is off, leave withdraw reachable.
      (`clearVote` does gate its _response aggregate_ to neutral counts, so the DELETE can't be used as a read endpoint for hidden vote counts — the companion must not treat those zeros as real data.)
- [ ] **Live-flip is the case that matters here:** reviews load, the operator flips, and the vote buttons must go disabled within the poll interval without a reload. A rider who already has the list open is exactly who would otherwise eat the 503.
- [ ] Existing `community_access` gate at `:926` stays; the two compose independently

### PR 6 — `feat(companion): gate achievements and exploration on sys_gamification`

**Files:** `app/(dashboard)/achievements/page.tsx`, `app/(dashboard)/rides/road-map/` exploration panel, `components/community/CommunitySidebar.tsx`, `app/(dashboard)/community/[riderId]/page.tsx` + tests

- [ ] Gate on `useSystemSwitch("sys_gamification")` across **all four** consumers, not just the achievements page. The switch makes the backend return empty lists, so any surface that renders those lists misreports an operator kill as genuine "you have nothing yet" — the exact failure the epic's definition of done forbids:
  - `achievements/page.tsx` — the module
  - `rides/road-map` — the exploration panel
  - `CommunitySidebar.tsx:54` (`fetchActiveChallengeCard`) — the active-challenge card silently disappears
  - `community/[riderId]/page.tsx:81` (`fetchPublicBadges`) — feeds **two** surfaces from one array: `BadgesSection` (`:200`), the empty shelf, **and** `StatsRow`'s `earnedBadgeCount` (`:198` → rendered at `:352`). Gate both; replacing only the shelf leaves an adjacent "Badges: 0" metric reporting the shutdown as the rider having earned nothing
- [ ] **The public shared road map is in scope** — the registry says so: `sys_gamification` is _"Badges, challenges, **personal road map** (Epic 7)"_ (`feature-flags.ts:312`), and `docs/feature-flags.md:224` scopes it to "badges, challenges, exploration/road-map". So `rides/road-map/shared/[token]` must be gated too, and **server-side**, because it serves anonymous visitors: today the page fetches the whole snapshot (`:45-52`) and `SharedMap.client.tsx:24-26` observes only `road_quality_overlay`, so killing gamification still serves the map, the exploration totals and every segment publicly. Gate the share **viewer** and the share **creation** affordance.
- [ ] Verified **not** consumers despite mentioning the word: `(dashboard)/page.tsx` and `community/feed/page.tsx` make no gamification call. Recorded so the sweep isn't redone.
- [ ] **Backend gap — #1176, do not fix here.** Neither `MapSharesService.create` (`map-shares.service.ts:24`) nor `getByToken` (`:39-60`) has a switch check — the service injects only the repository, so the module contains no `isSystemSwitchEnabled` call at all. Both directions leak: `POST /map-shares` keeps **minting and persisting** new snapshots during a shutdown even with the companion affordance hidden, and `GET` keeps serving them. `list`/`revoke` must stay open so an owner can still take an existing share down — the trap-user-content rule again. Same treatment as #1164: the companion gate is defence in depth, the server gate is its own issue.
- [ ] The backend degrades three ways at once, but the companion can only reach **two** of them: 503 on challenge join (`:232`) and silent-empty on lists/exploration. Both must land on the same explained state.
- [ ] **The challenge-detail 404 is unreachable from the companion — do not write handling for it.** There is no challenge route under `app/`, and both `fetchChallengeDetail` call sites take their id from the list: `gamification-fetch.ts:215` maps over `fetchActiveChallenges()`, and `community-sidebar.ts:49-52` early-returns on an empty list. With the switch off the list is empty, so no detail request is ever issued. Inventing routing or error handling for a 404 that cannot occur is worse than leaving it alone.
      (Second instance of this — see the dropped C4 closure-detail task in PR 7. Both were derived from `docs/feature-flags.md`'s per-switch degradation table, which describes **backend** behaviours; a backend 404 only becomes a companion task if the companion actually calls that endpoint. Check the call site before turning a documented degradation into work.)
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
- [ ] Paid plan cards: "14 days free" badge and CTA "Start free trial" **only when the card's action actually opens Checkout** — eligibility alone is not the condition. `handlePlanAction` routes to `openCheckout` only when `currentPlan.tier === "free"` (`page.tsx:303-306`) or under `paidPlanNeedsCheckout`; every other transition opens the portal (`manage` / `subscription_cancel` / `subscription_update`).
      This matters because `trial_eligible` stays **true** for an active paid rider who subscribed without one — the backend deliberately leaves `billing_trial_used_at` unset in that case (`account.service.spec.ts:1309-1342`). Keying the badge off the flag alone would put "Start free trial" on a button that opens the billing portal and starts nothing: an advertised offer the click cannot fulfil.
- [ ] Success banner (`page.tsx:361`): stop inferring trial state from `currentPlan.status === "trialing"` — that status usually hasn't landed because the webhook is still in flight, so a rider who just started a trial currently reads "Subscription confirmed"
- [ ] **Carry the trial state across Checkout — but never assert it from a URL parameter.** Stripe is a full cross-origin navigation: the page unmounts and remounts on `?checkout=success`, so a value held in React state before `window.location.assign` is gone by the time the banner renders. A plain `?trial=1` marker does **not** solve this: once it round-trips through the browser it is rider-forgeable, so anyone opening `?checkout=success&trial=1` gets a "your free trial has started" confirmation for a Checkout they never completed, while the poll never activates anything. Server-_generated_ is not server-_authoritative_ after a user-controlled URL.
      **Preferred:** put `{CHECKOUT_SESSION_ID}` in `success_url` and have the backend verify the session, returning whether a trial actually started. That is the only option that both survives the navigation and cannot be forged.
      **Bind the session to the authenticated rider** — confirming it completed with a trial is not enough. A success URL is shareable and leaks easily, so without an ownership check another rider's completed session id yields a genuine-looking confirmation for someone who bought nothing. Match the session's `metadata.user_id` (and customer) against the caller, and cover a cross-user session id in the tests.
      **Otherwise keep the pre-verification banner to a status, not a claim.** "Checkout complete" is still an assertion, and it would be rendered from `?checkout=success` alone — which the rider controls, so bookmarking or editing that URL produces the same false confirmation. Before anything is verified the banner may only say what the app is doing ("Checking your plan…"); completion, payment and trial are all claims that wait for the verified session or the updated snapshot. That preserves the property the current code was carefully built for (`page.tsx:361` comment): never make an unconditional payment claim on a trial signup — and extends it, since "you completed checkout" is no more verifiable from a query parameter than "your trial started".
      Whatever ships, the banner must not state something the rider can cause by editing the address bar.
- [ ] Tests, **matching whichever option above is taken** — the two have different contracts and the wrong test would force a forgeable marker back in:
  - _Verified session id:_ the id survives the remount and the banner asserts a trial only after the backend confirms the session
  - _Neutral fallback:_ the banner makes no trial or payment claim before the webhook lands, and switches to trial copy only once the snapshot reads `trialing`.
    **That switch requires re-fetching the snapshot, which nothing does today:** `getSubscription()` runs once (`page.tsx:184-194`) and the post-checkout poll only invalidates `USERS_ME_QUERY_KEY` (`:116`, `:157`, `:164`), never refreshing `snapshot.currentPlan.status`. As written the banner would stay neutral until another full reload. Extend the existing poll to re-fetch the subscription snapshot, reusing its bounded timeout.
  - Both: badge on/off, CTA copy, `shared:build` + backend green

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
- [ ] Skip **both** data effects when locked or unresolved — `fetchAllRides()` (which pages the entire ride history 100 rows at a time) **and** the independent `fetchRideBreakdown()` effect (`:128-149`). They are separate `useEffect`s and both run before the locked JSX returns, so gating only the first leaves the breakdown call hitting the very endpoint PR 12 gates — a **403 on every visit** by a Free rider.
- [ ] Extend the no-fetch test to assert **neither** request is issued while locked or unresolved.
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

**Manual operator pass before closing — six keys, in two different admin sections.** Four are `sys_*` system switches; two are free-tier feature kill switches and live under **Feature flags**, not System switches, so looking for them in the wrong place is how one gets skipped:

| Key                         | Admin section     | What to walk                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sys_billing_checkout`      | System switches   | Checkout CTAs disabled, **every** portal flow still opens                                                                                                                                                                                                                                                                                             |
| `sys_poi_ratings`           | System switches   | Compose gated, reads explained (not empty), own review still deletable, cast disabled / withdraw open                                                                                                                                                                                                                                                 |
| `sys_gamification`          | System switches   | Achievements, exploration, sidebar challenge card, profile badges, shared road map                                                                                                                                                                                                                                                                    |
| `sys_community_collections` | System switches   | Discover shows unavailable, not "no collections yet"                                                                                                                                                                                                                                                                                                  |
| **`road_quality_overlay`**  | **Feature flags** | _RSC (raw source):_ best-roads list + JSON-LD, and all three share routes carrying quality. _Client (interact + network tab):_ `/explore` Fun Zones; the community cluster (ride cards, rider profiles, collection detail, `highest_quality` sort); the personal ride cluster (ride list + its quality sort, ride detail, compare, dashboard recents) |
| **`community_access`**      | **Feature flags** | Public share routes, including `generateMetadata` output                                                                                                                                                                                                                                                                                              |

`sys_nap_conditions` is **not** in this list — C4 was dropped as unimplementable (see PR 7).

**Two different checks, and neither substitutes for the other.** _RSC routes:_ hard reload (not client nav) plus `view-source:` — the client gate hides the content either way, so only raw HTML proves the server fix, and the Flight payload appears only in source. _Client surfaces:_ `view-source:` proves nothing, because the data arrives after hydration — open the control, confirm the affordance is gone, and check the network tab that the quality-bearing request was never issued. Live-flip each without reloading.
