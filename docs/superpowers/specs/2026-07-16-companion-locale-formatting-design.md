# Companion locale-aware display formatting — design

**Date:** 2026-07-16
**Status:** approved
**Scope:** `apps/companion`, `apps/backend` (contract only), `packages/shared`

## Problem

The companion app renders numbers, dates, and times with no unified locale behavior. An EU user
sees US-style output in some places (`1,234.5`, `Apr 3, 2025`, 12h clock), UK-style in others,
and browser-default in the rest. Dates render in browser-local time everywhere except closures
and billing, which pin UTC — so the same timestamp can display as different calendar days on
different screens. None of this is driven by a user preference, and the preferences that would
drive it (regional format, timezone) do not exist on the user record.

Goal: all display formatting follows user preferences — language, timezone, regional format —
with values autodetected from the browser and prefilled into the user record so a future
settings UI can edit them.

## Current state (audit summary)

- ~120 locale-sensitive display call sites in companion: ~10 hardcoded `'en-US'`/`'en-GB'`
  formatter sites, ~28 bare `Number.toLocaleString()` (runtime default), ~13 inline
  `Date.toLocale*`, ~55 display `toFixed()` decimals, ~10 display percent strings, plus
  hand-rolled English relative time defined twice (`lib/utils.ts` and a shadow copy in
  `TripCollaborateModal.tsx`).
- ~30 additional `toFixed()` uses are technical (SVG paths, map URL params, dedupe keys) and
  must NOT be locale-formatted.
- An intended seam exists but is barely adopted: `useNumberFormat()` (5 files) and the
  `I18nProvider` (locale from `tarmoto-locale` cookie > `Accept-Language` > `'en'`).
- `users.language` exists (`'en'` only, primary subtag, drives translations/emails). It cannot
  carry region formats by design.
- `users.preferences` JSONB holds `units` (`metric`/`imperial`) but no client writes it;
  companion keeps units in a localStorage-only Zustand store, mobile in its own local store.
  The update DTO validates `units` as bare `@IsString()` while the response DTO claims the enum.
- The only stored timezone is `notification_preferences.quiet_hours_timezone` (IANA), which
  mobile auto-syncs from the device on every foreground. No general display timezone exists.
- `date-fns` is installed in companion but unused (dead dependency).

## Decisions (product)

1. **Format model:** one regional-format locale — a single BCP-47 tag (e.g. `cs-CZ`) drives
   numbers, dates, times, and hour cycle via `Intl.*`. No per-facet format pickers. Independent
   of UI language (`users.language`): "English UI with Czech formats" is a supported state.
2. **Timezone:** follow the device and auto-sync — display always uses the current device
   timezone; companion keeps the user record mirrored to it (same pattern as mobile's
   `quiet_hours_timezone` sync). No pinning in v1.
3. **Editing UI:** none in v1 — autodetect + prefill only. A future settings editor adds manual
   override/pinning semantics.
4. **Units:** consolidate to the account — the companion units toggle reads/writes
   `preferences.units`; localStorage remains an offline cache. Tighten the update DTO enum.

## Design

### 1. Preference model (backend contract)

Two new keys in the existing `users.preferences` JSONB (no DB migration — JSONB subfields,
same home as `units`):

- `preferences.format_locale?: string` — BCP-47 tag, canonicalized and validated with
  `Intl.getCanonicalLocales` in a custom class-validator decorator. Reasonable length cap
  (35 chars).
- `preferences.timezone?: string` — IANA zone name, validated with `@IsTimeZone()`,
  `@MaxLength(64)` (same shape as `quiet_hours_timezone`).

`notification_preferences.quiet_hours_timezone` is untouched — quiet-hours/digest machinery
stays independent.

Contract changes (all additive):

- `UserPreferencesResponse` (in `UserResponseDto`) gains `format_locale?`, `timezone?`.
- `UpdateProfileDto.preferences` gains both fields with validation, and `units` tightens from
  `@IsString()` to `@IsIn(['metric', 'imperial'])` (response DTO already claims this enum; no
  client currently sends `units`, so no caller breaks).
- OpenAPI client regen + postman collection regen.
- Mobile `UserPreferences` type (`apps/mobile/src/types`) gains the optional fields for
  contract parity; no mobile behavior change.

Existing `PATCH /me` shallow-merge semantics (`{...user.preferences, ...dto.preferences}`)
already preserve unrelated keys when a client patches a subset.

### 2. Detection & sync (companion)

Mirrors the existing `/api/locale` route and mobile `timezoneSyncMonitor` patterns.

- **Cookies** (all: 1 year, `path:/`, `sameSite:lax`, not httpOnly — same as `tarmoto-locale`):
  - `tarmoto-format-locale` — BCP-47 tag
  - `tarmoto-timezone` — IANA zone
  - `tarmoto-units` — `metric`/`imperial` (SSR parity for the units store)
