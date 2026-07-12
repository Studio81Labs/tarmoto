# Email i18n Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed the Phase-1 email `locale` seam from a real per-user language and localize the footer + `<html lang>`, still English-only output.

**Architecture:** Add a `users.language` column (seeded from `Accept-Language` at signup, changeable via `PATCH /me` + a companion `/api/locale` bridge); every `EmailService.send*` call site passes the recipient user's `language`; `renderLayout`/`renderTextFooter` take `locale` and self-translate the footer from the email catalog. Everyone is `'en'`, so output is byte-identical — guarded by the 45 characterization snapshots.

**Tech Stack:** NestJS 11 + TypeORM (PostgreSQL), `@tarmoto/shared` i18n (`resolveLocale`, `SupportedLocale`, `SUPPORTED_LOCALES`, `DEFAULT_LOCALE`), Next.js companion, jest (backend), vitest (companion).

## Global Constraints

- **Task numbers are globally unique** across the 3 PRs (1–6) so per-task briefs extract cleanly.
- **English-only output; byte-identical.** `SUPPORTED_LOCALES` stays `['en']`. The 45 characterization snapshots (`apps/backend/src/modules/email/templates/templates.snapshot.spec.ts`) MUST stay unchanged (0 written) wherever email rendering is touched.
- **Backend jest is transpile-only** (does not typecheck); the repo has ~471 pre-existing unrelated `tsc` errors. Guard type changes by confirming **0 NEW** errors in touched files (`cd apps/backend && npx tsc -p tsconfig.json --noEmit`, compare to baseline), and rely on the CI "Emit + validate OpenAPI" job for the strict gate.
- **Ambient jest globals** in backend specs (no `@jest/globals` import).
- **Contract:** any new DTO field regenerates the committed OpenAPI spec (`pnpm openapi:gen`) AND the Postman collection (`pnpm postman:gen`), then `prettier --write` the Postman file so the diff stays scoped.
- **Conventional commits, scope required**, subject lowercase-first-char ≤100 chars; body ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Metric/units, privacy, best-effort-send** rules unchanged. `EmailService.send*` failures never propagate to user-facing responses.

---

# PR 1 — `feat(backend): localize email footer + <html lang>`

Closes the Codex thread on #958. Piece 4 of the spec.

## File structure

