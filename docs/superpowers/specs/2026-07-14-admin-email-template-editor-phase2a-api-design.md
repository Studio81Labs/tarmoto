# Admin Email Template Editor — Phase 2a: Backend CRUD/Publish/Preview API

- **Status:** Approved design, ready for implementation planning
- **Date:** 2026-07-14
- **Scope label:** `backend`
- **Builds on:** Phase 1 (#984 — `EmailBlock` schema, `email_template` entity, `renderBlocks`, `presentationContext`/`TEMPLATE_WHITELIST`, the `EmailService` override seam).
- **Part of:** Phase 2 of the admin email template editor. **2a = this (backend API).** 2b = the admin block-editor UI (consumes this). Phase 3 = versioning/history/revert.

## Goal

Give the (Phase-2b) admin editor a backend to read, validate, preview, draft, publish, and reset email-template overrides — reusing Phase 1's code-owned `renderBlocks` for preview so what an admin sees is exactly what a real send produces, and enforcing the variable whitelist + subject safety at write time. No UI in this phase.

## Roles (the approval gate)

- **`support`** — read, save draft, preview, test-send. Authors and iterates, but nothing they do reaches a real email.
- **`super_admin`** — **publish** (activate a draft as the live override) and **reset** (remove the published override). The single gate through which any change reaches real recipients.

All endpoints are audited by the existing `AdminAuditInterceptor`. Served prefix-less under `/admin/*` (per the admin-routing convention), in the existing `admin-email` module.

## Endpoints

| Endpoint                                              | Role            | Behavior                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/email/templates`                          | support         | List the 6 editable tags. Per tag: `label`, `hasDraft`, `hasPublished`, `legalSensitive` (true for `account-deletion-scheduled`/`-completed`). Locale-agnostic summary.                                                                                           |
| `GET /admin/email/templates/:tag/:locale`             | support         | The editable doc for `(tag, locale)`: the `draft` if one exists, else the `published`, else an empty starter (`{ subject: "", blocks: [] }`). Always returns the tag's `whitelist` (`{ textVars, urlVars }`) + `status` (`draft`/`published`/`none`) + `version`. |
| `PUT /admin/email/templates/:tag/:locale/draft`       | support         | Validate (below) + upsert the single `draft` row for `(tag, locale)`. Returns the saved doc.                                                                                                                                                                      |
| `POST /admin/email/templates/:tag/:locale/preview`    | support         | Validate + render the supplied `{subject, blocks}` via `renderBlocks` + the tag's **fixed sample** `presentationContext`. Returns `{ subject, html, text }`. No persistence.                                                                                      |
| `POST /admin/email/templates/:tag/:locale/test-send`  | support         | Same render as preview, dispatched to the requesting admin's own email (sync, best-effort, via `EmailService`).                                                                                                                                                   |
| `POST /admin/email/templates/:tag/:locale/publish`    | **super_admin** | Validate + promote the draft to `published` in a transaction: delete any existing `published` row for `(tag, locale)`, set the draft row `status='published'`, bump `version`, stamp `published_at`. 404 if no draft.                                             |
| `DELETE /admin/email/templates/:tag/:locale/override` | **super_admin** | Delete the `published` row for `(tag, locale)` → the code template renders again (reset to default). Idempotent.                                                                                                                                                  |

`tag` is validated against the 6 editable tags (400 otherwise); `locale` against `SUPPORTED_LOCALES`. Locked tags (`verification`/`password-reset`/`trip-invite`/`password-changed`) 404 on every route.

## Validation — `validateBlockDocument(tag, { subject, blocks })`

A shared backend helper, run on draft-save, preview, and publish. Rejects with a 400 carrying field-level errors (so the editor can point at the offending block/field):

1. **`isEmailBlockDocument`** (Phase 1 shared validator) — shape.
2. **Subject:** non-empty, no `\r`/`\n`/control chars (a CRLF could otherwise smuggle headers when a provider is swapped; reject defensively), reasonable max length.
3. **Variable whitelist:** every `{var}` token in the subject and in each block's text fields must be a key of `TEMPLATE_WHITELIST[tag].textVars`; every `button.urlVar` must be a key of `TEMPLATE_WHITELIST[tag].urlVars`. An unknown var/urlVar is a validation error (rather than the renderer silently dropping it) so the admin gets feedback.

The renderer's runtime drops remain the defense-in-depth backstop; this validation is the author-facing gate.

## Preview / test-send sample data

A `SAMPLE_PRESENTATION: Record<EditableTag, Presentation>` — a fixed, representative `{ textVars, urlVars }` per editable template (extend the existing `sampleDigestContext` idea to all 6). Preview/test-send call `renderBlocks(doc, SAMPLE_PRESENTATION[tag], { locale, preferencesUrl, marketingFooter: tag === 'weekly-digest' })`. Reusing the exact code-owned renderer means preview == real render and inherits every escaping/whitelist guarantee.

## Storage model (this phase)

One `draft` and at most one `published` row per `(tag, locale)` (the Phase-1 partial unique index already enforces ≤1 published). Save-draft upserts the draft; publish promotes it (deleting the prior published). **`archived`/history rows are deferred to Phase 3** — no schema change here (the `status`/`version` columns already exist).

## Contract

New DTOs — the block document (wire form of `EmailBlockDocument`), the template-summary list item, the get-response (doc + whitelist + status), the preview request/response. Regenerate the committed **OpenAPI** spec (`openapi:gen`) and **Postman** collection (`postman:gen` + prettier), and update generated-client consumers as the contract flow requires. The admin app (Phase 2b) will consume the generated types.

## Non-Goals (Phase 2a)

- **No admin UI** — Phase 2b.
- **No versioning workflow / history / revert-to-prior-version / `archived` rows** — Phase 3.
- **No "seed from the current design"** — GET returns a blank starter when no override exists; expressing each current email as blocks is a deferred follow-up (the code template is the live fallback meanwhile, so blank-start is safe, just less convenient).
- **No new block types / no raw HTML / no arbitrary URLs** — unchanged from Phase 1.

## Testing

- **Validation:** valid doc passes; a CRLF subject → 400; a `{var}` not in the whitelist → 400 (field-level); a `button.urlVar` not in the URL whitelist → 400; a malformed block → 400.
- **Roles:** a `support` token can draft/preview/test-send but is **403 on publish and reset**; a `super_admin` can publish/reset; a locked tag 404s.
- **GET:** returns draft over published over empty-starter; always includes the whitelist.
- **Publish transaction:** publishing deletes the prior published + activates the draft (only one published remains — assert against the partial unique index); publish with no draft → 404.
- **Preview/test-send:** render matches `renderBlocks` output for the sample; an invalid doc → 400 before any render; test-send dispatches to the admin's own address.
- **Reset:** deletes the published override (code template renders again); idempotent (no published → still 2xx).
- **Contract:** OpenAPI + Postman diffs scoped to the new email-template DTOs/paths.

## Risks

- **Publish atomicity:** the delete-old-published + promote-draft must be one transaction, or the partial unique index will reject the promote (two published mid-operation). Explicitly transactional.
- **Contract drift into consumers:** the new DTOs land in the generated client; the admin app (2b) is the consumer, not yet built, so no consumer mocks break here — but keep the OpenAPI/Postman regen in this PR.
- **Legal-sensitive publish:** the `super_admin`-only publish IS the review gate; the `legalSensitive` flag is surfaced for the UI to warn. No softer path for the deletion notices.