- **`FormatPrefsSync`** client component in the dashboard shell: on mount, detects
  `navigator.language` and `Intl.DateTimeFormat().resolvedOptions().timeZone`, compares with
  the cookies. On difference: `POST /api/format-prefs` `{ format_locale, timezone }`, then one
  `router.refresh()` so server components re-render with the new cookies. Steady state is a
  no-op (no POST, no refresh).
- **`/api/format-prefs` route** (edge, POST): validates inputs (`Intl.getCanonicalLocales` /
  IANA check), sets both cookies, returns immediately; best-effort PATCH `/me`
  `{ preferences: { format_locale, timezone } }` with the session bearer behind the same
  3s-timeout + `AbortController` race as `syncLanguageToUserRecord`. Failures logged and
  swallowed; anonymous visitors get cookies only (no PATCH).
- **v1 sync semantics: the record mirrors the device** (last writer wins across devices).
  Display is always per-device via that device's own cookies, so every viewer sees formats
  correct for their device; the record's job is future editability and server-side use.
  Because cookies can be set while logged out (making the cookie comparison a no-op after
  login), the authenticated shell also reconciles the _record_ directly: the existing
  `PreferencesSync` `/me` read compares `preferences.format_locale`/`timezone` against the
  device and PATCHes any divergence — this is what guarantees the record actually gets
  prefilled, independent of cookie state.
- **Units account-sync:** on login/hydration, `/me`'s `preferences.units` seeds the Zustand
  `unitSystem` store (account wins over localStorage when present) and refreshes the
  `tarmoto-units` cookie if it differs; the settings toggle writes the store + localStorage +
  `tarmoto-units` cookie + best-effort PATCH `/me` `{ preferences: { units } }`. One-time
  backfill rule: if the account has no `units` but localStorage holds an explicit value (set
  before this shipped), PATCH that value up once — it is the user's expressed preference. If
  neither is set, nothing is written until the user touches the toggle.

### 3. Formatting layer

**Pure core — `packages/shared/src/format.ts`:**

```ts
type FormatContext = { locale: string; timeZone?: string; units: UnitSystem };
createFormatters(ctx: FormatContext): Formatters
```

Formatter vocabulary (matches audited usage):

- Numbers: `integer(v)`, `number(v, opts?)`, `decimal(v, digits)` (localized `toFixed`
  replacement), `percent(fraction)` (`style:'percent'`)
- Dates/times (instants, viewer timezone, locale hour cycle): `date(v)`, `shortDate(v)`,
  `monthYear(v)`, `time(v)`, `dateTime(v)`, `dateRange(a, b)` (via
  `Intl.DateTimeFormat.formatRange`)
- `calendarDate(v)` / `calendarDateRange(a, b)` — UTC-pinned, locale-formatted, for date-only
  semantics (see §5)
- `relativeTime(v)` — `Intl.RelativeTimeFormat` buckets (just now / minutes / hours / days),
  falling back to `date(v)` beyond ~7 days (current behavior), replacing both hand-rolled
  English copies
- `duration(minutes)` — keeps the current `"4h 12m"` style in v1 (locale-neutral enough;
  localization deferred)
- Units (conversion via existing `@tarmoto/shared/units` math + `Intl.NumberFormat`
  `style:'unit'`, `unitDisplay:'short'` so unit labels localize): `distanceKm(km)`,
  `distanceM(m)`, `speed(kmh)`, `elevation(m)`, `temperature(c)`, plus split value/unit
  variants for KPI tiles.

Implementation notes:

- Memoize `Intl.NumberFormat` / `Intl.DateTimeFormat` instances per `(locale, options)` at
  module level — construction is expensive and lists render thousands of values.
- Invalid/unknown locale or timezone input falls back to `'en'` / UTC rather than throwing
  (cookies are client-controlled input).
- Existing `units.ts` formatters (`formatDistance` etc.) stay untouched — mobile depends on
  them. Mobile migration to `createFormatters` is a follow-up issue.

**Companion bindings:**

- `FormatProvider` wraps the app, seeded **server-side**: format locale from
  `tarmoto-format-locale` cookie > full `Accept-Language` tag (keep region) > `'en'`; timezone
  from `tarmoto-timezone` cookie > `'UTC'`; units from `tarmoto-units` cookie > store default.
  `useFormat()` returns memoized `Formatters` bound to that context. The first client render
  uses the same server-seeded values (hydration-safe); after hydration, units may update from
  the Zustand store as a normal state update — the cookie's job is only to make SSR and first
  client paint agree.
- `getFormatters()` — async server helper reading the same cookies for server components,
  layouts, and route handlers (OG/embeds).
- Detection never happens at render time; provider values always come from server-resolved
  cookies, so server and client render identically by construction (no hydration mismatches).
- `useNumberFormat` (5 call sites) is absorbed into `useFormat` and deleted.
- Pure lib modules that currently hardcode locales (`lib/subscription.ts`,
  `lib/closures-summary.ts`, `lib/ride-embed.ts`, `lib/gamification.ts`,
  `lib/best-roads-format.ts`, `lib/exploration.ts`) take a `Formatters` (or the relevant
  formatter function) parameter instead; components own the context.

