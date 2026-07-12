# Email i18n Phase 2 — Per-User Language + Footer Localization

- **Status:** Approved design, ready for implementation planning
- **Date:** 2026-07-11
- **Scope labels:** `backend` (PRs 1–2), `companion` (PR 3)
- **Builds on:** Phase 1 (#955 shared i18n core, #958 backend email catalog + `locale` seam)
- **Related:** `docs/superpowers/specs/2026-07-11-email-template-i18n-design.md` (Phase 1)

## Goal

Complete the email localization infrastructure so the Phase-1 `locale` seam is fed by
real per-recipient data and covers the **whole** rendered email — **without shipping a
translated language yet** (still English-only output). After this, adding a language is
genuinely "register the locale + drop a catalog file."

Two gaps remain from Phase 1:

1. The `locale` parameter on every `EmailService.send*` is always `DEFAULT_LOCALE` — nothing
   tells the backend what language a recipient speaks (no stored per-user language; the
   weekly-digest cron has no request context).
2. The shared layout chrome (`renderLayout`/`renderTextFooter` — footer copy + `<html lang>`)
   is outside the seam, so a future translated body would render under an English footer and
   `lang="en"` (raised by Codex on #958 and by the Phase-1 final review; breadcrumbed in
   `layout.ts`).

## Non-Goals (still deferred)

- **No translated catalog / no second registered locale.** Output stays English end-to-end;
  `SUPPORTED_LOCALES` stays `['en']`. Shipping a real language (spec placeholder: Estonian
  `et`) needs a which-language product decision + real translation copy — a separate effort.
- **Mobile.** Companion-first, consistent with prior features. Mobile syncing its device
  locale to `users.language` is a later add.
- **ICU / pluralization engine, localized number/unit formatting** — unchanged from Phase 1
  non-goals.

## Model

**A per-user stored language is the source of truth, and every email localizes to the
RECIPIENT's stored language** — not the request's `Accept-Language`. Rationale: the weekly
digest fires from a BullMQ cron with no request, and an email should match the recipient's
own preference regardless of who triggered the send. `Accept-Language` is used only to
_seed_ the stored value at signup; the companion locale switcher updates it thereafter.

Everyone's `language` is `'en'` in this phase, so **output does not change** — the value of
the work is that the seam is now driven by real per-user data and the whole email (incl.
footer + `<html lang>`) flows through it.

## Current-state facts (grounding)

- `PATCH /users/me` (`users.controller.ts:68`) with `UpdateProfileDto` already exists — the
  per-user `language` field piggybacks it; no new endpoint.
- `GET /users/me` returns `UserResponseDto`; `language` is surfaced there so the companion can
  read the persisted value.
- Companion `LocaleSwitcher` (`apps/companion/src/components/LocaleSwitcher.tsx`) POSTs to the
  Next route `/api/locale`, which sets the `tarmoto-locale` cookie; the component is hidden
  while `SUPPORTED_LOCALES.length <= 1`. Bridging the choice to the user record is a change to
  that **route handler**, not the component.
- `resolveLocale(acceptLanguage)` and `SupportedLocale`/`DEFAULT_LOCALE` already live in
  `@tarmoto/shared` (Phase 1).
- `users.settings` (jsonb) exists but is the wrong home for a first-class, cron-queried
  attribute.

## Approaches (capture / store)

- **A — dedicated `users.language` column (chosen).** `varchar(10) NOT NULL DEFAULT 'en'`,
  typed `SupportedLocale`. Directly queryable by the digest cron, canonical, cheap migration.
- **B — stash in `users.settings` jsonb.** No column migration, but worse to query and it is
  a first-class attribute. Rejected.
- **C — resolve per-send from `Accept-Language`, don't persist.** Impossible for the cron (no
  request) — persistence is the whole point. Rejected.

## Design — the five pieces

### 1. `users.language` column + migration

- Entity: `@Column({ type: 'varchar', length: 10, default: 'en' })` typed `SupportedLocale`
  (import from `@tarmoto/shared`). NOT NULL.
- TypeORM migration: add the column with `DEFAULT 'en'` so existing rows backfill; keep the
  default so inserts that omit it are valid. No new entity → no change to the three entity
  registration lists.

### 2. Capture

- **Signup:** where the user is created (auth register path), set
  `language = resolveLocale(<registration request Accept-Language header>)`. The register
  controller has the request; pass the header down to the create call.
- **Ongoing change (API):** `UpdateProfileDto` gains an optional `language` validated to be a
  member of `SUPPORTED_LOCALES` (reject anything else with 400). `UsersService.updateProfile`
  persists it. `UserResponseDto` (read model) exposes `language`.
