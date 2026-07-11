# Email Template Internationalization — Phase 1: Structure-First (English-Only)

- **Status:** Approved design, ready for implementation planning
- **Date:** 2026-07-11
- **Scope label:** `shared` (PR 1), `backend` (PR 2)
- **Related:** companion i18n (`apps/companion/src/i18n`), email module (`apps/backend/src/modules/email`)

## Goal

Make the backend's transactional and lifecycle emails translation-ready by moving
their copy into a typed message catalog rendered through the same lightweight i18n
mechanism the companion already uses, **without** shipping a second language yet.

After Phase 1, adding a language is "drop a catalog file + populate a locale
parameter" — no template rewrites, no call-site restructuring.

## Non-Goals (explicitly deferred to Phase 2+)

- **Persisted per-user language.** No `users.language` / `notification_preferences.locale`
  column, and no capture of a preference. The weekly-digest cron therefore cannot
  localize yet — it has no request context and no stored locale to read.
- **`Accept-Language` source-wiring.** The `locale` parameter is threaded but every
  caller passes the default; resolving real locales from requests is Phase 2.
- **Actual translations.** Only the `en` catalog exists.
- **ICU / plural-rule engine.** Pluralization stays as English-only template-side logic.
- **Localized number/unit formatting** beyond the existing `@tarmoto/shared` rider-format
  helpers.

## Background — current state

### Email templates (backend)

- Templates are pure functions `(ctx) => { subject, html, text, tag }` in
  `apps/backend/src/modules/email/templates/index.ts`. There is **no runtime template
  engine** — deliberately. Two properties follow from that and must be preserved:
  1. A missing/renamed variable is a **compile error**, not a broken send.
  2. There is **no arbitrary-expression interpolation surface**. This matters because
     verification, password-reset, and trip-invite bodies embed live one-time tokens.
- Shared HTML chrome lives in `templates/layout.ts`: `renderLayout`, `renderTextFooter`,
  `escapeHtml`, `BRAND`. All user-supplied interpolations are `escapeHtml`'d before
  entering the HTML body.
- `EmailService` (`email.service.ts`) exposes ten `send*` methods; each builds a
  template and calls the best-effort private `dispatch`.

The ten templates / tags: `verification`, `password-reset`, `password-changed`,
`subscription-confirmed`, `subscription-cancelled`, `data-export-ready`,
`account-deletion-scheduled`, `trip-invite`, `weekly-digest`,
`account-deletion-completed`.

### Companion i18n (the pattern to reuse)

`apps/companion/src/i18n` already implements exactly the mechanism we want:

- Typed catalog `Record<EnglishMessageKey, string>`; English is the source of truth
  **and** the fallback. Other locales are `Partial` and fall back key-by-key, then to
  the raw key.
- `translate(key, values?, locale?)` does plain `{var}` substitution — no ICU, no
  engine. Same low-injection style as the email templates.
- `resolveLocale(input)` parses an `Accept-Language` string honouring RFC 7231
  q-weights.
- Today only `en` is registered. The companion is i18n-_ready_, English-only —
  the same maturity level this phase brings to email.

### The gatekeeper

Emails are sent server-side; the weekly digest runs from a BullMQ cron with **no
request context**, only the user row. There is **no persisted per-user language**
anywhere. So actually delivering a non-English email is a separate, later piece
(Phase 2). Phase 1 lands only the structure.

### Send-path trigger inventory

| Has request context (Phase 2 could read `Accept-Language`)                               | No request — cron / job / webhook (always default)                                                                                                |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| verification, password-reset, password-changed, account-deletion-scheduled, trip-invite¹ | weekly-digest (cron), data-export-ready (job), account-deletion-completed (job), subscription-confirmed / subscription-cancelled (Stripe webhook) |

¹ trip-invite's request belongs to the _inviter_; the recipient is frequently not a
user, so their language is unknowable. It defaults to `en`.

## Architecture

**One shared core, per-surface catalogs.** The language list and the
lookup/fallback/interpolation logic live once in `@tarmoto/shared`; each surface
(companion UI, backend email, later mobile) owns its own message catalog and
instantiates a translator over the shared core.

