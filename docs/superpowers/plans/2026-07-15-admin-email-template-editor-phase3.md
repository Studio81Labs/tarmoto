# Admin Email-Template Editor — Phase 3 (Version History + Revert) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give super_admins an auditable version history of published email-template overrides and a one-click revert to any prior version, and close the deferred `saveDraft` duplicate-insert race — all on the existing `email_template` columns, no migration.

**Architecture:** Publish stops `DELETE`-ing the outgoing published row; it flips it to a third `status='archived'` and promotes the draft into a new `published` row with a monotonic `MAX(version)+1`. History = the archived + live rows for a `(tag, locale)`. Revert re-publishes a chosen prior version's DB-re-read, re-validated content as a new version. The admin editor gains a slide-over History drawer. `saveDraft` moves its update-or-insert under the existing `lockTemplate` advisory lock.

**Tech Stack:** NestJS 11 + TypeORM + PostgreSQL (backend), `@tarmoto/openapi-client` (generated contract), Vite + React + `openapi-react-query` + `@tarmoto/ui` + Vitest/Testing Library (admin).

## Global Constraints

- **No DB migration.** All storage rides the existing `email_template` columns and the existing partial unique index `uq_email_template_published` (constrains only `status='published'`). Do NOT add a migration.
- **Contract change → regenerate.** New endpoints + `EmailTemplateVersionDto` require `pnpm openapi:gen` and `pnpm postman:gen`; commit their output (Task 5).
- **Roles:** history view = `@AdminRoles('support')`; revert = `@AdminRoles('super_admin')`.
- **Reuse `lockTemplate`.** Publish, revert, and now saveDraft serialize on the same `(tag, locale)` advisory lock inside a single `dataSource.transaction`. Do NOT add a second locking mechanism.
- **Never trust client content on revert.** The server re-reads the target version from the DB and re-validates it with `validateBlockDocument` before it can go live.
- **`created_by` = the publisher** (`req.adminUser?.id ?? null`), resolved to `admin_users.email` in history; `null` → "System".
- Conventional commits, scope required (`backend`, `admin`, `openapi`, or `cross`), lowercase subject; commit bodies end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Backend stores metric units only (not relevant here).

---

## File Structure

**Backend** (`apps/backend/src/modules/admin-email/`)

- `admin-email-template.service.ts` — MODIFY: `publish` (archive-in-place + `nextVersion` + record publisher), `saveDraft` (txn+lock + record author), new `history` + `revert` + private `nextVersion`; import `AdminUser`.
- `admin-email-template.controller.ts` — MODIFY: thread `req.adminUser?.id` into `publish`/`saveDraft`; add `history` (support) + `revert` (super_admin) handlers.
- `dto/admin-email-template.dto.ts` — MODIFY: add `EmailTemplateVersionDto`.
- `admin-email-template.service.spec.ts` — MODIFY existing publish/saveDraft tests; add history/revert/race/reset-preserves tests. Extend the `make()` `manager` mock with `update`, `create`; add `templates.manager.find`.
- `admin-email-template.controller.spec.ts` — MODIFY publish-forward test; add history/revert role + forwarding tests; extend `adminReq()` with `id`.

**Contract** — regenerated `packages/openapi/`-driven `@tarmoto/openapi-client` output + Postman collection (Task 5).

**Admin** (`apps/admin/src/`)

- `data/useAdminEmailTemplates.ts` — MODIFY: add `useTemplateHistory`, `useRevertVersion`.
- `components/email-template/VersionHistoryDrawer.tsx` — CREATE.
- `components/email-template/VersionHistoryDrawer.test.tsx` — CREATE.
- `screens/EmailTemplateEditor.tsx` — MODIFY: History button + render drawer + `onReverted`.
- `screens/EmailTemplateEditor.test.tsx` — MODIFY: extend the hook mock; add a "History opens the drawer" test.

---

## Task 1: Backend — archive-in-place publish + monotonic versioning + record publisher

**Files:**

- Modify: `apps/backend/src/modules/admin-email/admin-email-template.service.ts`
- Modify: `apps/backend/src/modules/admin-email/admin-email-template.controller.ts`
- Test: `apps/backend/src/modules/admin-email/admin-email-template.service.spec.ts`
- Test: `apps/backend/src/modules/admin-email/admin-email-template.controller.spec.ts`

**Interfaces:**

- Produces: `publish(tag: string, locale: SupportedLocale, actorId?: string | null): Promise<EmailTemplateDetailDto>` — actorId optional (defaults `null`) so callers that don't have an actor still compile; the controller passes `req.adminUser?.id ?? null`.
- Produces (private): `nextVersion(m: EntityManager, tag: string, locale: SupportedLocale): Promise<number>` — `MAX(version)+1` over `published`+`archived` rows; reused by Task 4.

- [ ] **Step 1: Update the `make()` manager mock (test infra)**

In `admin-email-template.service.spec.ts`, extend the `manager` object inside `make()` so the transaction manager can archive + create rows:

```ts
const manager = {
  findOne: jest.fn(),
  delete: jest.fn(),
  update: jest.fn(() => Promise.resolve({ affected: 1 })),
  create: jest.fn(
    (_entity: unknown, partial: Partial<EmailTemplate>) =>
      partial as EmailTemplate,
  ),
  save: jest.fn((row: EmailTemplate) => Promise.resolve(row)),
  query: jest.fn(),
};
```

- [ ] **Step 2: Rewrite the two publish behavior tests + add version/publisher assertions**

Replace the existing `publish deletes the prior published row before promoting the draft` and `publish continues the version from the prior published row, not the draft default` tests with the Phase-3 behavior. `nextVersion` reads the highest published/archived row via a `findOne` ordered `version DESC`; the current published row is archived via `manager.update` before the promote `save`.