### 4. Call-site migration & guardrails

- Migrate the ~120 display call sites and ~10 central helpers (`lib/utils.ts` format family,
  the `TripCollaborateModal` shadow helpers) to the layer; shared `rider-format.ts`
  `formatCount` gains an **optional** locale parameter (default preserves current behavior —
  mobile also imports it). Companion `lib/utils.ts` format helpers are deleted as they empty.
- The ~30 technical `toFixed` uses (SVG paths, URL/tile params, dedupe keys, exports) are
  explicitly out of scope and stay as-is. CSV/GPX exports and machine-facing strings must not
  be locale-formatted.
- Public/shared/embed/OG surfaces format per **visitor** cookies with `Accept-Language` → `'en'`
  fallback (an anonymous EU visitor to a shared ride sees EU formats; today they get hardcoded
  `en-US`). No user record involved.
- Chart tick/label formatters (recharts) receive formatter functions from `useFormat()`.
- ESLint guard (lands with the final migration PR): `no-restricted-syntax`/`no-restricted-properties`
  banning `toLocaleString`/`toLocaleDateString`/`toLocaleTimeString` and direct
  `new Intl.NumberFormat`/`new Intl.DateTimeFormat` outside `packages/shared/src/format.ts`
  and the provider module — same philosophy as the existing raw-fetch guard.

### 5. Timezone semantics — instants vs calendar dates

Today's "closures/billing pin UTC" is partially deliberate: date-only values must not shift
days with viewer timezone. The layer makes the distinction explicit:

- **Instants** (ride start, activity/collab timestamps, notification times) → `date`/`time`/
  `dateTime` in the viewer's timezone with the locale's hour cycle (removes the hardcoded
  `hour12:false`).
- **Calendar dates** (closure windows; any field meaning "a day") → `calendarDate*`, UTC-pinned
  but locale-formatted. Planning includes a small audit classifying each date field as instant
  vs calendar date; subscription/billing dates are instants unless the audit shows otherwise.
- `formatJoinedLabel`'s deliberate UTC month-bucketing stays as-is.

### 6. Testing

- **Shared core:** unit tests across locales (`en-US`, `en-GB`, `cs-CZ`, `de-DE`) × timezones
  (`UTC`, `Europe/Prague`, `America/New_York`) × unit systems; expectations pin the NBSP /
  narrow-NBSP grouping characters Intl emits for `cs`/`de` (known ICU gotcha).
- **Companion:** `/api/format-prefs` route tests mirroring the existing locale-route suite
  (validation, cookie set, PATCH race/timeout, anonymous path); component test updates where
  rendered output changes; one Playwright spec with `locale: 'cs-CZ'`,
  `timezoneId: 'Europe/Prague'` context options verifying an EU browser end-to-end (formats +
  cookie sync + no hydration warnings).
- Companion CI typechecks test files — run `tsc` after editing tests (known repo gotcha).

### 7. Delivery phasing

1. **PR 1 — `feat(cross)`:** backend contract (DTO fields + validators + units enum tighten) +
   `packages/shared` `createFormatters` + tests + OpenAPI/postman regen + mobile type parity.
2. **PR 2 — `feat(companion)`:** `/api/format-prefs` route, cookies, `FormatPrefsSync`,
   `FormatProvider`/`useFormat`/`getFormatters`, units account-sync. Output-neutral until call
   sites migrate.
3. **PR 3 — `refactor(companion)`:** migrate core helpers (`lib/utils.ts` family) + rides/
   dashboard/stats surfaces.
4. **PR 4 — `refactor(companion)`:** remaining surfaces (achievements, community/collections,
   trips/planner, discover/roads, billing/closures, embeds/shared pages), delete emptied
   helpers, land the ESLint guard.

### 8. Out of scope (explicit)

- Settings editing UI for format locale/timezone (follow-up issue; introduces pinning
  semantics).
- Mobile call-site migration to `createFormatters` (follow-up issue).
- Email/digest formatting (backend catalogs; `format_locale` now exists on the record for when
  that work happens).
- Translation catalogs beyond `en`; `users.language` behavior unchanged.
- `duration()` localization.
- Removing the dead `date-fns` dependency can ride along in PR 3 if trivial.

## Risks

- **Copy churn:** en-locale output stays essentially identical, but users whose browsers are
  not en-US will see formats change (that is the point). Snapshot/test updates expected.
- **ICU variance:** Intl output can differ between Node and browser ICU versions (grouping
  characters, spaces). Tests pin expectations; any mismatch surfaces in CI, not production.
- **Record flip-flop across devices:** accepted for v1 (display is per-device; record is
  last-writer-wins until pinning ships).
- **JSONB read-modify-write races on `preferences`:** pre-existing pattern in
  `users.service.ts`; the new PATCHes send only their own keys, and the shallow merge
  preserves others. Not worsened; noted for the future editor.
- **First-visit `router.refresh()`:** one extra refresh per browser (and on travel/tz change);
  same cost class as the existing locale switcher's full reload.