Rejected alternatives:

- **One product-wide catalog** (all UI + email keys in a single map per locale):
  couples email copy to UI copy, bloats one file, every translator sees everything.
- **Copy the pattern into the backend, leave the companion on its own copy:** two
  `resolveLocale`s / two translators that drift; also not the requested extraction.

## Detailed design

### 1. Shared core — `packages/shared/src/i18n.ts`

Framework-agnostic, dependency-free. Exported from the shared barrel
(`export * from "./i18n"`).

Exports:

- `DEFAULT_LOCALE = "en"`.
- `LOCALES` — the language **registry**, now metadata only: `{ en: { label: "English" } }`.
  (No `messages` here — catalogs are per-surface. Adding a language adds an entry here
  plus a catalog file in each surface.)
- `SupportedLocale = keyof typeof LOCALES`, `SUPPORTED_LOCALES`.
- `isSupportedLocale(value): value is SupportedLocale` (uses `Object.hasOwn`, as today).
- `resolveLocale(input?): SupportedLocale` — the companion's q-weight `Accept-Language`
  parser, moved verbatim with its tests.
- `TranslationValues = Record<string, string | number>`.
- `Catalog<K extends string> = Record<K, string>`.
- `makeTranslator<K extends string>(catalogs)` where `catalogs` is
  `{ en: Catalog<K> } & Partial<Record<SupportedLocale, Partial<Catalog<K>>>>`
  (the default locale is exhaustive; others are partial). Returns
  `(key: K, values?: TranslationValues, locale?: SupportedLocale) => string` that:
  active-locale lookup → English fallback → raw-key fallback, then `{var}`
  substitution. **No escaping** (raw substitution, identical to today's companion
  `translate`).

The lookup/fallback/interpolation behaviour and `resolveLocale` are the valuable,
tested parts — they now exist once.

### 2. Companion migration (behavior-preserving)

`i18n/index.ts` and `i18n/locales/index.ts` are rewired to consume the shared core:

- Delete the companion's private `readMessage`/`lookup`, its local `resolveLocale`,
  `isSupportedLocale`, and the `Record`-with-`messages` registry.
- Build `const baseTranslate = makeTranslator<EnglishMessageKey>(companionCatalogs)`.
- Keep, in the companion (Next-specific, must NOT move to shared):
  - `server.ts` (`next/headers`, React `cache()`),
  - the module-global `activeLocale` + `setActiveLocale`/`getActiveLocale` and the
    `translate(key, values, locale = activeLocale)` wrapper that injects it,
  - `LOCALE_COOKIE = "tarmoto-locale"`,
  - `I18nProvider.tsx`.
- **Barrel invariance:** the public surface of `@/i18n` (`t`, `translate`,
  `resolveLocale`, `LOCALES`, `SUPPORTED_LOCALES`, `isSupportedLocale`,
  `SupportedLocale`, `LOCALE_COOKIE`, `DEFAULT_LOCALE`, …) stays identical, so the
  ~98 consumer imports are untouched.
- **Implementation check:** grep for any consumer reading `LOCALES[...].messages`. The
  registry no longer carries `messages`. If a locale-switcher reads it, expose the
  companion catalogs through a companion-local export instead; do not re-add `messages`
  to the shared registry.
- The companion's `i18n/index.test.ts` parity suite guards the refactor and must stay
  green. The `resolveLocale` cases move to the shared package's test.

### 3. Email catalog + template refactor — `apps/backend/src/modules/email/i18n/`

- New typed `en` catalog `Record<EmailMessageKey, string>` holding **all** copy:
  subjects, headings, paragraphs, button labels, and the `layout`/footer strings
  (unsubscribe label, transactional footer). Keys namespaced by template, e.g.
  `verification.subject`, `verification.heading`, `digest.greeting`,
  `tripInvite.subject`, `layout.footer.unsubscribe`.