```ts
it("publish archives the prior published row before promoting the draft, and records the publisher", async () => {
  const { service, manager } = make();
  const draftRow = {
    template_tag: "weekly-digest",
    locale: "en",
    status: "draft",
    version: 1,
    subject: "x",
    blocks: [],
  };
  // findOne is called for: the draft (status 'draft'), and the top
  // published/archived row for nextVersion (order.version 'DESC').
  manager.findOne.mockImplementation(
    (
      _entity: unknown,
      opts: { where: { status: unknown }; order?: { version?: string } },
    ) => {
      if (opts.where.status === "draft") return Promise.resolve(draftRow);
      if (opts.order?.version === "DESC") return Promise.resolve(null); // first publish
      return Promise.resolve(null);
    },
  );

  const result = await service.publish("weekly-digest", "en", "admin-1");

  // Archive-old must run before promote-save, or the partial unique index
  // (<=1 published per tag/locale) rejects the promote.
  expect(manager.update).toHaveBeenCalledWith(
    expect.anything(),
    { template_tag: "weekly-digest", locale: "en", status: "published" },
    { status: "archived" },
  );
  expect(manager.update.mock.invocationCallOrder[0]!).toBeLessThan(
    manager.save.mock.invocationCallOrder[0]!,
  );
  // First-ever publish (no published/archived) → version 1.
  expect(manager.save).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "published",
      version: 1,
      created_by: "admin-1",
    }),
  );
  expect(result.status).toBe("published");
  expect(result.version).toBe(1);
  // Draft read FOR UPDATE + the (tag, locale) advisory lock still hold.
  expect(manager.findOne).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ lock: { mode: "pessimistic_write" } }),
  );
  expect(manager.query).toHaveBeenCalledWith(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    ["email_template:weekly-digest:en"],
  );
  // Never deletes — the prior version is retained as history.
  expect(manager.delete).not.toHaveBeenCalled();
});

it("publish numbers the new version at MAX(published+archived)+1", async () => {
  const { service, manager } = make();
  const draftRow = {
    template_tag: "weekly-digest",
    locale: "en",
    status: "draft",
    version: 1,
    subject: "x",
    blocks: [],
  };
  manager.findOne.mockImplementation(
    (
      _entity: unknown,
      opts: { where: { status: unknown }; order?: { version?: string } },
    ) => {
      if (opts.where.status === "draft") return Promise.resolve(draftRow);
      if (opts.order?.version === "DESC")
        return Promise.resolve({ version: 5 }); // highest existing
      return Promise.resolve(null);
    },
  );

  const result = await service.publish("weekly-digest", "en", "admin-1");

  expect(manager.save).toHaveBeenCalledWith(
    expect.objectContaining({ status: "published", version: 6 }),
  );
  expect(result.version).toBe(6);
});
```

Leave the `publish 404s when there is no draft to promote` and `publish 400s and mutates nothing when the stored draft is invalid` tests, but update the 400 test's final assertions from `manager.delete` to the pre-mutation guard (it already asserts `manager.save` not called; also assert `manager.update` not called):

```ts
expect(manager.update).not.toHaveBeenCalled();
expect(manager.save).not.toHaveBeenCalled();
```

- [ ] **Step 3: Run the publish tests — expect FAIL**

Run: `pnpm --filter @tarmoto/backend test -- admin-email-template.service.spec`
Expected: FAIL — current `publish` deletes (not archives), numbers first publish `2`, and ignores `actorId`.

- [ ] **Step 4: Widen the entity `status` union + tighten `list()`/`toDetail`**

`m.update(..., { status: 'archived' })` and other archived writes won't typecheck against a `'draft' | 'published'` union. Widen the column's TS type (a type-only change — the DB column is already a free `varchar(16)`, so NO migration).

In `apps/backend/src/entities/email-template.entity.ts`, change the `status` column type:

```ts
  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: 'draft' | 'published' | 'archived';
```

In `admin-email-template.service.ts` `list()`, restrict the scan to draft/published so accumulating archived history rows are never fetched (output is unchanged — archived rows were already excluded from both sets):

```ts
const rows = await this.templates.find({
  select: { template_tag: true, status: true },
  where: {
    template_tag: In([...EDITABLE_TAGS]),
    status: In(["draft", "published"]),
  },
});
```

In `toDetail`, the DTO only ever represents editable (draft/published) rows — narrow the widened status so it fits `EmailTemplateDetailDto.status` (`'draft' | 'published' | 'none'`):

```ts
return {
  tag,
  locale,
  subject: row.subject,
  blocks: row.blocks,
  // toDetail only ever receives a draft or published row (publish/revert
  // return the promoted row; get/saveDraft read draft-or-published), never
  // an archived one — narrow the widened column type to the DTO's set.
  status: row.status as "draft" | "published",
  version: row.version,
  whitelist,
};
```

- [ ] **Step 5: Implement archive-in-place publish + `nextVersion`**

In `admin-email-template.service.ts`, add the private helper and rewrite `publish`. `In` and `EntityManager` are already imported (line 7).

```ts
  /** Monotonic next version for (tag, locale): one past the highest existing
   *  published-or-archived version. Collision-free even after a reset (which
   *  deletes only the published row), because archived rows keep their
   *  numbers. First-ever publish → 1. */
  private async nextVersion(
    m: EntityManager,
    tag: string,
    locale: SupportedLocale,
  ): Promise<number> {
    const top = await m.findOne(EmailTemplate, {
      where: { template_tag: tag, locale, status: In(['published', 'archived']) },
      order: { version: 'DESC' },
    });
    return (top?.version ?? 0) + 1;
  }
```

Rewrite `publish` (replace the whole method):

```ts
  /**
   * Promotes the draft to published, atomically, keeping the prior published
   * row as history. The archive-old + promote-draft MUST run in one
   * transaction, and the archive MUST precede the promote, or the partial
   * unique index (<=1 published per (tag, locale)) rejects two momentary
   * published rows. `actorId` (the publishing admin) is recorded as the
   * version's author.
   */
  async publish(
    tag: string,
    locale: SupportedLocale,
    actorId: string | null = null,
  ): Promise<EmailTemplateDetailDto> {
    this.assertEditable(tag);
    const saved = await this.dataSource.transaction(async (m) => {
      await this.lockTemplate(m, tag, locale);
      const draft = await m.findOne(EmailTemplate, {
        where: { template_tag: tag, locale, status: 'draft' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!draft) {
        throw new NotFoundException(`No draft to publish for ${tag}/${locale}`);
      }
      const check = validateBlockDocument(tag, {
        subject: draft.subject,
        blocks: draft.blocks,
      });
      if (!check.ok) {
        throw new BadRequestException(check.errors);
      }
      const version = await this.nextVersion(m, tag, locale);
      // Archive the current published row (if any) BEFORE promoting the draft.
      await m.update(
        EmailTemplate,
        { template_tag: tag, locale, status: 'published' },
        { status: 'archived' },
      );
      draft.status = 'published';
      draft.version = version;
      draft.created_by = actorId;
      draft.published_at = new Date();
      return m.save(draft);
    });
    return this.toDetail(tag, locale, saved);
  }
```

