# Admin Email-Template Editor — Phase 3: Version History + Revert (Design)

**Status:** Approved (design)
**Date:** 2026-07-15
**Builds on:** Phase 1 (#984, entity + migration), Phase 2a (#988, backend API), Phase 2b (#994, admin UI)

## Goal

Give super_admins an auditable version history of published email-template
overrides — who published what content and when — and the ability to roll
back to any prior published version. Fold in the deferred `saveDraft`
duplicate-insert race fix. **No database migration** and **no new entity**:
the `email_template` schema was built in Phase 1 with the columns this phase
needs (`version`, `created_by`, `published_at`).

## Architecture

Version history is stored **in the existing `email_template` table** by
introducing a third `status` value, `archived`. Publishing no longer
`DELETE`s the outgoing published row — it flips that row to `archived` and
promotes the draft into a new `published` row. History for a `(template_tag,
locale)` is therefore every `archived` row plus the single live `published`
row, ordered by `version` descending. Revert re-publishes a chosen prior
version's content as a brand-new version (audited to the acting admin),
leaving the original row in place as history.

The choice is deliberate: `status` is a free `varchar(16)` with no CHECK
constraint, and the partial unique index `uq_email_template_published`
constrains only `status = 'published'`, so unlimited `archived` rows coexist
without a schema change. The existing `list()` and `get()` read paths query
only `draft`/`published` and are unaffected.

Rejected alternatives:

- **Separate `email_template_version` history table** — requires a migration
  (contradicts the Phase-1 no-migration design intent), duplicates every
  content column, and splits the publish write across two tables.
- **jsonb `versions[]` array on the published row** — unbounded single-row
  growth, clumsy to attribute and query per version, and revert would rewrite
  the entire blob.

## Tech Stack

- Backend: NestJS 11, TypeORM, PostgreSQL 16. Reuses the existing
  `AdminEmailTemplateService`, `EmailTemplate` entity, `validateBlockDocument`,
  and the `lockTemplate` advisory-lock helper.
- Contract: `@tarmoto/openapi-client` (generated). Phase 3 **adds endpoints and
  a DTO**, so it regenerates the client — unlike Phase 2b, which was contract-
  free.
- Admin: Vite SPA (`apps/admin`), `openapi-react-query` `$api`,
  `useAdminEmailTemplates` hooks, `@tarmoto/ui`, Vitest + Testing Library.

## Global Constraints

- **No DB migration.** All storage rides the existing `email_template`
  columns and the existing partial unique index. Do NOT add a migration.
- **Contract change → regenerate.** New endpoints + `EmailTemplateVersionDto`
  mean `pnpm openapi:gen` and `pnpm postman:gen` must run and their output be
  committed. (Contrast Phase 2b, which was contract-free.)
- **Roles:** viewing history is `support`; revert is `super_admin`. Matches
  the existing read=support / privileged-write=super_admin split.
- **Reuse `lockTemplate`.** Every publish-lifecycle mutation (publish, revert,
  and now saveDraft) serializes on the same `(tag, locale)` advisory lock in a
  single transaction. Do NOT introduce a second locking mechanism.
- **Never trust client content on revert.** The server re-reads the target
  version from the DB and re-validates it before it can go live.
- Conventional commits, scope required (`backend`, `admin`, or `cross`),
  lowercase subject.
- Backend stores metric units only (not relevant here — no units involved).

## Data Model (no change to DDL)

`email_template` columns already present and how Phase 3 uses them:

| Column         | Phase 3 use                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`       | now `'draft' \| 'published' \| 'archived'`. `archived` = a superseded published version (history).                                                              |
| `version`      | monotonic per `(tag, locale)` over `published`+`archived` rows. See numbering below.                                                                            |
| `created_by`   | the admin who **published** this version (uuid → `admin_users.id`). Now actually populated (was always null). `null` = seed/system row → displayed as "System". |
| `published_at` | when this version went live.                                                                                                                                    |

Invariants:

- At most one `published` row per `(tag, locale)` (unchanged; partial unique
  index enforces it).
- Any number of `archived` rows per `(tag, locale)`.
- `draft` rows remain unconstrained scratch copies; a draft carries no
  meaningful version (its `version` column is overwritten on publish).

### Version numbering (bug fix)

Next published version = `COALESCE(MAX(version) among published+archived rows
for (tag, locale), 0) + 1`.

This replaces the current `(priorPublished?.version ?? draft.version) + 1`,
which has a latent collision bug: after a `reset` deletes the published row,
`priorPublished` is null, so the next publish recomputes from the fresh
draft's default (`1`) and can **reuse a version number that an archived row
already holds**. Taking `MAX` over all published+archived rows is collision-
free and monotonic regardless of reset history. First-ever publish → version
`1`.

## Backend Changes

### `AdminEmailTemplateService`

Thread the acting admin's id (`req.adminUser.id`) into the mutating methods.

**`publish(tag, locale, actorId)`** (modified):
Inside the existing transaction + `lockTemplate`:

1. Load + `FOR UPDATE`-lock the draft (unchanged).
2. Re-validate the draft (unchanged safety gate).
3. Compute `nextVersion` = `MAX(version)` over `published`+`archived` rows `+ 1`.
4. **Archive the current published row first** (`UPDATE ... SET status =
'archived' WHERE (tag, locale, status='published')`) — before promoting the
   draft, because the partial unique index is checked per statement and two
   momentary `published` rows would violate it.
5. Promote the draft: `status='published'`, `version=nextVersion`,
   `created_by=actorId`, `published_at=now`.

Note: `created_by` is set to the **publisher** (not the draft's saver). The
history is a record of published versions, so the meaningful actor is who made
it live.

**`saveDraft(tag, locale, dto, actorId)`** (modified — folds in the race fix):
Wrap the update-or-insert in `dataSource.transaction` + `lockTemplate(tag,
locale)`. Two concurrent first-saves for the same `(tag, locale)` now
serialize: the second observes the first's draft and `UPDATE`s it instead of
inserting a duplicate. Set `created_by = actorId` on the insert branch. The
existing "targeted UPDATE ... WHERE status='draft', else INSERT" logic is
retained verbatim inside the lock.

**`reset(tag, locale)`** (behavior unchanged, semantics clarified):
Still deletes only the live `published` row under the lock. Archived history
is **preserved** — so a super_admin can still revert to a prior version after
a reset. Add a test asserting archived rows survive a reset.

**`history(tag, locale): EmailTemplateVersionDto[]`** (new):
Query rows where `status IN ('published','archived')` for `(tag, locale)`,
ordered by `version` DESC. Resolve authors with **one batched lookup**:
collect the distinct non-null `created_by` ids, `admin_users.find({ id In(...)
})`, build an `id → email` map, and map each row. `created_by = null` →
`author = null` (UI renders "System"). Returns per version: `version`,
`status`, `author` (email | null), `publishedAt`, `subject`, `blocks`.
Content is included so the admin's existing `PreviewPane` can render any
version locally without a third endpoint.

**`revert(tag, locale, version, actorId): EmailTemplateDetailDto`** (new):
Inside `dataSource.transaction` + `lockTemplate`:

1. Load the target row by `(tag, locale, version)` with `status IN
('published','archived')`. Not found → `NotFoundException`.
2. Re-validate its content with `validateBlockDocument` (same gate as publish —
   a since-tightened rule must not go live). Invalid → `BadRequestException`.
3. Compute `nextVersion` = `MAX(version) + 1` (as in publish).
4. Archive the current published row (if any), then insert a **new**
   `published` row with the target's `subject`/`blocks`, `version=nextVersion`,
   `created_by=actorId`, `published_at=now`. The target row stays as history.
5. An existing draft is left untouched.

`assertEditable`, `toDetail`, `validateAndRender`, `lockTemplate` are reused
unchanged.

### Controller

New handlers on `AdminEmailTemplateController` (`/admin/email/templates`):

- `GET :tag/:locale/history` — `@AdminRoles('support')` → `history(...)`.
- `POST :tag/:locale/history/:version/revert` — `@AdminRoles('super_admin')`;
  parse `:version` to an int (400 on non-numeric); pass `req.adminUser.id`;
  `setAdminAuditTarget(req, { target_type: 'email', target_id:
'`tag`/`locale`' })` as the other mutations do → `revert(...)`.

`publish` and `saveDraft` handlers pass `req.adminUser.id` into the service.

### DTOs

New in `dto/admin-email-template.dto.ts`:

```ts
export class EmailTemplateVersionDto {
  @ApiProperty() version!: number;
  @ApiProperty({ enum: ["published", "archived"] })
  status!: "published" | "archived";
  // Always present in the response, value may be null → ApiProperty + nullable
  // (not ApiPropertyOptional), so the generated client types it `string | null`
  // rather than an optional `string | null | undefined`.
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Publisher email; null = system/seed.",
  })
  author!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "ISO timestamp the version went live; null if never.",
  })
  publishedAt!: string | null;
  @ApiProperty() subject!: string;
  @ApiProperty({ type: [EmailBlockDto] })
  blocks!: EmailBlockDto[];
}
```

`EmailTemplateDetailDto` is **unchanged** — audit metadata lives in the
history endpoint, keeping the editable-document DTO clean and giving one
source of audit truth.

## Admin UI

### Hooks — `useAdminEmailTemplates`

- `useTemplateHistory(tag, locale)` — `$api.useQuery('get',
'/admin/email/templates/{tag}/{locale}/history')`, enabled when the editor
  is open.
- `useRevertVersion()` — `$api.useMutation('post',
'/admin/email/templates/{tag}/{locale}/history/{version}/revert')`;
  `onSuccess` invalidates this template's detail + history queries and the
  template list query (so the list's Live/Draft pills refresh).

### `EmailTemplateEditor`

- A **"History" button** in the editor header opens a **History drawer**
  (slide-over).
- Drawer lists versions from `useTemplateHistory`: `v{version}` · a
  `Live`/`Archived` pill · author email (or "System") · formatted
  `publishedAt`. The live version is marked and sorted first (version desc).
- Each row: **Preview** — loads that version's `subject`/`blocks` into the
  existing `PreviewPane` (reuses the Phase-2b sandboxed iframe render path).
- Each row, **super_admin only**: **Revert to this version** — a confirm
  dialog (naming the version), then `useRevertVersion`. On success the drawer
  and editor refetch; a toast/inline note confirms the new live version.
- Role gating reuses the Phase-2b `canAccess`/role check that already hides
  publish/reset for `support`. `support` sees history + preview, never the
  revert action.
- The confirm dialog's Cancel is disabled while the revert mutation is
  pending (matches the Phase-2b publish/reset dialogs).

## Data Flow

1. Admin opens the editor → detail loads (unchanged) → clicks **History**.
2. `GET …/history` returns versions (newest first) with resolved authors.
3. Admin clicks **Preview** on a version → its content renders in
   `PreviewPane` locally (no network beyond the existing preview render).
4. super_admin clicks **Revert** → confirm → `POST …/history/{version}/revert`.
5. Server (locked txn): re-reads + re-validates version N, archives current
   published, inserts new published version N+max. Returns the new detail.
6. Client invalidates detail + history + list → UI shows the new live version
   and the just-archived one in history.

## Error Handling

- Revert of an unknown `(tag, locale, version)` → `404`.
- Revert of a version whose stored content fails current validation → `400`
  with the validation errors (rare; only if rules tightened since it was
  authored).
- Non-numeric `:version` → `400`.
- `support` attempting revert → `403` (guard), and the UI never renders the
  action for them.
- Concurrent publish/revert/reset for one `(tag, locale)` serialize on the
  advisory lock; concurrent saveDraft first-saves serialize likewise.

## Testing

Backend (`admin-email-template.service.spec.ts`,
`admin-email-template.controller.spec.ts`):

- publish **archives** the prior published row (does not delete it) and the
  archived row keeps its version + author + `published_at`.
- version numbering is `MAX+1`, including **no collision after a reset**
  (reset published v3-of-{v1,v2,v3-archived}, next publish → v4, not v-reused).
- `history` returns published+archived ordered version desc, author resolved
  to email, `created_by=null` → `author=null`, batched (no N+1).
- `revert` re-publishes the target's content as a new version, archives the
  current published, is atomic under the lock, and re-validates (rejects
  invalid stored content).
- `revert` unknown version → 404.
- `reset` preserves archived history.
- saveDraft race: two concurrent first-saves → exactly one draft row.
- role gating: history=support 200, revert=support 403 / super_admin 200.

Admin (`EmailTemplateEditor.test.tsx`, `useAdminEmailTemplates` /
history-drawer tests):

- drawer renders versions with Live badge, author, date.
- Preview loads a selected version into `PreviewPane`.
- Revert: confirm → mutation fires with the right version → refetch/invalidate.
- role-gate: revert action hidden for `support`, shown for `super_admin`.
- dialog Cancel disabled while revert is pending.

## Out of Scope (deliberate)

- **Explicit "revert-of-vN" provenance label** — would need a new column
  (violates no-migration). A reverted version's content matches the version it
  came from; the audit trail (who/when/what-content) is intact without the
  linkage label. Revisit only if product asks and accepts a migration.
- **History retention cap** — email templates publish rarely; lifetime archived
  rows per tag are a handful. No pruning needed (YAGNI).
- **Draft author display** — drafts are transient; only published versions are
  audited.
- **Diff view between versions** — preview-per-version covers the need; a
  side-by-side diff is a later enhancement.