- Module-level `const translateEmail = makeTranslator<EmailMessageKey>({ en })`.
- Each of the ten template functions gains a trailing
  `locale: SupportedLocale = DEFAULT_LOCALE`, binds `const t = (k, v?) => translateEmail(k, v, locale)`,
  and composes `subject`/`html`/`text` from `t(...)` instead of inline literals.
- **`renderLayout` stays a copy-agnostic HTML assembler:** templates pass it
  already-translated strings (e.g. `renderLayout({ …, unsubscribeLabel: t("layout.footer.unsubscribe") })`).
  It does not gain a translator.
- **Escaping discipline preserved.** Catalog values are trusted, markup-free, in-repo
  copy. User-supplied interpolations are escaped for the HTML body and raw for text:
  the template builds two value maps and calls the translator twice —
  `t("verification.heading", { name: escapeHtml(ctx.displayName) })` for HTML,
  `t("verification.heading", { name: ctx.displayName })` for text.
- **Pluralization stays template-side** (English-only): the template picks the
  `ride`/`rides` phrasing in code and interpolates it. No plural keys, no ICU.

### 4. The `locale` seam through `EmailService`

- Every `EmailService.send*` gains a trailing `locale: SupportedLocale = DEFAULT_LOCALE`
  and forwards it to the template.
- **Phase 1: every call site passes the default (or omits it).** The nine callers
  (`account.service`, `account-deletion.service`, `data-export.processor`,
  `password-reset.service`, `email-verification.service`, `digest-weekly.processor`,
  `admin-email.service`, `trips.service`) are unchanged in behavior; output is
  uniformly English.
- The seam is real and tested (a unit test passes a non-`en` locale and asserts English
  fallback), so Phase 2 is purely "add a catalog + populate this parameter," with zero
  template or call-site restructuring.

## Security / injection

The no-injection property is preserved by two rules, both encoded in the template layer:

1. Catalog strings are authored in-repo, reviewed via PR, and contain no markup.
2. Any interpolated **user data** is `escapeHtml`'d before it reaches the HTML body,
   exactly as today. `makeTranslator` performs raw substitution, so escaping is the
   caller's responsibility — matching the current template contract.

A test asserts that a `<script>`-bearing `displayName` is escaped in the rendered HTML.

## Testing

- **Shared:** `makeTranslator` — active-locale hit, English fallback, raw-key fallback,
  `{var}` interpolation, missing-value passthrough; `resolveLocale` q-weight cases
  (moved from companion).
- **Companion:** existing `i18n/index.test.ts` parity suite stays green; barrel surface
  unchanged.
- **Email:** `en` catalog exhaustiveness is compile-enforced by `Record<EmailMessageKey, string>`,
  plus a runtime test that every template renders with no raw-key leakage; an escaping
  test (see above); a fallback test proving an unknown/partial locale yields English.

## PR sequencing

1. **PR 1 — `refactor(shared): extract i18n core; companion consumes it`.** Shared
   `i18n.ts` + shared tests; companion rewired onto it with an identical barrel surface.
   Pure refactor, no behavior change, guarded by the companion suite.
2. **PR 2 — `feat(backend): i18n-ready email templates`.** Email `en` catalog, the ten
   template refactors, and the `locale` seam through `EmailService`. Backend-only.

## Risks & mitigations

- **Companion regression** during extraction → the companion i18n test suite plus the
  identical barrel surface; the `LOCALES[...].messages` grep check.
- **Shared package gains i18n** → pure TypeScript, no new dependencies; consistent with
  the existing flat-file `src/*.ts` + barrel convention.
- **`en`-only `locale` seam looks like dead code** until Phase 2 → intentional; a unit
  test exercises it with a non-default locale so it is not untested.

## Phase 2 preview (out of scope here)

Persist a per-user language (`users.language` or `notification_preferences.locale`),
capture it (signup `Accept-Language` and a companion settings toggle that writes it),
wire it into the digest cron and the other send paths, and add a translated catalog
(the companion's placeholder example locale is `et` / "Eesti"). None of that requires
touching the template functions or `EmailService` signatures again.