- Modify `apps/backend/src/modules/email/i18n/en.ts` — add `layout.*` footer keys (values verbatim from today's footer strings).
- Modify `apps/backend/src/modules/email/templates/layout.ts` — `renderLayout`/`renderTextFooter` take `locale` and translate the footer via `translateEmail`; `<html lang>` uses `locale`.
- Modify `apps/backend/src/modules/email/templates/index.ts` — the 10 templates pass `locale: ctx.locale` to `renderLayout` and `ctx.locale` to `renderTextFooter`.
- Test `apps/backend/src/modules/email/templates/templates.i18n.spec.ts` — add a footer-fallback + `<html lang>` case.

### Task 1: Footer + `<html lang>` localize via `locale`

**Files:**

- Modify: `apps/backend/src/modules/email/i18n/en.ts`
- Modify: `apps/backend/src/modules/email/templates/layout.ts`
- Modify: `apps/backend/src/modules/email/templates/index.ts`
- Test: `apps/backend/src/modules/email/templates/templates.i18n.spec.ts`, and the existing `templates.snapshot.spec.ts` (guard)

**Interfaces:**

- Consumes: `translateEmail`, `EmailMessageKey` (`../i18n/index.js`); `SupportedLocale`, `DEFAULT_LOCALE` (`@tarmoto/shared`); `ctx.locale` on every template context (Phase-1 `BaseContext.locale`).
- Produces: `renderLayout(ctx: LayoutContext & { locale?: SupportedLocale })`; `renderTextFooter(preferencesUrl: string, marketing?: boolean, locale?: SupportedLocale)`.

- [ ] **Step 1: Add the footer catalog keys to `en.ts`** (values copied verbatim from the current `layout.ts` footer strings). Append to the object:

```ts
  // --- layout footer (shared chrome) ---
  "layout.footer.transactional.lead":
    "This is a transactional message about your Tarmoto account.",
  "layout.footer.transactional.link": "Manage notifications",
  "layout.footer.marketing.lead":
    "You're receiving this digest as part of your Tarmoto subscription.",
  "layout.footer.marketing.link": "Unsubscribe from marketing emails",
  "layout.textFooter.transactional.tagline": "Tarmoto · transactional email",
  "layout.textFooter.transactional.line": "Manage notifications: {url}",
  "layout.textFooter.marketing.tagline": "Tarmoto · weekly digest",
  "layout.textFooter.marketing.lead":
    "You're receiving this as part of your Tarmoto subscription.",
  "layout.textFooter.marketing.unsub":
    "Unsubscribe from marketing emails: {url}",
```

- [ ] **Step 2: Refactor `layout.ts`.** Add the import and thread `locale`. Replace the `<html lang>` line and both footer sites:

```ts
import { translateEmail } from "../i18n/index.js";
import { DEFAULT_LOCALE, type SupportedLocale } from "@tarmoto/shared";

export interface LayoutContext {
  preheader: string;
  bodyHtml: string;
  preferencesUrl: string;
  marketingFooter?: boolean;
  /** Recipient locale for footer copy + <html lang>. Defaults to English. */
  locale?: SupportedLocale;
}
```

In `renderLayout`, compute `const loc = ctx.locale ?? DEFAULT_LOCALE;`, change the doctype line to `<html lang="${escapeHtml(loc)}">`, and replace the footer `<td>` inner expression with:

```ts
                ${translateEmail(
                  ctx.marketingFooter
                    ? 'layout.footer.marketing.lead'
                    : 'layout.footer.transactional.lead',
                  undefined,
                  loc,
                )} <a href="${escapeHtml(ctx.preferencesUrl)}" style="color:${BRAND.primary};">${translateEmail(
                  ctx.marketingFooter
                    ? 'layout.footer.marketing.link'
                    : 'layout.footer.transactional.link',
                  undefined,
                  loc,
                )}</a>.
```

Replace `renderTextFooter`:

```ts
export const renderTextFooter = (
  preferencesUrl: string,
  marketing = false,
  locale: SupportedLocale = DEFAULT_LOCALE,
): string => {
  if (marketing) {
    return `\n\n—\n${translateEmail("layout.textFooter.marketing.tagline", undefined, locale)}\n${translateEmail("layout.textFooter.marketing.lead", undefined, locale)}\n${translateEmail("layout.textFooter.marketing.unsub", { url: preferencesUrl }, locale)}\n`;
  }
  return `\n\n—\n${translateEmail("layout.textFooter.transactional.tagline", undefined, locale)}\n${translateEmail("layout.textFooter.transactional.line", { url: preferencesUrl }, locale)}\n`;
};
```

- [ ] **Step 3: Templates pass `locale`.** In `templates/index.ts`, every `renderLayout({ ... })` call gains `locale: ctx.locale,` and every `renderTextFooter(ctx.preferencesUrl)` / `renderTextFooter(ctx.preferencesUrl, true)` gains a trailing `ctx.locale` argument (→ `renderTextFooter(ctx.preferencesUrl, false, ctx.locale)` / `renderTextFooter(ctx.preferencesUrl, true, ctx.locale)`). There are 10 `renderLayout` calls and 10 `renderTextFooter` calls (the digest uses the `marketing = true` form).

- [ ] **Step 4: Run the snapshot suite — MUST be byte-identical.**

Run: `pnpm --filter @tarmoto/backend test -- templates.snapshot`
Expected: `45 passed, 0 written, 0 obsolete`. A diff means a footer catalog value drifted from the original — fix the value in `en.ts`, do NOT update the snapshot.

- [ ] **Step 5: Add a footer-fallback test** to `templates.i18n.spec.ts`:

```ts
import { renderLayout, renderTextFooter } from "./layout.js";
import type { SupportedLocale } from "@tarmoto/shared";

describe("layout footer localization", () => {
  it("sets <html lang> to the passed locale and falls back to English footer copy", () => {
    const html = renderLayout({
      preheader: "x",
      bodyHtml: "<p>x</p>",
      preferencesUrl: "https://x/prefs",
      // Unregistered locale — exercises the English fallback while lang reflects it.
      locale: "et" as SupportedLocale,
    });
    expect(html).toContain('<html lang="et">');
    expect(html).toContain("Manage notifications");
  });

  it("renders the marketing text footer in English for an unregistered locale", () => {
    const text = renderTextFooter(
      "https://x/prefs",
      true,
      "et" as SupportedLocale,
    );
    expect(text).toContain(
      "Unsubscribe from marketing emails: https://x/prefs",
    );
  });
});
```

Run: `pnpm --filter @tarmoto/backend test -- templates.i18n` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/email
git commit -m "$(cat <<'EOF'
feat(backend): localize email footer + <html lang>

renderLayout/renderTextFooter take a locale and translate the shared footer
chrome from the email catalog (+ set <html lang>), so the whole rendered email
flows through the Phase-1 seam. Byte-identical at en (45 snapshots unchanged).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

### Task 2: PR 1 verify + open PR

- [ ] **Step 1:** `pnpm --filter @tarmoto/backend test -- email` (all green, 45 snapshots byte-identical) + `pnpm --filter @tarmoto/backend build` (nest build OK).
- [ ] **Step 2:** Push `feat/email-i18n-footer`, open PR titled `feat(backend): localize email footer + <html lang>`; body notes it closes the Codex thread on #958, byte-identical via snapshots, no contract change. End body with the `🤖 Generated with [Claude Code]` line.

---

# PR 2 — `feat(backend): per-user email language`

Pieces 1–3. Branch `feat/email-per-user-language` from `main` after PR 1 merges.

## File structure

- Modify `apps/backend/src/entities/user.entity.ts` — `language` column.
- Create `apps/backend/src/migrations/<timestamp>-AddUserLanguage.ts` — the migration.
- Modify `apps/backend/src/modules/users/dto/update-profile.dto.ts` — `language?` field.
- Modify `apps/backend/src/modules/users/dto/user-response.dto.ts` — `language` field.
- Modify `apps/backend/src/modules/users/users.service.ts` — persist `language`; expose in response.
- Modify the signup/user-creation path (`apps/backend/src/modules/auth/…` register) — seed `language` from `Accept-Language`.
- Modify the ~12 `EmailService.send*` call sites — pass the recipient's `language`.

### Task 3: `users.language` column + migration

**Files:**

- Modify: `apps/backend/src/entities/user.entity.ts`
- Create: `apps/backend/src/migrations/<timestamp>-AddUserLanguage.ts` (match the repo's existing migration filename convention — check `apps/backend/src/migrations/` for the timestamp format)
- Test: migration is exercised by `pnpm db:migrate` against the dev DB (see step 4)

**Interfaces:**

- Produces: `User.language: SupportedLocale` (column, default `'en'`).

- [ ] **Step 1: Add the entity column** in `user.entity.ts` (import `type SupportedLocale` from `@tarmoto/shared`):

```ts
  @Column({ type: 'varchar', length: 10, default: 'en' })
  language!: SupportedLocale;
```

- [ ] **Step 2: Write the migration** (mirror an existing migration in `apps/backend/src/migrations/` for class-name + timestamp style):

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUserLanguage1234567890000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "language" varchar(10) NOT NULL DEFAULT 'en'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "language"`);
  }
}
```

- [ ] **Step 3:** Register the migration if the repo lists migrations explicitly (check `data-source.ts`/`database.module.ts` migration globs — most repos auto-glob `migrations/*.ts`; only add if required).
- [ ] **Step 4: Run it.** `pnpm db:up` (if needed) then `pnpm db:migrate` → migration applies cleanly; verify `\d users` shows `language` with default `'en'`. Confirm `down` by a manual revert if the repo exposes one, else inspect the SQL.
- [ ] **Step 5: Commit** (`feat(backend): add users.language column`).

### Task 4: Capture language at signup

**Files:**

- Modify: the auth register controller + service (where `User` is created and `sendVerification` is called — `apps/backend/src/modules/auth/…`)
- Test: the register spec

**Interfaces:**

- Consumes: `resolveLocale` (`@tarmoto/shared`); `User.language` (Task 3).

- [ ] **Step 1:** Read the register flow (controller → service `create`). Pass the request's `Accept-Language` header to the create path and set `language: resolveLocale(acceptLanguage)` on the new `User`. `resolveLocale(undefined)` → `DEFAULT_LOCALE`, so an absent header is safe.
- [ ] **Step 2: Test** (register spec): posting with `Accept-Language: et,en;q=0.8` creates a user with `language === 'en'` (only `en` is registered, so `et` resolves to the fallback — the CAPTURE works even though the value is still `en`); posting with no header → `language === 'en'`. If the register test can't read the persisted row, assert the value passed to the create/repository call via a spy.
- [ ] **Step 3: Commit** (`feat(backend): seed user language from Accept-Language at signup`).

### Task 5: `PATCH /me` language + read model + contract

**Files:**

- Modify: `apps/backend/src/modules/users/dto/update-profile.dto.ts`
- Modify: `apps/backend/src/modules/users/dto/user-response.dto.ts`
- Modify: `apps/backend/src/modules/users/users.service.ts`
- Test: `apps/backend/src/modules/users/…` service/controller spec

**Interfaces:**

- Consumes: `SUPPORTED_LOCALES`, `SupportedLocale` (`@tarmoto/shared`).
- Produces: `UpdateProfileDto.language?: SupportedLocale`; `UserResponseDto.language: SupportedLocale`.

- [ ] **Step 1: DTO field** in `update-profile.dto.ts` (the DTO already uses `class-validator` + `@IsIn`):

```ts
import { SUPPORTED_LOCALES, type SupportedLocale } from '@tarmoto/shared';
// ...
  @ApiProperty({ enum: SUPPORTED_LOCALES, required: false })
  @IsOptional()
  @IsIn(SUPPORTED_LOCALES)
  language?: SupportedLocale;
```

- [ ] **Step 2: Read model** in `user-response.dto.ts`:

```ts
  @ApiProperty({ enum: SUPPORTED_LOCALES })
  language!: SupportedLocale;
```

- [ ] **Step 3:** In `users.service.ts`, persist `dto.language` in `updateProfile` when present (follow the existing field-copy pattern), and include `language` wherever the service builds a `UserResponseDto` (getProfile/updateProfile).
- [ ] **Step 4: Tests** (ambient jest globals): `PATCH /me { language: 'en' }` persists and the response carries `language: 'en'`; `PATCH /me { language: 'xx' }` → 400 (fails `@IsIn`); `GET /me` includes `language`.
- [ ] **Step 5: Regenerate contract** (a DTO field changed):

```bash
pnpm openapi:gen
pnpm postman:gen
npx prettier --write <the postman collection file>
```

Confirm the OpenAPI + Postman diffs contain only the `language` additions.

- [ ] **Step 6: Commit** (`feat(backend): expose + accept user language on the profile API`).

### Task 6: Resolve — send paths pass the recipient's language

**Files:**

- Modify each `EmailService.send*` call site (list below)
- Test: the corresponding service/processor specs

**Interfaces:**

- Consumes: `User.language`; `DEFAULT_LOCALE` (`@tarmoto/shared`).

- [ ] **Step 1: Thread `user.language` as the trailing `locale` arg** at each site. Each already loads (or can load) the recipient `User`:

| Site                                  | Call                           | Locale source                                                                                                         |
| ------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `email-verification.service.ts:98`    | `sendVerification`             | `user.language`                                                                                                       |
| `password-reset.service.ts:127`       | `sendPasswordReset`            | `user.language`                                                                                                       |
| `password-reset.service.ts:198`       | `sendPasswordChanged`          | `user.language`                                                                                                       |
| `account.service.ts:434`              | `sendSubscriptionConfirmed`    | `user.language`                                                                                                       |
| `account.service.ts:456`              | `sendSubscriptionCancelled`    | `user.language`                                                                                                       |
| `account-deletion.service.ts:174`     | `sendAccountDeletionScheduled` | `user.language`                                                                                                       |
| `account-deletion.service.ts:223/292` | `sendAccountDeletionCompleted` | **capture `purgedFields.language` BEFORE `purgeUser` deletes the row**, pass that (the user row is gone by send time) |
| `data-export.processor.ts:75`         | `sendDataExportReady`          | `user.language`                                                                                                       |
| `digest-weekly.processor.ts:309`      | `sendWeeklyDigest`             | `user.language` (the composed user)                                                                                   |
| `trips.service.ts:725`                | `sendTripInvite`               | look up a user by `dto.email`; `user?.language ?? DEFAULT_LOCALE` (external invitees have no stored preference)       |
| `admin-email.service.ts:48`           | `sendWeeklyDigest` (test-send) | `DEFAULT_LOCALE` (fixed-sample preview)                                                                               |

- [ ] **Step 2: Tests.** For each site's existing spec, assert the `locale` argument forwarded to the mocked `EmailService.send*` equals the recipient's `language` (spy on the method; check the trailing arg). Cover the two special cases explicitly: account-deletion-completed uses the pre-purge-captured language; trip-invite falls back to `DEFAULT_LOCALE` when the email is not a known user.
- [ ] **Step 3:** `cd apps/backend && npx tsc -p tsconfig.json --noEmit` — 0 new errors in touched files vs. baseline.
- [ ] **Step 4: Commit** (`feat(backend): send emails in the recipient's stored language`).

### Task 7: PR 2 verify + open PR

- [ ] **Step 1:** `pnpm --filter @tarmoto/backend test` (relevant suites green) + `pnpm --filter @tarmoto/backend build` + confirm OpenAPI/Postman diffs are scoped to `language`.
- [ ] **Step 2:** Open PR `feat(backend): per-user email language`; body calls out the migration, the contract change (`language` on profile DTOs), and that output is still English (seam fed by real data). Link the spec.

---

# PR 3 — `feat(companion): persist language choice to the user record`

Piece 5. Branch from `main` after PR 2 merges (needs the `PATCH /me { language }` field).

### Task 8: Bridge `/api/locale` → `PATCH /me`

**Files:**

- Modify: the companion `app/api/locale` route handler (`apps/companion/src/app/api/locale/route.ts` — confirm the path)
- Test: the route's test (or add one)

**Interfaces:**

- Consumes: the backend `PATCH /users/me { language }` (PR 2); the companion's authenticated backend client / session helper.

- [ ] **Step 1:** In the `/api/locale` POST handler, after validating the locale and setting the `tarmoto-locale` cookie, if the request is authenticated (session present), call the backend `PATCH /users/me { language: locale }` using the companion's existing typed backend client (per the companion-OpenAPI generated-client convention — do NOT hand-roll a raw fetch if a client exists). Wrap the backend call so a failure is logged and swallowed (the cookie is still set; a language toggle must not hard-fail).
- [ ] **Step 2:** Read the existing route to match its auth-detection + response shape; keep unauthenticated behavior cookie-only (no backend call).
- [ ] **Step 3: Test** (vitest): authenticated POST calls the backend client with `{ language: <locale> }`; unauthenticated POST does not; a backend rejection still returns the cookie-set success response. Run `pnpm --filter @tarmoto/companion typecheck` (CI typechecks test files) + `pnpm --filter @tarmoto/companion test`.
- [ ] **Step 4: Commit** (`feat(companion): persist language choice to the user record`) + open PR.

## Self-review (completed)

- **Spec coverage:** piece 1 (column+migration) → Task 3; piece 2 (capture: signup → Task 4, PATCH /me + read model + contract → Task 5); piece 3 (resolve) → Task 6; piece 4 (footer/lang) → Task 1; piece 5 (companion bridge) → Task 8. Non-goals (no translation, mobile, ICU) absent by construction.
- **Type consistency:** `User.language`, `UpdateProfileDto.language?`, `UserResponseDto.language`, and the `send*(…, locale)` trailing arg are all `SupportedLocale`; `resolveLocale`/`SUPPORTED_LOCALES`/`DEFAULT_LOCALE` from `@tarmoto/shared` throughout.
- **Byte-identical:** only Task 1 touches rendering; guarded by the 45 snapshots (Step 4). Task 6 changes the `locale` VALUE passed but everyone is `'en'`, so snapshots are unaffected (values equal `DEFAULT_LOCALE`).
- **Known nuances captured:** account-deletion-completed pre-purge language capture; trip-invite user-lookup fallback; admin test-send fixed `DEFAULT_LOCALE`; contract regen (OpenAPI + Postman) on the DTO change.