- [ ] **Step 6: Thread the publisher id through the controller**

In `admin-email-template.controller.ts`, change the `publish` handler's service call:

```ts
return this.service.publish(tag, loc, req.adminUser?.id ?? null);
```

- [ ] **Step 7: Update the controller publish-forward test**

In `admin-email-template.controller.spec.ts`, update `adminReq()` to carry an id, and the publish test to assert it is forwarded:

```ts
const adminReq = () =>
  ({
    adminUser: { id: "admin-1", email: "admin@tarmoto.app" },
  }) as unknown as AdminRequest;
```

```ts
it("publish forwards (tag, locale, actorId) to the service", async () => {
  const req = adminReq();
  await controller.publish(req, "weekly-digest", "en");
  // eslint-disable-next-line @typescript-eslint/unbound-method
  expect(service.publish).toHaveBeenCalledWith(
    "weekly-digest",
    "en",
    "admin-1",
  );
});
```

- [ ] **Step 8: Run backend tests — expect PASS**

Run: `pnpm --filter @tarmoto/backend test -- admin-email-template`
Expected: PASS (service + controller specs).

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/entities/email-template.entity.ts apps/backend/src/modules/admin-email/admin-email-template.service.ts apps/backend/src/modules/admin-email/admin-email-template.controller.ts apps/backend/src/modules/admin-email/admin-email-template.service.spec.ts apps/backend/src/modules/admin-email/admin-email-template.controller.spec.ts
git commit -m "feat(backend): archive-in-place email-template publish with monotonic versioning"
```

---

## Task 2: Backend — serialize `saveDraft` to close the duplicate-draft race + record author

**Files:**

- Modify: `apps/backend/src/modules/admin-email/admin-email-template.service.ts`
- Modify: `apps/backend/src/modules/admin-email/admin-email-template.controller.ts`
- Test: `apps/backend/src/modules/admin-email/admin-email-template.service.spec.ts`

**Interfaces:**

- Produces: `saveDraft(tag, locale, dto: SaveDraftDto, actorId?: string | null): Promise<EmailTemplateDetailDto>` — the update-or-insert now runs inside `dataSource.transaction` under `lockTemplate`.

- [ ] **Step 1: Rewrite the two saveDraft tests for the transaction manager**

The update/insert moves from `this.templates.*` to the transaction `manager.*`. Replace the two existing saveDraft tests' assertions accordingly (the final read stays on `templates.findOne`):

```ts
it("saveDraft inserts a fresh draft under the lock when no draft row matches", async () => {
  const { service, templates, manager } = make();
  manager.update.mockResolvedValue({ affected: 0 });
  templates.findOne.mockResolvedValue({
    template_tag: "weekly-digest",
    locale: "en",
    status: "draft",
    version: 1,
    subject: "Hi {displayName}",
    blocks: [{ type: "paragraph", text: "You rode {distance}" }],
  });

  const result = await service.saveDraft(
    "weekly-digest",
    "en",
    {
      subject: "Hi {displayName}",
      blocks: [{ type: "paragraph", text: "You rode {distance}" }],
    },
    "admin-1",
  );

  // Serialized under the (tag, locale) advisory lock so two concurrent
  // first-saves can't both insert.
  expect(manager.query).toHaveBeenCalledWith(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    ["email_template:weekly-digest:en"],
  );
  expect(manager.update).toHaveBeenCalledWith(
    expect.anything(),
    { template_tag: "weekly-digest", locale: "en", status: "draft" },
    expect.objectContaining({ subject: "Hi {displayName}" }),
  );
  expect(manager.save).toHaveBeenCalledWith(
    expect.objectContaining({ status: "draft", created_by: "admin-1" }),
  );
  expect(result.status).toBe("draft");
});

it("saveDraft updates the draft via a status-scoped write, never rewriting a published row", async () => {
  const { service, templates, manager } = make();
  manager.update.mockResolvedValue({ affected: 1 });
  templates.findOne.mockResolvedValue({
    template_tag: "weekly-digest",
    locale: "en",
    status: "draft",
    version: 1,
    subject: "New {displayName}",
    blocks: [{ type: "heading", text: "{distance}" }],
  });

  const result = await service.saveDraft(
    "weekly-digest",
    "en",
    {
      subject: "New {displayName}",
      blocks: [{ type: "heading", text: "{distance}" }],
    },
    "admin-1",
  );

  expect(manager.update).toHaveBeenCalledWith(
    expect.anything(),
    { template_tag: "weekly-digest", locale: "en", status: "draft" },
    {
      subject: "New {displayName}",
      blocks: [{ type: "heading", text: "{distance}" }],
    },
  );
  // Matched a draft → no insert.
  expect(manager.create).not.toHaveBeenCalled();
  expect(manager.save).not.toHaveBeenCalled();
  expect(result.status).toBe("draft");
});
```

Keep the existing `saveDraft rejects an invalid doc (empty subject) with a 400` test as-is (it calls `service.saveDraft('weekly-digest', 'en', { subject: '', blocks: [] })` — the optional `actorId` default keeps it valid).

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @tarmoto/backend test -- admin-email-template.service.spec`
Expected: FAIL — current `saveDraft` writes via `this.templates`, not the locked transaction manager, and sets no `created_by`.

- [ ] **Step 3: Implement the locked saveDraft**

Replace `saveDraft` in `admin-email-template.service.ts`:

