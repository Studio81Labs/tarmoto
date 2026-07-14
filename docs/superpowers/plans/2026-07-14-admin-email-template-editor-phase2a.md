# Admin Email Template Editor — Phase 2a (Backend API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A backend CRUD/publish/preview API letting `support` admins draft + preview email-template overrides and `super_admin`s publish them, reusing Phase 1's code-owned `renderBlocks` for preview and enforcing the variable whitelist + subject safety at write time.

**Architecture:** New endpoints in the `admin-email` module over the Phase-1 `email_template` entity. A shared `validateBlockDocument` gate (shape + no-CRLF subject + whitelist) runs on draft/preview/publish; preview/test-send render the supplied doc through `renderBlocks` + fixed per-template sample data; publish promotes the draft to `published` in one transaction (deleting the prior published, keeping the ≤1-published index satisfied).

**Tech Stack:** NestJS 11 + TypeORM (Postgres, `DataSource` transaction), `@tarmoto/shared` (`isEmailBlockDocument`, `SUPPORTED_LOCALES`), the Phase-1 `email/presentation` (`TEMPLATE_WHITELIST`, `EDITABLE_TAGS`) + `email/render/render-blocks` (`renderBlocks`), jest (ambient globals).

## Global Constraints

- **Roles:** `support` → GET list/detail, PUT draft, POST preview, POST test-send. `super_admin` → POST publish, DELETE override. Use `@AdminRoles('support')` / `@AdminRoles('super_admin')`. All audited by the existing `AdminAuditInterceptor`. Routes prefix-less under `/admin/*`.
- **Editable tags (6):** `weekly-digest`, `subscription-confirmed`, `subscription-cancelled`, `data-export-ready`, `account-deletion-scheduled`, `account-deletion-completed`. Locked tags (`verification`/`password-reset`/`trip-invite`/`password-changed`) → **404** on every route. `legalSensitive` = the 2 deletion notices.
- **Validation is non-negotiable:** `isEmailBlockDocument` + subject non-empty & no `\r`/`\n`/control chars & ≤255 chars + every `{var}` in subject/text-fields ∈ `TEMPLATE_WHITELIST[tag].textVars` + every `button.urlVar` ∈ `TEMPLATE_WHITELIST[tag].urlVars`. A violation → **400** with field-level errors. Runs on draft-save, preview, publish.
- **Publish atomicity:** delete-prior-published + promote-draft in ONE `DataSource.transaction` (the partial unique index rejects two `published`).
- **Contract:** new DTOs → regenerate committed OpenAPI (`pnpm openapi:gen`) AND Postman (`pnpm postman:gen` + `prettier --write` the collection). Diffs scoped to the new email-template paths/DTOs.
- **Backend jest transpile-only** (~471+ pre-existing tsc errors) — guard with `cd apps/backend && npx tsc -p tsconfig.json --noEmit` (0 new in touched files). **Ambient jest globals.** Conventional commits, scope `backend`, lowercase ≤100; body ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File structure

- Create `apps/backend/src/modules/email/render/validate-block-document.ts` — the write-path validator.
- Create `apps/backend/src/modules/email/render/sample-presentation.ts` — `SAMPLE_PRESENTATION` per editable tag.
- Modify `apps/backend/src/modules/email/email.service.ts` — add public `sendRendered(to, rendered)`.
- Create `apps/backend/src/modules/admin-email/dto/admin-email-template.dto.ts` — the DTOs.
- Create `apps/backend/src/modules/admin-email/admin-email-template.service.ts` — the logic.
- Create `apps/backend/src/modules/admin-email/admin-email-template.controller.ts` — the 7 endpoints.
- Modify `apps/backend/src/modules/admin/admin.module.ts` — register `EmailTemplate` repo + the new controller/service.

---

### Task 1: `validateBlockDocument` (write-path gate)

**Files:**

- Create: `apps/backend/src/modules/email/render/validate-block-document.ts`
- Test: `apps/backend/src/modules/email/render/validate-block-document.spec.ts`

**Interfaces:**

- Consumes: `isEmailBlockDocument`, `EmailBlock` (`@tarmoto/shared`); `TEMPLATE_WHITELIST`, `EditableTag`, `isEditableTag` (`../presentation/index.js` — read that file for the exact export names).
- Produces: `validateBlockDocument(tag: EditableTag, doc: unknown): { ok: true; doc: EmailBlockDocument } | { ok: false; errors: string[] }`.