- **Contract:** new DTO field → regenerate the committed OpenAPI spec (`openapi:gen`) and the
  Postman collection (`postman:gen`); update `@tarmoto/shared` / generated-client consumers as
  the repo's contract flow requires.

### 3. Resolve (feed the seam)

Every `EmailService.send*` call site passes the **recipient user's** `language`:

- `digest-weekly.processor` → the composed user's `language`.
- `password-reset` / `email-verification` / `password-changed` / `account-deletion-scheduled`
  / `account-deletion-completed` / subscription (`account.service`) / `data-export.processor`
  → the target user's `language` (each already loads the user).
- `trips.service` trip-invite → look up a user by the recipient email; use their `language`
  if found, else `DEFAULT_LOCALE` (external recipients have no stored preference).
- `admin-email` test-send → the admin's own `language` (or `DEFAULT_LOCALE`).
  Verification-at-signup naturally uses the language just seeded on the new user.

### 4. Footer + `<html lang>` localization (the Codex gap)

- Add footer copy to the email catalog (`email/i18n/en.ts`), values **verbatim** from today's
  strings: `layout.footer.transactional.{lead,link}`, `layout.footer.marketing.{lead,link}`,
  `layout.textFooter.transactional.{tagline,line}`, `layout.textFooter.marketing.{tagline,lead,unsub}`.
- `renderLayout(ctx)` gains `locale: SupportedLocale` (default `'en'`): sets
  `<html lang="${escapeHtml(locale)}">` and renders the footer via
  `translateEmail(key, values, locale)` (chosen over threading footer strings through ten
  templates — the footer is shared chrome, so it self-translates from `locale`). This couples
  `templates/layout.ts` to `email/i18n` (`translateEmail`), an acceptable intra-module
  dependency; no import cycle (`i18n` imports neither templates nor layout).
- `renderTextFooter(preferencesUrl, marketing, locale)` translates its lines the same way.
- The ten templates pass `locale: ctx.locale` to `renderLayout` and `ctx.locale` to
  `renderTextFooter`.
- **Byte-identical at `en`:** the footer catalog values equal the current strings and
  `locale` defaults to `'en'`, so all 45 characterization snapshots stay unchanged (they are
  the guard for this PR).

### 5. Companion bridge

- The Next `/api/locale` route handler, in addition to setting the `tarmoto-locale` cookie,
  calls the backend `PATCH /users/me { language }` when the request is authenticated (session
  present), so a `LocaleSwitcher` change persists to `users.language`. Unauthenticated
  visitors still get the cookie-only behavior. `LocaleSwitcher.tsx` is unchanged.
- Failure to persist is non-fatal (cookie still set; log + continue) — a language toggle must
  not hard-fail on a transient backend hiccup.

## PR breakdown

1. **PR 1 — `feat(backend): localize email footer + <html lang>`** (piece 4). Small,
   self-contained, closes the open Codex thread on #958. Guarded byte-identical by the 45
   snapshots.
2. **PR 2 — `feat(backend): per-user email language`** (pieces 1–3). Migration + entity,
   `UpdateProfileDto`/`UserResponseDto` + OpenAPI/Postman regen, signup capture, and all
   send paths passing the recipient's `language`.
3. **PR 3 — `feat(companion): persist language choice to the user record`** (piece 5).

PRs 1 and 2 are independent (both backend); PR 1 is slotted first as a quick win that
resolves the review thread. PR 3 depends on PR 2 (the `PATCH /me { language }` field).

## Testing

- **PR 1:** the 45 characterization snapshots stay byte-identical (footer now catalog-driven
  at `en`); a unit test that `renderLayout({ locale: <unregistered> })` falls back to English
  footer + still emits a `lang` attribute; `renderTextFooter` parity.
- **PR 2:** migration up/down; capture-at-signup sets `language` from `Accept-Language`
  (and defaults to `'en'` when absent/unresolved); `PATCH /me` accepts a valid locale and
  **rejects an invalid one (400)**; `UserResponseDto` exposes `language`; a test per send
  path asserting it forwards `user.language` (spy the rendered locale / `EmailService`).
- **PR 3:** authed `/api/locale` persists via `PATCH /me`; unauthenticated path is cookie-only
  and does not call the backend; persist failure is swallowed (cookie still set).

## Risks

- **Migration:** non-null column with a default + backfill `'en'` — standard; include a
  reversible `down`.
- **Contract drift:** the `language` field must land in OpenAPI + Postman + generated-client
  consumers in the same PR (PR 2), per repo convention.
- **Resolve fan-out:** ~9 send call sites each need the recipient's language threaded; the
  test-per-path requirement guards against a missed site silently staying `DEFAULT_LOCALE`.
- **Inert output:** everything renders English this phase; the "seam fed by real data" is
  proven by the per-send tests + byte-identical snapshots, not by visible change.
