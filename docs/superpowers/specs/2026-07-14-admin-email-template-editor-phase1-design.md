# Admin Email Template Editor — Phase 1: Backend Foundation

- **Status:** Approved design, ready for implementation planning
- **Date:** 2026-07-14
- **Scope label:** `backend`
- **Builds on:** the email i18n system (#955/#958/#960/#962/#964 — catalog, `translateEmail`, `renderLayout` chrome, `locale` seam, `users.language`)
- **Part of:** a 3-phase feature (this = Phase 1). Phase 2 = admin editor UI + API; Phase 3 = versioning/history/revert + per-locale workflow.

## Goal

Let admins customize the **structure and copy** of a defined set of transactional emails via a **structured block editor**, without a code deploy — while preserving the no-injection / escaping guarantees the current code-function templates provide. Phase 1 builds the **backend foundation only**: the block schema, versioned storage, a code-owned block renderer, the per-template variable whitelist, and the render-override seam. **No admin UI in this phase** — the code templates still render for every email; the override path exists and is unit-testable but has no way to be populated yet.

## The model (whole-feature context)

**Additive override with code fallback.** The existing code templates remain the default and the fallback. An admin-authored **block document** per `(template, locale)`, once _published_, renders instead of the code template; with no published override, the code template renders exactly as today. There is always a safe fallback, and nothing changes until an admin opts in.

## Scope — which emails are editable

**Editable (6)** — lower-risk notices/marketing:
`weekly-digest`, `subscription-confirmed`, `subscription-cancelled`, `data-export-ready`, `account-deletion-scheduled`, `account-deletion-completed`.

**Locked (4)** — code-only, no override path:
`verification`, `password-reset`, `trip-invite` (carry live one-time tokens), and `password-changed` (a security notice; **locked as a judgment call** — flag in review if it should be editable).

> Note: the deletion notices are editable per the agreed scope, but they carry GDPR/legal wording and the deliberate "support-only restore during the grace window" copy. The code template remains the safe fallback; admin edits to legal copy are the admin's responsibility.

## Non-Goals (Phase 1)

- **No admin UI and no admin CRUD/publish API** — Phase 2. Phase 1 ships the storage + renderer + seam and tests them directly; no email actually renders from an override yet (nothing populates one).
- **No versioning workflow** (draft/publish transitions, history, revert, reset-to-default) — Phase 3. The schema carries `status`/`version` so Phase 3 needs no migration, but Phase 1 exercises only "read the single published override".
- **No raw HTML, no arbitrary URLs, no inline markup.** Block paragraphs are plain text (inline `<strong>` from the current designs is dropped in the block path; a `**bold**`→`<strong>` mini-transform is a possible later addition). Button URLs are **whitelist-only** (a context URL variable), never admin-typed.
- Locked emails get no override path at all.

## Design — components

### 1. Storage — `email_template` entity + migration

A versioned table; the active override is the single `published` row per `(template_tag, locale)`.

| Column         | Type             | Notes                                                                    |
| -------------- | ---------------- | ------------------------------------------------------------------------ |
| `id`           | uuid PK          |                                                                          |
| `template_tag` | varchar          | one of the 6 editable tags (validated in code against the editable set)  |
| `locale`       | varchar(10)      | `SupportedLocale`                                                        |
| `subject`      | text             | editable subject: plain text + whitelisted `{var}` placeholders, no HTML |
| `blocks`       | jsonb            | the block document (array of typed blocks)                               |
| `status`       | varchar          | `draft` \| `published`                                                   |
| `version`      | int              | monotonic per `(tag, locale)`                                            |
| `created_by`   | uuid             | admin id (nullable for seed/system)                                      |
| `created_at`   | timestamptz      |                                                                          |
| `published_at` | timestamptz null |                                                                          |

- Partial unique index enforcing **at most one `published` row per `(template_tag, locale)`** (`WHERE status = 'published'`).
- TypeORM entity + migration; register the entity in all three lists (barrel + `data-source.ts` + `database.module.ts`, per `migration-registry.spec`) and the migration in both migration lists.

### 2. Block document schema (`@tarmoto/shared`)

`blocks: EmailBlock[]`, a discriminated union our renderer owns:

```ts
type EmailBlock =
  | { type: "heading"; text: string } // text may contain {vars}
  | { type: "paragraph"; text: string } // plain text + {vars}
  | { type: "button"; label: string; urlVar: string } // urlVar ∈ template's URL whitelist
  | { type: "stat-row"; label: string; value: string } // label/value, text + {vars}
  | { type: "divider" }
  | { type: "spacer" };
```

Placed in `@tarmoto/shared` so the (future) admin editor and the backend renderer share one definition. Includes a `isEmailBlock`/schema validator used on write (Phase 2) and defensively on read.

### 3. Per-template variable whitelist + `presentationContext`

Each editable template gets a `presentationContext(ctx)` returning its **pre-formatted, presentation-ready** variables (numbers unit-formatted, counts pluralized, dates formatted) — admins never write formatting/plural logic. Two whitelists per template: **text vars** (usable in any text field) and **URL vars** (usable as a `button.urlVar`).

Example — `weekly-digest`:

- text vars: `displayName`, `rideSummary` (`"4 rides"`), `distance` (`"213 km"`), `duration` (`"6h 12m"`), `quality` (`"4.2 / 5"` or empty), `riddenSegments` (`"512"`), `percentExplored` (`"38%"`).
- url vars: `exploreUrl`.

`subscription-confirmed`: text `displayName`, `planName`, `priceLabel`, `renewsText`; url `manageBillingUrl`. (Analogous per-template maps for the other four — enumerated in the plan, derived verbatim from each template's current formatting.)

**Extraction:** pull the formatting out of each code template into its `presentationContext`, and refactor the code template to render from it — so the code path and block path share **one** formatting source. This refactor is guarded **byte-identical** by the existing 45 characterization snapshots (0 written).

### 4. Block renderer (code-owned — the safety boundary)

`renderBlocks(doc, presentationCtx, locale): { subject, html, text }`:

- Resolves every `{var}` from the template's whitelist; **unknown vars are dropped** (never echoed).
- **Escapes** every interpolated value for the HTML body (user data and computed strings alike) and emits each block's markup from fixed, code-owned templates (heading → `<h..>`, button → the branded `<a>` with `escapeHtml(url)` where url is resolved from the whitelisted `urlVar`, stat-row → the table row, etc.). Text output is the plain-text projection.
- Produces the **body**; the existing **`renderLayout`/`renderTextFooter` chrome wraps it** (header, footer, `<html lang>`) — chrome, footer, and their escaping stay fully code-owned.
- The subject is rendered from the stored `subject` text with whitelisted vars **interpolated raw** — the subject is a plain-text email header, not HTML (matching how the current code templates build subjects). No HTML, so no escaping applies.

No block can emit raw HTML; no admin string reaches the HTML unescaped; no admin-controlled URL exists (only whitelisted context URLs).

### 5. Render-override seam in `EmailService`

For an **editable** tag, before building the template: look up the published `email_template` for `(tag, ctx.locale)`.

- Found → `renderBlocks(override, presentationContext(ctx), ctx.locale)`.
- Not found (or the repo/lookup errors) → the **code template renders as today** (best-effort: a lookup failure must never block a send; fall back to code + log).
- **Locked** tags skip the lookup entirely and always render from code.

The lookup is `@Optional()`-repo-guarded like the `email_log` write, so unit tests can construct `EmailService` without the DB layer.

## Safety model (the whole point)

1. **Chrome + footer stay code-owned** (`renderLayout`/`renderTextFooter`) — admins only fill the body.
2. **No raw HTML / no markup** — blocks compile to fixed code-owned markup; admin text is plain and escaped.
3. **Variables whitelisted + escaped** — only per-template presentation vars resolve; user data is `escapeHtml`'d; unknown vars dropped.
4. **Button URLs whitelist-only** — no admin-typed URLs (no phishing-link vector).
5. **Locked emails** (token/security) have no override path.
6. **Code fallback always exists** — a missing/invalid/failed override renders the current code template; a send never breaks.

## Testing

- **Storage:** entity + migration up/down; the partial unique index rejects a second `published` row for the same `(tag, locale)`.
- **Block schema:** the validator accepts valid docs and rejects unknown block types / malformed blocks / a `button.urlVar` outside the whitelist.
- **`presentationContext` extraction:** the 45 characterization snapshots stay byte-identical (the code templates now render from `presentationContext`).
- **Block renderer:** a sample block doc renders expected subject/html/text; a `{var}` resolves + is escaped (a `<script>` in a user value is escaped in HTML, raw in text); an unknown `{var}` is dropped; a `button.urlVar` resolves to the whitelisted URL, `escapeHtml`'d.
- **Seam:** with a stub published override, `EmailService.send*` renders via blocks; with none, it renders the code template; a repo error falls back to code; a locked tag never looks up.

## Risks

- **`presentationContext` refactor touches the working templates** → guarded byte-identical by the 45 snapshots.
- **Schema must support Phase 3 without migration** → `status`/`version`/`published_at` included now.
- **Inline emphasis lost** in the block path (plain-text paragraphs) → acceptable for a new admin-authored path; `**bold**` transform deferred.
- **Legal/GDPR copy becomes admin-editable** for the deletion notices → code fallback + admin responsibility; flag in review if those should also be locked.