- [ ] **Step 1: Failing test** — `validate-block-document.spec.ts` (ambient jest globals):

```ts
import { validateBlockDocument } from "./validate-block-document.js";

const OK = {
  subject: "Your week — {rideSummary}",
  blocks: [
    { type: "paragraph", text: "Hi {displayName}, you rode {distance}." },
    { type: "button", label: "Explore", urlVar: "exploreUrl" },
  ],
};

describe("validateBlockDocument (weekly-digest)", () => {
  it("accepts a doc whose vars are all whitelisted", () => {
    const r = validateBlockDocument("weekly-digest", OK);
    expect(r.ok).toBe(true);
  });
  it("rejects a CRLF subject", () => {
    const r = validateBlockDocument("weekly-digest", {
      ...OK,
      subject: "a\r\nBcc: x",
    });
    expect(r).toEqual({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("subject")]),
    });
  });
  it("rejects an unknown {var}", () => {
    const r = validateBlockDocument("weekly-digest", {
      ...OK,
      blocks: [{ type: "paragraph", text: "{ssn}" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("ssn"))).toBe(true);
  });
  it("rejects a button urlVar not in the url whitelist", () => {
    const r = validateBlockDocument("weekly-digest", {
      ...OK,
      blocks: [{ type: "button", label: "x", urlVar: "evil" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("evil"))).toBe(true);
  });
  it("rejects a malformed block (isEmailBlockDocument)", () => {
    const r = validateBlockDocument("weekly-digest", {
      subject: "x",
      blocks: [{ type: "script" }],
    });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @tarmoto/backend test -- validate-block-document`
- [ ] **Step 3: Implement** — `validate-block-document.ts`:

```ts
import {
  isEmailBlockDocument,
  type EmailBlock,
  type EmailBlockDocument,
} from "@tarmoto/shared";
import { TEMPLATE_WHITELIST, type EditableTag } from "../presentation/index.js";

const VAR = /\{(\w+)\}/g;
const SUBJECT_MAX = 255;

function varsIn(text: string): string[] {
  return [...text.matchAll(VAR)].map((m) => m[1]!);
}

/** Text fields an admin can put {vars} into, per block type. */
function textFieldsOf(b: EmailBlock): string[] {
  switch (b.type) {
    case "heading":
    case "paragraph":
      return [b.text];
    case "stat-row":
      return [b.label, b.value];
    case "button":
      return [b.label];
    default:
      return [];
  }
}

export function validateBlockDocument(
  tag: EditableTag,
  doc: unknown,
): { ok: true; doc: EmailBlockDocument } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isEmailBlockDocument(doc)) {
    return {
      ok: false,
      errors: [
        "Document shape is invalid (unknown block type or missing field).",
      ],
    };
  }
  const wl = TEMPLATE_WHITELIST[tag];
  const textVars = new Set(wl.textVars);
  const urlVars = new Set(wl.urlVars);

  const s = doc.subject;
  if (s.trim() === "") errors.push("subject: must not be empty.");
  if (/[\x00-\x1f\x7f]/.test(s))
    errors.push("subject: must not contain line breaks or control characters.");
  if (s.length > SUBJECT_MAX)
    errors.push(`subject: must be ≤ ${SUBJECT_MAX} characters.`);
  for (const v of varsIn(s))
    if (!textVars.has(v)) errors.push(`subject: unknown variable {${v}}.`);

  doc.blocks.forEach((b, i) => {
    for (const field of textFieldsOf(b))
      for (const v of varsIn(field))
        if (!textVars.has(v))
          errors.push(`block ${i} (${b.type}): unknown variable {${v}}.`);
    if (b.type === "button" && !urlVars.has(b.urlVar))
      errors.push(
        `block ${i} (button): urlVar "${b.urlVar}" is not a valid link for this template.`,
      );
  });

  return errors.length ? { ok: false, errors } : { ok: true, doc };
}
```

- [ ] **Step 4: Run → pass.** **Step 5: Commit** — `feat(backend): email block-document write-path validator`.

---

### Task 2: `SAMPLE_PRESENTATION` (preview/test-send sample data)

**Files:**

- Create: `apps/backend/src/modules/email/render/sample-presentation.ts`
- Test: `apps/backend/src/modules/email/render/sample-presentation.spec.ts`

**Interfaces:**

- Consumes: `EDITABLE_TAGS`, `TEMPLATE_WHITELIST`, `EditableTag` (`../presentation/index.js`).
- Produces: `SAMPLE_PRESENTATION: Record<EditableTag, { textVars: Record<string,string>; urlVars: Record<string,string> }>`.