```ts
  /** Validates then upserts the single draft row for (tag, locale), serialized
   *  under the (tag, locale) advisory lock so two concurrent first-saves can't
   *  both insert a draft (there is no unique index on draft rows). `actorId` is
   *  recorded on a freshly inserted draft. */
  async saveDraft(
    tag: string,
    locale: SupportedLocale,
    dto: SaveDraftDto,
    actorId: string | null = null,
  ): Promise<EmailTemplateDetailDto> {
    this.assertEditable(tag);
    const result = validateBlockDocument(tag, dto);
    if (!result.ok) throw new BadRequestException(result.errors);

    await this.dataSource.transaction(async (m) => {
      await this.lockTemplate(m, tag, locale);
      // Targeted UPDATE ... WHERE status='draft' carrying only subject/blocks,
      // so a row a super_admin published between our read and write is never
      // reverted to draft; if nothing matched, insert a fresh draft.
      const updated = await m.update(
        EmailTemplate,
        { template_tag: tag, locale, status: 'draft' },
        { subject: result.doc.subject, blocks: result.doc.blocks },
      );
      if (!updated.affected) {
        await m.save(
          m.create(EmailTemplate, {
            template_tag: tag,
            locale,
            subject: result.doc.subject,
            blocks: result.doc.blocks,
            status: 'draft',
            created_by: actorId,
          }),
        );
      }
    });

    const row = await this.templates.findOne({
      where: { template_tag: tag, locale, status: 'draft' },
    });
    return this.toDetail(tag, locale, row);
  }
```

- [ ] **Step 4: Thread the author id through the controller**

In `admin-email-template.controller.ts`, change the `saveDraft` handler's service call (it already sets the audit target):

```ts
return this.service.saveDraft(tag, loc, dto, req.adminUser?.id ?? null);
```

- [ ] **Step 5: Run — expect PASS**

Run: `pnpm --filter @tarmoto/backend test -- admin-email-template`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/admin-email/admin-email-template.service.ts apps/backend/src/modules/admin-email/admin-email-template.controller.ts apps/backend/src/modules/admin-email/admin-email-template.service.spec.ts
git commit -m "fix(backend): serialize email-template saveDraft to close the duplicate-draft race"
```

---

## Task 3: Backend — version history endpoint + `EmailTemplateVersionDto` + author resolution

**Files:**

- Modify: `apps/backend/src/modules/admin-email/dto/admin-email-template.dto.ts`
- Modify: `apps/backend/src/modules/admin-email/admin-email-template.service.ts`
- Modify: `apps/backend/src/modules/admin-email/admin-email-template.controller.ts`
- Test: `apps/backend/src/modules/admin-email/admin-email-template.service.spec.ts`
- Test: `apps/backend/src/modules/admin-email/admin-email-template.controller.spec.ts`

**Interfaces:**

- Produces DTO `EmailTemplateVersionDto { version: number; status: 'published' | 'archived'; author: string | null; publishedAt: string | null; subject: string; blocks: EmailBlockDto[] }`.
- Produces: `history(tag: string, locale: SupportedLocale): Promise<EmailTemplateVersionDto[]>` — published+archived rows, version DESC, authors resolved from `admin_users` in one batched query.
- Controller: `GET :tag/:locale/history` `@AdminRoles('support')`.

- [ ] **Step 1: Add `EmailTemplateVersionDto`**

In `dto/admin-email-template.dto.ts` (after `EmailTemplateDetailDto`):

```ts
export class EmailTemplateVersionDto {
  @ApiProperty() version!: number;

  @ApiProperty({ enum: ["published", "archived"] })
  status!: "published" | "archived";

