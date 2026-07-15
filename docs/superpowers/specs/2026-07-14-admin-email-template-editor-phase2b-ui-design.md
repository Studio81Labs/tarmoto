# Admin Email Template Editor — Phase 2b: Admin Editor UI

- **Status:** Approved design, ready for implementation planning
- **Date:** 2026-07-14
- **Scope label:** `cross` (a small `backend` seeding addition + the `admin` editor UI)
- **Builds on:** Phase 2a (#988 — the 7 `/admin/email/templates*` endpoints, the DTOs in the generated client, `EmailBlock`/`validateBlockDocument`/`TEMPLATE_WHITELIST`, `SAMPLE_PRESENTATION`, the code-owned `renderBlocks` used by `/preview`).
- **Part of:** Phase 2 of the admin email-template editor. **2a = backend API (done).** 2b = this (admin UI). Phase 3 = versioning/history/revert.

## Goal

Give admins a working UI in the admin app to author, preview, test-send, draft, publish, and reset the per-`(tag, locale)` email-template overrides. When a template has no override yet, **seed** the editor from the current email so the admin edits a real starting point rather than a blank slate.

Two components: a small **backend seeding** addition (default block documents served through the existing `GET`, **no contract change**) and the **admin editor UI** (a list screen + a focused editor page).

## Approach chosen (from brainstorming)

- **List → focused editor page** (two routes), not a two-pane live-preview layout.
- **Seed the editor from the current email** expressed as blocks (the richest first-author experience).
- **On-demand** preview (a `Preview` button → one `/preview` call), not debounced-live.
- **Up/down** block reorder (no drag-and-drop dependency) for v1.
- **`en`-only** — the API is locale-aware but `en` is the only shipped locale ([[email-template-i18n]] Phase 3 is parked).

## Component A — Backend default seeding (no OpenAPI change)

The Phase-2a `GET /admin/email/templates/:tag/:locale` returns draft ▸ published ▸ **empty starter** (`{subject:'', blocks:[]}`) when there is no override. Phase 2b changes the fallback from _empty_ to a per-tag **default** so the editor seeds.

- **`DEFAULT_TEMPLATE_BLOCKS: Record<EditableTag, EmailBlockDocument>`** — a new backend constant, each of the 6 editable emails hand-authored as an `EmailBlockDocument` (subject + `heading`/`paragraph`/`stat-row`/`button`/`divider`/`spacer`) that **faithfully approximates today's code email's content and structure**. Authored by reading each current template in `apps/backend/src/modules/email/templates/` and `presentation/`. It is a _starting point_, explicitly **not byte-identical** to the code render (the block renderer differs from the code templates), and only uses whitelisted `{vars}`.
- **`GET` change:** when there is no `draft` and no `published` row, return the tag's `DEFAULT_TEMPLATE_BLOCKS[tag]` (`subject` + `blocks`) with `status: 'none'`, `version: 0`, and the same `whitelist`. Draft ▸ published ▸ **default**. The DTO shape is unchanged (`subject: string`, `blocks: EmailBlockDto[]`, `status`, `version`, `whitelist`) — **so the generated client, OpenAPI, and Postman are untouched.**
- **Validation guarantee:** a unit test asserts every `DEFAULT_TEMPLATE_BLOCKS[tag]` passes `validateBlockDocument(tag, doc)` against that tag's whitelist — so a seed is always a valid doc the admin can save/preview/publish, and the defaults can't drift off the whitelist.
- The service's `status:'none'` semantics are unchanged (no override is live; the code template still renders until the admin publishes). Only the _content_ returned for the editor to seed from changes.
- **Updates an existing test:** the Phase-2a service test that asserted `GET` returns the empty starter (`{subject:'', blocks:[]}`) when no override is **updated** to assert it now returns the tag's seeded default (still `status:'none'`, `version:0`) — not a new test alongside the old one.

## Component B — Frontend: templates list screen

- **File:** `apps/admin/src/screens/EmailTemplatesScreen.tsx` (+ `.test.tsx`).
- **Route:** add `{ key: "email-templates", label: "Email Templates", minRole: "support" }` to `apps/admin/src/app/routes.ts`, beside `email` (Email Log). Register the screen in the app shell (`App.tsx`) the same way the other screens are.
- **Content:** a `DataTable` (from `@tarmoto/ui`) of the 6 editable tags. Columns: **Template** (human label), **Status** (a `Pill`: `Live` when a published override exists, `Draft` when a draft exists, `Default` when neither), and a **⚠ Legal-sensitive** `Pill`/badge on the two `account-deletion-*` tags. A row click navigates to the editor at `#/email-templates/:tag/en`.
- Data from `useEmailTemplates()` (the list endpoint returns `hasDraft`/`hasPublished`/`legalSensitive` per tag). Loading/error via the existing `Alert` pattern.

## Component C — Frontend: the editor page

- **File:** `apps/admin/src/screens/EmailTemplateEditor.tsx` (+ `.test.tsx`), plus small block-editor subcomponents under `apps/admin/src/components/email-template/` (e.g. `BlockCard.tsx`, `VarChips.tsx`, `PreviewPane.tsx`) so no single file grows unwieldy.
- **Routing:** the editor is shown for a hash like `#/email-templates/:tag/:locale`. Extend the hash-route parsing minimally to carry the `(tag, locale)` params (the current `useHashRoute` only handles flat keys; the editor reads `tag`/`locale` from the hash segment).
- **Header:** template label + a status `Pill` (Live/Draft/Default) + `version`; a "← Templates" back link.
- **Subject:** a `@tarmoto/ui` `Input`. Below it, the tag's whitelisted `{textVars}` render as clickable `VarChips` that insert `{var}` at the caret.
- **Blocks:** a vertical list of `BlockCard`s in document order. Each card renders **type-specific fields** and `[↑] [↓] [✕]` controls (up/down reorder + remove). A `+ Add block ▾` menu appends a new block of the chosen type:
  - `heading` / `paragraph` → a text field (+ `VarChips`).
  - `stat-row` → `label` + `value` text fields (+ `VarChips`).
  - `button` → a `label` field + a `urlVar` **`Select`** populated from the tag's `whitelist.urlVars` (whitelist-only — never a free-typed URL).
  - `divider` / `spacer` → no fields (a labelled placeholder card).
- **Preview (on-demand):** a `Preview` button calls `POST …/preview` with the current `{subject, blocks}`. On success, render the returned `subject` line + the `html` inside a **sandboxed `<iframe srcdoc={html} sandbox>`** (isolates the email markup), with a **Text / HTML** toggle (`text` vs `html`). On a `400`, map the field-level errors to inline messages on the offending subject/block.
- **Actions:**
  - `Save draft` (**support+**) → `PUT …/draft` → "Draft saved." On `400`, inline field errors.
  - `Send test to me` → `POST …/test-send` → a `sent`/`failed` `Alert`.
  - `Publish` and `Reset` are **rendered only when `useAdminAuth().role` is `super_admin`** (hidden, not merely disabled, for lower roles). Each opens a confirm `Dialog`. The **deletion-notice** tags (`legalSensitive`) show an extra GDPR-wording caution in the publish confirm. `Publish` → `POST …/publish`; `Reset` → `DELETE …/override` → "Override removed; the code email renders again."
- **Unsaved-changes guard:** track a dirty flag (edits since the last load/save). Warn before navigating away from the editor with unsaved changes (a confirm on the back link + `beforeunload`).

## Component D — Data hooks & error handling

- **File:** `apps/admin/src/data/useAdminEmailTemplates.ts` — 7 `$api` hooks mirroring `useAdminEmail.ts`:
  - `useEmailTemplates()` → `useQuery("get", "/admin/email/templates")`
  - `useEmailTemplate(tag, locale)` → `useQuery("get", "/admin/email/templates/{tag}/{locale}", {params:{path:{tag,locale}}})`
  - `useSaveDraft()` → `useMutation("put", "/admin/email/templates/{tag}/{locale}/draft")`
  - `usePreview()` → `useMutation("post", ".../preview")`
  - `useTestSend()` → `useMutation("post", ".../test-send")`
  - `usePublish()` → `useMutation("post", ".../publish")`
  - `useReset()` → `useMutation("delete", ".../override")`
- Types come from `components["schemas"]["EmailTemplateDetailDto" | "EmailTemplateSummaryDto" | "EmailBlockDto" | ...]` in `@tarmoto/openapi-client`.
- Reuse the existing `serverMessage(err, fallback)` helper + `Alert`/inline-message pattern. After a successful save/publish/reset, invalidate/`refetch` the list + detail queries so status pills update.

## Non-Goals (Phase 2b)

- **No drag-and-drop reorder** — up/down buttons (revisit if authors ask).
- **No live/debounced preview** — on-demand only.
- **No non-`en` locale UI** — the routes carry `:locale` (future-proof) but v1 only exercises `en`.
- **No new block types, no raw-HTML block, no free-typed URLs** — unchanged from Phase 1/2a.
- **No versioning/history/revert UI** — Phase 3.
- **No rich-text/WYSIWYG** inside a block — blocks are plain text + `{vars}`; the renderer owns the markup.
- **No editing the locked templates** (`verification`/`password-reset`/`trip-invite`/`password-changed`) — they never appear in the list (the list endpoint only returns the 6 editable tags).

## Testing

- **Backend:** `DEFAULT_TEMPLATE_BLOCKS` — every default validates against its tag's whitelist; `GET` returns the default (seeded, `status:'none'`) when no override, the draft when a draft exists, the published when only a published exists.
- **List screen:** renders the 6 tags with the right status pill; the legal-sensitive badge on the deletion notices; a row navigates to the editor.
- **Editor:** add a block via the menu; reorder with up/down; remove a block; insert a `{var}` via a chip; `button` `urlVar` select is limited to the whitelist; `Preview` renders the returned html/subject and a `400` surfaces inline; `Save draft` calls `PUT …/draft`; **`Publish`/`Reset` are absent for a non-`super_admin` role and present + confirm-gated for `super_admin`**; the deletion-notice publish confirm shows the caution; the dirty guard fires on leave-with-unsaved-changes.
- Follow the existing admin test pattern (`*.test.tsx`, the same harness as `EmailScreen`/`UsersScreen`).

## Risks

- **Default docs drift from the code emails.** They approximate, not mirror, the current templates; if a code template's copy changes later, its default is stale. Mitigation: the defaults are a _starting point_ (the admin edits before publishing) and the validate-against-whitelist test keeps them structurally valid. A future improvement is generating defaults from the templates, out of scope here.
- **Hash-route params.** The current `useHashRoute` is flat-key only; the editor needs `(tag, locale)` from the hash. Keep the parsing change minimal and covered by a test so the nav/back behavior stays correct.
- **Role gating is UI-only convenience.** Hiding `Publish`/`Reset` for non-`super_admin` is UX; the backend `@AdminRoles('super_admin')` remains the real gate (a lower-role user calling the endpoint directly still gets 403).
- **iframe preview.** The email html is rendered in a sandboxed iframe; keep `sandbox` on so template markup can't script the admin app. (The html is already escaped by `renderBlocks`, so this is defense-in-depth.)