- [ ] **Step 1: Failing test** — every editable tag has a sample whose keys **exactly cover** its whitelist (so preview can render any admin-authored `{var}`):

```ts
import { SAMPLE_PRESENTATION } from "./sample-presentation.js";
import { EDITABLE_TAGS, TEMPLATE_WHITELIST } from "../presentation/index.js";

describe("SAMPLE_PRESENTATION", () => {
  it.each(EDITABLE_TAGS)("%s sample covers its whitelist keys", (tag) => {
    const s = SAMPLE_PRESENTATION[tag];
    const wl = TEMPLATE_WHITELIST[tag];
    expect(Object.keys(s.textVars).sort()).toEqual([...wl.textVars].sort());
    expect(Object.keys(s.urlVars).sort()).toEqual([...wl.urlVars].sort());
  });
});
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — `sample-presentation.ts`. Provide realistic sample strings for every whitelist key of each editable tag (read `../presentation/index.ts` for the exact key sets; the values are illustrative preview data):

```ts
import type { EditableTag } from "../presentation/index.js";

type Sample = {
  textVars: Record<string, string>;
  urlVars: Record<string, string>;
};

export const SAMPLE_PRESENTATION: Record<EditableTag, Sample> = {
  "weekly-digest": {
    textVars: {
      displayName: "Riku",
      rideSummary: "4 rides",
      rideCount: "4",
      distance: "213 km",
      duration: "6h 12m",
      quality: "4.2 / 5",
      riddenSegments: "512",
      percentExplored: "38%",
    },
    urlVars: { exploreUrl: "https://app.tarmoto.example/explore" },
  },
  "subscription-confirmed": {
    textVars: {
      displayName: "Riku",
      planName: "Pro",
      priceLabel: "€29.99/mo",
      renewsText: "Your next renewal is on Sun, 01 Mar 2026 08:00:00 GMT.",
      renewsDate: "Sun, 01 Mar 2026 08:00:00 GMT",
    },
    urlVars: { manageBillingUrl: "https://app.tarmoto.example/billing" },
  },
  "subscription-cancelled": {
    textVars: {
      displayName: "Riku",
      planName: "Pro",
      accessText: "You'll keep Pro access until Sun, 01 Mar 2026 08:00:00 GMT.",
    },
    urlVars: { resubscribeUrl: "https://app.tarmoto.example/billing" },
  },
  "data-export-ready": {
    textVars: {
      displayName: "Riku",
      expiresText: "Sun, 01 Mar 2026 08:00:00 GMT",
    },
    urlVars: { downloadUrl: "https://app.tarmoto.example/export/abc" },
  },
  "account-deletion-scheduled": {
    textVars: {
      displayName: "Riku",
      scheduledDate: "Sun, 01 Mar 2026 08:00:00 GMT",
      supportEmail: "support@tarmoto.app",
    },
    urlVars: {},
  },
  "account-deletion-completed": {
    textVars: {
      displayName: "Riku",
      deletedDate: "Sun, 01 Mar 2026 08:00:00 GMT",
      supportEmail: "support@tarmoto.app",
    },
    urlVars: {},
  },
};
```

**IMPORTANT:** the test asserts each sample's keys == that tag's whitelist keys. Read `presentation/index.ts` and make the sample keys match exactly (add/rename to match the real `TEMPLATE_WHITELIST`).

- [ ] **Step 4: Run → pass. Step 5: Commit** — `feat(backend): fixed sample presentation data for email preview`.

---

### Task 3: DTOs

**Files:**

- Create: `apps/backend/src/modules/admin-email/dto/admin-email-template.dto.ts`
- Test: covered by controller tests (Task 5)

**Interfaces:**

- Produces: `EmailBlockDto` (+ the block variants as a `@ApiProperty`-annotated shape), `EmailTemplateSummaryDto`, `EmailTemplateDetailDto`, `SaveDraftDto`, `PreviewRequestDto`, `PreviewResponseDto`.

- [ ] **Step 1:** Define DTOs with `class-validator` + `@ApiProperty` (match the module's DTO style, e.g. `admin-email.dto.ts`). Key shapes:
  - `SaveDraftDto` / `PreviewRequestDto`: `{ subject: string; blocks: unknown[] }` — validated by `@IsString()` subject + `@IsArray()` blocks; the deep block validation is done by `validateBlockDocument` in the service (class-validator can't express the discriminated union cleanly, and the shared validator is the source of truth). Document `blocks` as an array of `EmailBlockDto` for OpenAPI.
  - `EmailBlockDto`: an `@ApiProperty`-annotated union-ish shape (`type`, optional `text`/`label`/`urlVar`/`value`) so the generated client has a type. Wire form of `EmailBlock`.
  - `EmailTemplateSummaryDto`: `{ tag: string; label: string; hasDraft: boolean; hasPublished: boolean; legalSensitive: boolean }`.
  - `EmailTemplateDetailDto`: `{ tag; locale; subject; blocks: EmailBlockDto[]; status: 'draft'|'published'|'none'; version: number; whitelist: { textVars: string[]; urlVars: string[] } }`.
  - `PreviewResponseDto`: `{ subject: string; html: string; text: string }`.
- [ ] **Step 2: Commit** — `feat(backend): admin email-template DTOs`.

---

### Task 4: `AdminEmailTemplateService` + `EmailService.sendRendered`

**Files:**

- Create: `apps/backend/src/modules/admin-email/admin-email-template.service.ts`
- Modify: `apps/backend/src/modules/email/email.service.ts` (add `sendRendered`)
- Test: `apps/backend/src/modules/admin-email/admin-email-template.service.spec.ts`

**Interfaces:**

- Consumes: `EmailTemplate` entity + its `Repository` + `DataSource` (transaction); `validateBlockDocument` (T1); `SAMPLE_PRESENTATION` (T2); `renderBlocks`; `TEMPLATE_WHITELIST`/`EDITABLE_TAGS`/`isEditableTag`; `EmailService`; the labels for each tag.
- Produces: `list()`, `get(tag, locale)`, `saveDraft(tag, locale, dto)`, `preview(tag, locale, dto)`, `testSend(tag, locale, dto, toEmail)`, `publish(tag, locale)`, `reset(tag, locale)`.

- [ ] **Step 1:** Add to `EmailService` a public thin wrapper over the private `dispatch` (so a pre-rendered preview can be sent):

```ts
/** Send an already-rendered email (used by the admin template preview test-send). */
async sendRendered(to: string, rendered: RenderedTemplate): Promise<EmailSendResult | null> {
  return this.dispatch(to, rendered);
}
```

- [ ] **Step 2:** Implement the service. Key logic:
  - `list()`: for each `EDITABLE_TAGS`, query whether a `draft`/`published` row exists (any locale, or default locale — keep it a per-tag summary: `hasDraft`/`hasPublished` = a row of that status exists for the tag); `legalSensitive = tag.startsWith('account-deletion')`; `label` from a `TAG_LABELS` map.
  - `get(tag, locale)`: reject non-editable tag (`NotFoundException`). Find the `draft` row else the `published` row for `(tag, locale)`. Return `{ tag, locale, subject, blocks, status: draft?'draft':published?'published':'none', version, whitelist: TEMPLATE_WHITELIST[tag] }`; when none, `{ subject: '', blocks: [], status: 'none', version: 0, whitelist }`.
  - `saveDraft(tag, locale, dto)`: `validateBlockDocument(tag, dto)`; on `!ok` → `BadRequestException(errors)`. Upsert the single `draft` row for `(tag, locale)` (find-or-create, set subject+blocks). Return the saved doc.
  - `preview(tag, locale, dto)`: validate; on ok → `renderBlocks(r.doc, SAMPLE_PRESENTATION[tag], { locale, preferencesUrl: this preferencesUrl, marketingFooter: tag === 'weekly-digest' })` → `{ subject, html, text }`.
  - `testSend(tag, locale, dto, toEmail)`: same render → `emailService.sendRendered(toEmail, { ...rendered, tag })` → `{ status: result ? 'sent' : 'failed' }`.
  - `publish(tag, locale)`: `dataSource.transaction(async (m) => { const draft = await m.findOne(EmailTemplate, { where: { template_tag: tag, locale, status: 'draft' } }); if (!draft) throw new NotFoundException(); await m.delete(EmailTemplate, { template_tag: tag, locale, status: 'published' }); draft.status = 'published'; draft.version += 1; draft.published_at = <now>; await m.save(draft); })`. (Use the repo's `manager` clock — pass a Date in; do NOT use `new Date()` inside a workflow, but here it's normal service code so `new Date()` is fine.)
  - `reset(tag, locale)`: `repo.delete({ template_tag: tag, locale, status: 'published' })` (idempotent).
- [ ] **Step 3: Tests** (stub the repo + DataSource + EmailService): saveDraft rejects an invalid doc (400) + upserts a valid one; preview renders via renderBlocks (assert a sample value appears); publish with no draft → 404; publish deletes the prior published then promotes the draft (assert `delete(published)` called before `save(status:'published')`); reset deletes the published row; a non-editable tag → 404.
- [ ] **Step 4:** 0 new tsc errors. **Step 5: Commit** — `feat(backend): admin email-template service (draft/preview/publish/reset)`.

---

### Task 5: Controller + roles + module wiring + contract

**Files:**

- Create: `apps/backend/src/modules/admin-email/admin-email-template.controller.ts`
- Modify: `apps/backend/src/modules/admin/admin.module.ts`
- Test: `apps/backend/src/modules/admin-email/admin-email-template.controller.spec.ts`

**Interfaces:**

- Consumes: `AdminEmailTemplateService` (T4), the DTOs (T3), `@AdminRoles`.

- [ ] **Step 1:** The controller — 7 endpoints mapping to the service, with the role decorators from the Global Constraints table. Get the requesting admin's email/id from `req.user` for test-send (mirror how `admin-email.controller.ts` reads the admin identity). `super_admin` on `publish` + `override` (DELETE); `support` on the rest. `ApiOperation`/`ApiResponse` annotations like the sibling controller.
- [ ] **Step 2:** Register in `AdminModule`: add `EmailTemplate` to the `TypeOrmModule.forFeature([...])` list; add `AdminEmailTemplateController` to `controllers`; add `AdminEmailTemplateService` to `providers`. (`EmailModule` is already imported — `EmailService` is available; `DataSource` is globally available from TypeORM.)
- [ ] **Step 3: Tests** — role gating is the key one: with a `support` actor, `publish`/`DELETE override` → **403**; with `super_admin`, they pass through to the service; `support` can GET/PUT-draft/preview/test-send. A locked tag → 404. (Follow the module's controller-spec pattern — construct the controller with a mocked service + a role guard, or assert the `@AdminRoles` metadata via `Reflector`.)
- [ ] **Step 4: Regenerate the contract:** `pnpm openapi:gen` then `pnpm postman:gen` then `npx prettier --write <postman collection>`. Confirm the diffs are scoped to the new `/admin/email/templates*` paths + the new DTOs (no unrelated churn / no Postman UUID churn — discard any).
- [ ] **Step 5:** `pnpm --filter @tarmoto/backend build` clean; 0 new tsc errors. **Step 6: Commit** — `feat(backend): admin email-template CRUD/publish/preview endpoints`.

---

### Task 6: PR verification + open PR

- [ ] **Step 1:** `pnpm --filter @tarmoto/backend build && pnpm --filter @tarmoto/backend test -- "email|admin-email"` → green; the 45 email snapshots still byte-identical (this PR doesn't touch rendering). Migration already exists (Phase 1) — no new migration.
- [ ] **Step 2:** Confirm OpenAPI + Postman diffs are scoped to the new endpoints/DTOs.
- [ ] **Step 3:** Open PR `feat(backend): admin email-template editor API`; body notes Phase 2a (backend only, no UI), the support/super_admin role split, the write-path validation, preview-reuses-`renderBlocks`, the transactional publish, and the deferrals (blank-start, archived→Phase 3). Link the spec.

## Self-review (completed)

- **Spec coverage:** endpoints → T5; roles → T5 (+ tested); validation → T1; preview/test-send + sample → T2 + T4 (+ `sendRendered`); publish transaction → T4; reset → T4; GET draft>published>empty → T4; DTOs + contract → T3 + T5; non-goals (no UI, no versioning, no seed) respected.
- **Type consistency:** `validateBlockDocument(tag, doc) → {ok,doc}|{ok,errors}` (T1) consumed in T4; `SAMPLE_PRESENTATION[tag]` shape `{textVars,urlVars}` (T2) matches `renderBlocks`'s presentation param (Phase 1) + used in T4; `EmailService.sendRendered(to, RenderedTemplate)` (T4) used by test-send; DTO names (T3) used by the controller (T5).
- **Reuse:** preview/test-send reuse the Phase-1 `renderBlocks` (one renderer, one safety boundary) — no re-implementation.
- **Flagged:** `list()` summarizes per-tag existence (locale-agnostic) — the detail/edit is per-locale via `get`. Sample keys MUST be reconciled against the real `TEMPLATE_WHITELIST` (T2 test enforces it).