  // Always present in the response; value may be null (system/seed rows) →
  // ApiProperty + nullable so the generated client types it `string | null`,
  // not an optional `string | null | undefined`.
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

- [ ] **Step 2: Add the service history test**

In `admin-email-template.service.spec.ts`, first extend `make()`'s `templates` mock so author resolution (a non-transactional `this.templates.manager.find(AdminUser, ...)`) is mockable — add a `manager` to the `templates` object:

```ts
const templates = {
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn(
    (partial: Partial<EmailTemplate>) => partial as EmailTemplate,
  ),
  save: jest.fn((row: EmailTemplate) => Promise.resolve(row)),
  update: jest.fn(() => Promise.resolve({ affected: 1 })),
  delete: jest.fn(),
  manager: { find: jest.fn() },
};
```

Add the test:

```ts
it("history returns published+archived versions newest-first with authors resolved to email", async () => {
  const { service, templates } = make();
  templates.find.mockResolvedValue([
    {
      version: 3,
      status: "published",
      created_by: "admin-1",
      published_at: new Date("2026-07-10T00:00:00.000Z"),
      subject: "s3",
      blocks: [{ type: "paragraph", text: "v3" }],
    },
    {
      version: 2,
      status: "archived",
      created_by: null, // seed/system
      published_at: new Date("2026-07-01T00:00:00.000Z"),
      subject: "s2",
      blocks: [],
    },
  ]);
  (templates.manager.find as jest.Mock).mockResolvedValue([
    { id: "admin-1", email: "jane@tarmoto.app" },
  ]);

  const result = await service.history("weekly-digest", "en");

  // Read scoped to published+archived, ordered version DESC.
  expect(templates.find).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        template_tag: "weekly-digest",
        locale: "en",
      }),
      order: { version: "DESC" },
    }),
  );
  expect(result).toHaveLength(2);
  expect(result[0]).toEqual({
    version: 3,
    status: "published",
    author: "jane@tarmoto.app",
    publishedAt: "2026-07-10T00:00:00.000Z",
    subject: "s3",
    blocks: [{ type: "paragraph", text: "v3" }],
  });
  // Null author → null (UI renders "System"); one batched admin_users lookup.
  expect(result[1]!.author).toBeNull();
  expect(templates.manager.find).toHaveBeenCalledTimes(1);
});

it("history skips the admin_users lookup when no version has an author", async () => {
  const { service, templates } = make();
  templates.find.mockResolvedValue([
    {
      version: 1,
      status: "published",
      created_by: null,
      published_at: null,
      subject: "s1",
      blocks: [],
    },
  ]);

  const result = await service.history("weekly-digest", "en");

  expect(result[0]!.author).toBeNull();
  expect(result[0]!.publishedAt).toBeNull();
  expect(templates.manager.find).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run — expect FAIL**

Run: `pnpm --filter @tarmoto/backend test -- admin-email-template.service.spec`
Expected: FAIL — `service.history` is not defined.

- [ ] **Step 4: Implement `history`**

In `admin-email-template.service.ts`, add the `AdminUser` import at the top:

```ts
import { AdminUser } from "../../entities/admin-user.entity.js";
```

Add the import of the new DTO type (alongside the existing dto imports):

```ts
  EmailTemplateVersionDto,
```

(add to the `import type { ... } from './dto/admin-email-template.dto.js';` block)

Add the method (place after `reset`):

```ts
  /** Published + archived versions for (tag, locale), newest first, with each
   *  version's publisher resolved to an email in one batched admin_users
   *  lookup (no N+1). Content is included so the admin can preview any version. */
  async history(
    tag: string,
    locale: SupportedLocale,
  ): Promise<EmailTemplateVersionDto[]> {
    this.assertEditable(tag);
    const rows = await this.templates.find({
      where: { template_tag: tag, locale, status: In(['published', 'archived']) },
      order: { version: 'DESC' },
    });
    const ids = [
      ...new Set(
        rows.map((r) => r.created_by).filter((id): id is string => id != null),
      ),
    ];
    const emailById = new Map<string, string>();
    if (ids.length > 0) {
      const admins = await this.templates.manager.find(AdminUser, {
        where: { id: In(ids) },
        select: { id: true, email: true },
      });
      for (const a of admins) emailById.set(a.id, a.email);
    }
    return rows.map((r) => ({
      version: r.version,
      status: r.status as 'published' | 'archived',
      author: r.created_by ? (emailById.get(r.created_by) ?? null) : null,
      publishedAt: r.published_at ? r.published_at.toISOString() : null,
      subject: r.subject,
      blocks: r.blocks,
    }));
  }
```

- [ ] **Step 5: Add the controller history handler + role test**

In `admin-email-template.controller.ts`, import `EmailTemplateVersionDto` (add to the dto import block) and add the handler after `get`:

```ts
  @Get(':tag/:locale/history')
  @AdminRoles('support')
  @ApiOperation({
    summary: 'List published + archived versions of a template (newest first)',
  })
  @ApiResponse({ status: 200, type: [EmailTemplateVersionDto] })
  history(
    @Param('tag') tag: string,
    @Param('locale') locale: string,
  ): Promise<EmailTemplateVersionDto[]> {
    return this.service.history(tag, this.locale(locale));
  }
```

In `admin-email-template.controller.spec.ts`, add `history` to the `service` mock (`history: jest.fn().mockResolvedValue([])`), add `'history'` to the support-role `it.each` list, and add a forwarding test:

```ts
it("history forwards the narrowed locale to the service", async () => {
  await controller.history("weekly-digest", "en");
  // eslint-disable-next-line @typescript-eslint/unbound-method
  expect(service.history).toHaveBeenCalledWith("weekly-digest", "en");
});
```

- [ ] **Step 6: Run — expect PASS**

Run: `pnpm --filter @tarmoto/backend test -- admin-email-template`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/modules/admin-email/
git commit -m "feat(backend): email-template version history endpoint"
```

---

## Task 4: Backend — revert-to-version endpoint + reset-preserves-history test

**Files:**

- Modify: `apps/backend/src/modules/admin-email/admin-email-template.service.ts`
- Modify: `apps/backend/src/modules/admin-email/admin-email-template.controller.ts`
- Test: `apps/backend/src/modules/admin-email/admin-email-template.service.spec.ts`
- Test: `apps/backend/src/modules/admin-email/admin-email-template.controller.spec.ts`

**Interfaces:**

- Produces: `revert(tag: string, locale: SupportedLocale, version: number, actorId?: string | null): Promise<EmailTemplateDetailDto>` — re-reads + re-validates version N, archives the current published, inserts a new published version with N's content.
- Controller: `POST :tag/:locale/history/:version/revert` `@AdminRoles('super_admin')`.

- [ ] **Step 1: Add service revert tests**

```ts
it("revert re-publishes the target version content as a new version, archiving the current live one", async () => {
  const { service, manager } = make();
  const target = {
    template_tag: "weekly-digest",
    locale: "en",
    status: "archived",
    version: 2,
    subject: "old-good",
    blocks: [{ type: "paragraph", text: "restore me" }],
  };
  manager.findOne.mockImplementation(
    (
      _entity: unknown,
      opts: { where: { version?: number }; order?: { version?: string } },
    ) => {
      if (opts.where.version === 2) return Promise.resolve(target); // target lookup
      if (opts.order?.version === "DESC")
        return Promise.resolve({ version: 4 }); // highest existing
      return Promise.resolve(null);
    },
  );

  const result = await service.revert("weekly-digest", "en", 2, "admin-9");

  // Serialized under the advisory lock.
  expect(manager.query).toHaveBeenCalledWith(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    ["email_template:weekly-digest:en"],
  );
  // Archive current published before inserting the new one.
  expect(manager.update).toHaveBeenCalledWith(
    expect.anything(),
    { template_tag: "weekly-digest", locale: "en", status: "published" },
    { status: "archived" },
  );
  expect(manager.update.mock.invocationCallOrder[0]!).toBeLessThan(
    manager.save.mock.invocationCallOrder[0]!,
  );
  // New published version = MAX+1, target's content, acting admin as author.
  expect(manager.save).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "published",
      version: 5,
      subject: "old-good",
      created_by: "admin-9",
    }),
  );
  expect(result.status).toBe("published");
  expect(result.version).toBe(5);
});

it("revert 404s for an unknown version", async () => {
  const { service, manager } = make();
  manager.findOne.mockResolvedValue(null);
  await expect(
    service.revert("weekly-digest", "en", 99, "admin-9"),
  ).rejects.toBeInstanceOf(NotFoundException);
});

it("revert 400s and mutates nothing when the target content fails current validation", async () => {
  const { service, manager } = make();
  const badTarget = {
    template_tag: "weekly-digest",
    locale: "en",
    status: "archived",
    version: 2,
    subject: "Weekly\r\nBcc: evil@example.com",
    blocks: [],
  };
  manager.findOne.mockImplementation(
    (_entity: unknown, opts: { where: { version?: number } }) =>
      Promise.resolve(opts.where.version === 2 ? badTarget : null),
  );
  await expect(
    service.revert("weekly-digest", "en", 2, "admin-9"),
  ).rejects.toBeInstanceOf(BadRequestException);
  expect(manager.update).not.toHaveBeenCalled();
  expect(manager.save).not.toHaveBeenCalled();
});

it("reset deletes only the published row, preserving archived history", async () => {
  const { service, manager } = make();
  await service.reset("weekly-digest", "en");
  // Deletes the published row only — archived rows are untouched, so a
  // revert remains possible after a reset.
  expect(manager.delete).toHaveBeenCalledWith(expect.anything(), {
    template_tag: "weekly-digest",
    locale: "en",
    status: "published",
  });
  expect(manager.delete).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @tarmoto/backend test -- admin-email-template.service.spec`
Expected: FAIL — `service.revert` is not defined.

- [ ] **Step 3: Implement `revert`**

In `admin-email-template.service.ts`, add after `history`:

```ts
  /** Rolls back to a prior version by re-publishing its content as a NEW
   *  version (audited to the acting admin). The target content is re-read from
   *  the DB and re-validated — never trusted from the client — and the current
   *  published row is archived first (partial unique index). The original
   *  target row stays as history; an existing draft is left untouched. */
  async revert(
    tag: string,
    locale: SupportedLocale,
    version: number,
    actorId: string | null = null,
  ): Promise<EmailTemplateDetailDto> {
    this.assertEditable(tag);
    const saved = await this.dataSource.transaction(async (m) => {
      await this.lockTemplate(m, tag, locale);
      const target = await m.findOne(EmailTemplate, {
        where: {
          template_tag: tag,
          locale,
          version,
          status: In(['published', 'archived']),
        },
      });
      if (!target) {
        throw new NotFoundException(
          `No version ${version} for ${tag}/${locale}`,
        );
      }
      const check = validateBlockDocument(tag, {
        subject: target.subject,
        blocks: target.blocks,
      });
      if (!check.ok) {
        throw new BadRequestException(check.errors);
      }
      const next = await this.nextVersion(m, tag, locale);
      await m.update(
        EmailTemplate,
        { template_tag: tag, locale, status: 'published' },
        { status: 'archived' },
      );
      const row = m.create(EmailTemplate, {
        template_tag: tag,
        locale,
        subject: target.subject,
        blocks: target.blocks,
        status: 'published',
        version: next,
        created_by: actorId,
        published_at: new Date(),
      });
      return m.save(row);
    });
    return this.toDetail(tag, locale, saved);
  }
```

- [ ] **Step 4: Add the controller revert handler + role/forwarding tests**

In `admin-email-template.controller.ts`, add after `publish` (uses the existing `BadRequestException` import):

```ts
  @Post(':tag/:locale/history/:version/revert')
  @AdminRoles('super_admin')
  @ApiOperation({
    summary:
      'Revert to a prior version, re-publishing it as a new version (super admin only)',
  })
  @ApiResponse({ status: 201, type: EmailTemplateDetailDto })
  revert(
    @Req() req: AdminRequest,
    @Param('tag') tag: string,
    @Param('locale') locale: string,
    @Param('version') version: string,
  ): Promise<EmailTemplateDetailDto> {
    const loc = this.locale(locale);
    const v = Number(version);
    if (!Number.isInteger(v) || v < 1) {
      throw new BadRequestException(`Invalid version: ${version}`);
    }
    setAdminAuditTarget(req, {
      target_type: 'email',
      target_id: `${tag}/${loc}`,
    });
    return this.service.revert(tag, loc, v, req.adminUser?.id ?? null);
  }
```

In `admin-email-template.controller.spec.ts`, add `revert` to the `service` mock (`revert: jest.fn().mockResolvedValue({ tag: 'weekly-digest' })`), assert its role metadata, and add behavior tests:

```ts
it("requires super_admin on revert", () => {
  expect(
    Reflect.getMetadata(
      ADMIN_ROLES_KEY,
      // eslint-disable-next-line @typescript-eslint/unbound-method -- read for its metadata, never called unbound.
      AdminEmailTemplateController.prototype.revert,
    ),
  ).toEqual(["super_admin"]);
});
```

```ts
it("revert parses the version and forwards (tag, locale, version, actorId)", async () => {
  const req = adminReq();
  await controller.revert(req, "weekly-digest", "en", "3");
  // eslint-disable-next-line @typescript-eslint/unbound-method
  expect(service.revert).toHaveBeenCalledWith(
    "weekly-digest",
    "en",
    3,
    "admin-1",
  );
});

it("revert rejects a non-numeric version without calling the service", () => {
  const req = adminReq();
  expect(() => controller.revert(req, "weekly-digest", "en", "abc")).toThrow(
    BadRequestException,
  );
  // eslint-disable-next-line @typescript-eslint/unbound-method
  expect(service.revert).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: Run — expect PASS**

Run: `pnpm --filter @tarmoto/backend test -- admin-email-template`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/admin-email/
git commit -m "feat(backend): email-template revert-to-version endpoint"
```

---

## Task 5: Contract — regenerate the OpenAPI client + Postman collection

**Files:**

- Modify (generated): `@tarmoto/openapi-client` output + Postman collection under `packages/openapi/`.

**Interfaces:**

- Produces: `components["schemas"]["EmailTemplateVersionDto"]` and the two new paths in the generated client, consumed by Tasks 6–7.

- [ ] **Step 1: Regenerate the client**

Run from repo root: `pnpm openapi:gen`
Expected: builds shared + backend, emits the spec, regenerates the client. New `EmailTemplateVersionDto` and the `/history` + `/history/{version}/revert` paths appear in the generated output. (This step also strict-typechecks the backend via the OpenAPI build — a clean run confirms Tasks 1–4 compile under `noUncheckedIndexedAccess`.)

- [ ] **Step 2: Regenerate the Postman collection**

Run from repo root: `pnpm postman:gen`
Expected: the Postman collection gains the two new requests.

- [ ] **Step 3: Verify the new schema is present**

Run: `git status --porcelain packages/openapi` (expect modified generated files) and confirm the new DTO exists:
Run: `grep -rl "EmailTemplateVersionDto" packages/openapi`
Expected: at least one generated file matches.

- [ ] **Step 4: Commit the regenerated contract**

```bash
git add packages/openapi
git commit -m "chore(openapi): regenerate client + postman for email-template history/revert"
```

---

## Task 6: Admin — history hooks + `VersionHistoryDrawer` component

**Files:**

- Modify: `apps/admin/src/data/useAdminEmailTemplates.ts`
- Create: `apps/admin/src/components/email-template/VersionHistoryDrawer.tsx`
- Test: `apps/admin/src/components/email-template/VersionHistoryDrawer.test.tsx`

**Interfaces:**

- Consumes: `components["schemas"]["EmailTemplateVersionDto"]` (from Task 5); `PreviewPane({ tag, locale, subject, blocks })`; admin `Dialog`.
- Produces: `useTemplateHistory(tag: string, locale: string, enabled: boolean)`, `useRevertVersion()`; `VersionHistoryDrawer({ open, tag, locale, isSuper, onClose, onReverted })`.

- [ ] **Step 1: Add the hooks**

Append to `apps/admin/src/data/useAdminEmailTemplates.ts`:

```ts
export function useTemplateHistory(
  tag: string,
  locale: string,
  enabled: boolean,
) {
  return $api.useQuery(
    "get",
    "/admin/email/templates/{tag}/{locale}/history",
    { params: { path: { tag, locale } } },
    { enabled: enabled && tag.length > 0 },
  );
}

export function useRevertVersion() {
  return $api.useMutation(
    "post",
    "/admin/email/templates/{tag}/{locale}/history/{version}/revert",
  );
}
```

- [ ] **Step 2: Write the drawer test**

Create `apps/admin/src/components/email-template/VersionHistoryDrawer.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VersionHistoryDrawer } from "./VersionHistoryDrawer.js";

const revertMutate = vi.fn();
const historyRefetch = vi.fn();
const historyState = vi.hoisted(() => ({
  data: [
    {
      version: 3,
      status: "published",
      author: "jane@tarmoto.app",
      publishedAt: "2026-07-10T00:00:00.000Z",
      subject: "s3",
      blocks: [{ type: "paragraph", text: "v3" }],
    },
    {
      version: 2,
      status: "archived",
      author: null,
      publishedAt: "2026-07-01T00:00:00.000Z",
      subject: "s2",
      blocks: [],
    },
  ] as unknown,
}));

vi.mock("../../data/useAdminEmailTemplates.js", () => ({
  useTemplateHistory: () => ({
    data: historyState.data,
    isPending: false,
    refetch: historyRefetch,
  }),
  useRevertVersion: () => ({ mutate: revertMutate, isPending: false }),
  usePreview: () => ({ mutate: vi.fn(), isPending: false }),
}));

describe("VersionHistoryDrawer", () => {
  beforeEach(() => vi.clearAllMocks());

  const base = {
    open: true,
    tag: "weekly-digest",
    locale: "en",
    onClose: vi.fn(),
    onReverted: vi.fn(),
  };

  it("lists versions with a Live badge and resolved author, System for null", () => {
    render(<VersionHistoryDrawer {...base} isSuper={false} />);
    expect(screen.getByText(/v3/)).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("jane@tarmoto.app")).toBeInTheDocument();
    expect(screen.getByText(/v2/)).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
  });

  it("hides Revert for non-super, shows it for super", () => {
    const { rerender } = render(
      <VersionHistoryDrawer {...base} isSuper={false} />,
    );
    expect(screen.queryByRole("button", { name: /revert/i })).toBeNull();
    rerender(<VersionHistoryDrawer {...base} isSuper={true} />);
    expect(
      screen.getAllByRole("button", { name: /revert/i }).length,
    ).toBeGreaterThan(0);
  });

  it("revert asks for confirmation, then calls the mutation with the version", () => {
    render(<VersionHistoryDrawer {...base} isSuper={true} />);
    fireEvent.click(screen.getAllByRole("button", { name: /revert/i })[0]!);
    // Confirm dialog now open — click its confirm button.
    fireEvent.click(screen.getByRole("button", { name: /revert now/i }));
    expect(revertMutate).toHaveBeenCalledTimes(1);
    expect(revertMutate.mock.calls[0]![0]).toEqual({
      params: { path: { tag: "weekly-digest", locale: "en", version: 3 } },
    });
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <VersionHistoryDrawer {...base} open={false} isSuper={true} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

Run: `pnpm --filter @tarmoto/admin test -- VersionHistoryDrawer`
Expected: FAIL — the component does not exist.

- [ ] **Step 4: Implement `VersionHistoryDrawer`**

Create `apps/admin/src/components/email-template/VersionHistoryDrawer.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { components } from "@tarmoto/openapi-client";
import { Alert, Button, Pill } from "@tarmoto/ui";
import { Dialog } from "../Dialog.js";
import { PreviewPane } from "./PreviewPane.js";
import {
  useTemplateHistory,
  useRevertVersion,
} from "../../data/useAdminEmailTemplates.js";

type Version = components["schemas"]["EmailTemplateVersionDto"];

function serverMessage(err: unknown, fallback: string): string {
  const m = (err as { message?: string | string[] } | undefined)?.message;
  if (Array.isArray(m)) return m.join("; ");
  return m ?? fallback;
}

/**
 * Right-side slide-over listing a template's published + archived versions.
 * `support` can view and preview any version; `super_admin` can revert (re-
 * publish a prior version's content as a new version). The revert mutation and
 * its confirm live here; `onReverted` lets the parent editor refresh its
 * detail + the templates list.
 */
export function VersionHistoryDrawer({
  open,
  tag,
  locale,
  isSuper,
  onClose,
  onReverted,
}: {
  open: boolean;
  tag: string;
  locale: string;
  isSuper: boolean;
  onClose: () => void;
  onReverted: () => void;
}) {
  const history = useTemplateHistory(tag, locale, open);
  const revert = useRevertVersion();
  const [previewVersion, setPreviewVersion] = useState<number | null>(null);
  const [confirmVersion, setConfirmVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !revert.isPending) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, revert.isPending, onClose]);

  if (!open) return null;

  const versions = (history.data ?? []) as Version[];
  const preview = versions.find((v) => v.version === previewVersion) ?? null;

  function doRevert(version: number) {
    setError(null);
    revert.mutate(
      { params: { path: { tag, locale, version } } },
      {
        onSuccess: () => {
          setConfirmVersion(null);
          setPreviewVersion(null);
          void history.refetch();
          onReverted();
        },
        onError: (err: unknown) => {
          setConfirmVersion(null);
          setError(serverMessage(err, "Failed to revert."));
        },
      },
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Version history"
      className="fixed inset-0 z-40 flex justify-end bg-ink/40 backdrop-blur-sm"
      onClick={() => !revert.isPending && onClose()}
    >
      <div
        className="flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-line bg-cream shadow-[0_24px_60px_rgba(14,14,16,0.2)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-extrabold text-ink">Version history</h2>
          <button
            type="button"
            onClick={() => !revert.isPending && onClose()}
            aria-label="Close"
            disabled={revert.isPending}
            className="-mr-1 text-[22px] leading-none text-ink/40 transition hover:text-ink disabled:opacity-40"
          >
            ×
          </button>
        </div>

        <div className="flex flex-col gap-3 px-5 py-4">
          {error ? <Alert intent="danger" title={error} compact /> : null}
          {history.isPending ? (
            <p className="text-sm text-fg-dim">Loading…</p>
          ) : versions.length === 0 ? (
            <p className="text-sm text-fg-dim">No published versions yet.</p>
          ) : (
            versions.map((v) => (
              <div
                key={v.version}
                className="rounded-lg border border-line p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-ink">
                    v{v.version}
                  </span>
                  <Pill variant={v.status === "published" ? "accent" : "ghost"}>
                    {v.status === "published" ? "Live" : "Archived"}
                  </Pill>
                  <span className="ml-auto text-xs text-fg-dim">
                    {v.author ?? "System"}
                    {v.publishedAt
                      ? ` · ${new Date(v.publishedAt).toLocaleDateString()}`
                      : ""}
                  </span>
                </div>
                <div className="mt-2 flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setPreviewVersion((cur) =>
                        cur === v.version ? null : v.version,
                      )
                    }
                  >
                    {previewVersion === v.version ? "Hide preview" : "Preview"}
                  </Button>
                  {isSuper ? (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={revert.isPending}
                      onClick={() => setConfirmVersion(v.version)}
                    >
                      Revert
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          )}

          {preview ? (
            <PreviewPane
              key={preview.version}
              tag={tag}
              locale={locale}
              subject={preview.subject}
              blocks={preview.blocks}
            />
          ) : null}
        </div>
      </div>

      <Dialog
        open={confirmVersion !== null}
        title="Revert to this version?"
        onClose={() => setConfirmVersion(null)}
        busy={revert.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={revert.isPending}
              onClick={() => setConfirmVersion(null)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={revert.isPending}
              onClick={() =>
                confirmVersion !== null && doRevert(confirmVersion)
              }
            >
              Revert now
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">
          This re-publishes v{confirmVersion} as a new live version for{" "}
          <strong>{tag}</strong>. The current live version is kept in history.
        </p>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `pnpm --filter @tarmoto/admin test -- VersionHistoryDrawer`
Expected: PASS.

- [ ] **Step 6: Typecheck the admin app**

Run: `pnpm --filter @tarmoto/admin exec tsc --noEmit`
Expected: no errors (confirms the generated `EmailTemplateVersionDto` type + hook wiring line up).

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/data/useAdminEmailTemplates.ts apps/admin/src/components/email-template/VersionHistoryDrawer.tsx apps/admin/src/components/email-template/VersionHistoryDrawer.test.tsx
git commit -m "feat(admin): email-template version history drawer"
```

---

## Task 7: Admin — wire the History drawer into `EmailTemplateEditor`

**Files:**

- Modify: `apps/admin/src/screens/EmailTemplateEditor.tsx`
- Test: `apps/admin/src/screens/EmailTemplateEditor.test.tsx`

**Interfaces:**

- Consumes: `VersionHistoryDrawer` (Task 6), `useTemplateHistory`/`useRevertVersion` (mocked in the editor test).

- [ ] **Step 1: Extend the editor test hook mock + add a "History opens the drawer" test**

In `EmailTemplateEditor.test.tsx`, add the two new hooks to the `vi.mock("../data/useAdminEmailTemplates.js", ...)` factory so the imported drawer resolves them:

```ts
  useTemplateHistory: () => ({ data: [], isPending: false, refetch: vi.fn() }),
  useRevertVersion: () => ({ mutate: vi.fn(), isPending: false }),
```

Add a test inside `describe("EmailTemplateEditor", ...)`:

```ts
  it("opens the version history drawer from the History button", () => {
    render(<EmailTemplateEditor tag="weekly-digest" locale="en" onBack={vi.fn()} />);
    expect(screen.queryByText("Version history")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /history/i }));
    expect(screen.getByText("Version history")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @tarmoto/admin test -- EmailTemplateEditor`
Expected: FAIL — no History button; the drawer's hooks aren't in the mock (unmocked import would also error).

- [ ] **Step 3: Wire the drawer into the editor**

In `EmailTemplateEditor.tsx`:

Add the import:

```ts
import { VersionHistoryDrawer } from "../components/email-template/VersionHistoryDrawer.js";
```

Add drawer state alongside the other `useState` hooks:

```ts
const [historyOpen, setHistoryOpen] = useState(false);
```

Add a History button in the header row (after the `v{data.version}` span, before the closing `</div>` at line ~319):

```tsx
<Button
  variant="secondary"
  size="sm"
  className="ml-auto"
  onClick={() => setHistoryOpen(true)}
>
  History
</Button>
```

Render the drawer just before the closing `</section>` (after the two confirm `Dialog`s):

```tsx
<VersionHistoryDrawer
  open={historyOpen}
  tag={tag}
  locale={locale}
  isSuper={isSuper}
  onClose={() => setHistoryOpen(false)}
  onReverted={() => {
    setMsg({ kind: "success", text: "Reverted — this version is now live." });
    void refetch();
    invalidateList();
  }}
/>
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @tarmoto/admin test -- EmailTemplateEditor`
Expected: PASS.

- [ ] **Step 5: Typecheck the admin app**

Run: `pnpm --filter @tarmoto/admin exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/screens/EmailTemplateEditor.tsx apps/admin/src/screens/EmailTemplateEditor.test.tsx
git commit -m "feat(admin): wire version history drawer into the email-template editor"
```

---

## Final validation (after all tasks)

- [ ] Backend suite: `pnpm --filter @tarmoto/backend test -- admin-email-template` — all pass.
- [ ] Admin suite: `pnpm --filter @tarmoto/admin test` — all pass (covers `VersionHistoryDrawer`, `EmailTemplateEditor`, `PreviewPane`, `BlockCard`).
- [ ] Contract idempotent: re-run `pnpm openapi:gen && pnpm postman:gen`; `git status` shows no further diff.
- [ ] Admin typecheck: `pnpm --filter @tarmoto/admin exec tsc --noEmit` — clean.
- [ ] Confirm no migration file was added under `apps/backend/src/migrations/`.
- [ ] Whole-branch review, then finishing-a-development-branch (push + open PR against main, linking Phase 2a #988 / 2b #994).
