# Admin Email Template Editor — Phase 1 (Backend Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend foundation for admin-customizable emails — a block schema, versioned storage, a code-owned block renderer, per-template presentation-variable whitelists, and a render-override seam in `EmailService` — with the code templates still rendering (no UI yet).

**Architecture:** Additive override with code fallback. An admin-authored block document per `(template_tag, locale)`, once `published`, renders instead of the code template via a code-owned `renderBlocks` (chrome + escaping stay in code; vars whitelisted + escaped; button URLs whitelist-only). With no override, the code template renders exactly as today. Token/security emails have no override path.

**Tech Stack:** NestJS 11 + TypeORM (PostgreSQL/jsonb), `@tarmoto/shared` (block schema + i18n), jest (backend, ambient globals), `@tarmoto/shared` vitest.

## Global Constraints

- **Editable tags (6):** `weekly-digest`, `subscription-confirmed`, `subscription-cancelled`, `data-export-ready`, `account-deletion-scheduled`, `account-deletion-completed`. **Locked (4, no override path):** `verification`, `password-reset`, `trip-invite`, `password-changed`.
- **Byte-identical:** the 45 characterization snapshots (`apps/backend/src/modules/email/templates/templates.snapshot.spec.ts`) MUST stay unchanged (0 written) after the `presentationContext` extraction — the code templates render identically.
- **Safety (non-negotiable):** blocks compile to fixed code-owned HTML (no raw HTML); every `{var}` resolves only from the template's whitelist and is `escapeHtml`'d in HTML (unknown vars dropped); `button.urlVar` must be in the template's URL whitelist; the subject interpolates whitelisted vars **raw** (plain-text header); `renderLayout`/`renderTextFooter` chrome stays code-owned; a missing/invalid/failed override falls back to the code template (a send never breaks).
- **Backend jest is transpile-only** (~471 pre-existing unrelated `tsc` errors); guard type changes with `cd apps/backend && npx tsc -p tsconfig.json --noEmit` (0 new in touched files) + rely on CI's "Emit + validate OpenAPI" job. **Ambient jest globals** (no `@jest/globals`). `pnpm shared:build` after editing `packages/shared`.
- **Entity/migration registration:** a new entity goes in THREE lists (`entities/index.ts` barrel + `data-source.ts` + `database.module.ts`, guarded by `migration-registry.spec`); the migration goes in BOTH migration lists (`data-source.ts` + `database.module.ts`).
- Conventional commits, scope `backend`, lowercase subject ≤100; body ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File structure

- Create `packages/shared/src/email-blocks.ts` — `EmailBlock` union + `EmailBlockDocument` + validators.
- Create `apps/backend/src/entities/email-template.entity.ts` — the versioned override row.
- Create `apps/backend/src/migrations/<ts>-AddEmailTemplate.ts`.
- Create `apps/backend/src/modules/email/presentation/index.ts` — per-template `presentationContext(ctx)` + whitelists.
- Create `apps/backend/src/modules/email/render/render-blocks.ts` — the block renderer.
- Modify `apps/backend/src/modules/email/templates/index.ts` — code templates render from `presentationContext` (byte-identical).
- Modify `apps/backend/src/modules/email/email.service.ts` — the render-override seam.
- Modify `apps/backend/src/modules/email/email.module.ts` — register `EmailTemplate` repo.

---

### Task 1: `EmailBlock` schema + validator (`@tarmoto/shared`)

**Files:**

- Create: `packages/shared/src/email-blocks.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from "./email-blocks";`)
- Test: `packages/shared/src/email-blocks.spec.ts`

**Interfaces:**

- Produces: `type EmailBlock`, `type EmailBlockDocument = { subject: string; blocks: EmailBlock[] }`, `const EMAIL_BLOCK_TYPES`, `isEmailBlockDocument(v: unknown): v is EmailBlockDocument`.

- [ ] **Step 1: Write the failing test** — `email-blocks.spec.ts`

```ts
import { describe, it, expect } from "vitest";
import { isEmailBlockDocument } from "./email-blocks";

describe("isEmailBlockDocument", () => {
  it("accepts a valid document", () => {
    expect(
      isEmailBlockDocument({
        subject: "Hi {displayName}",
        blocks: [
          { type: "heading", text: "Your week" },
          { type: "paragraph", text: "You rode {rideSummary}." },
          { type: "button", label: "Explore", urlVar: "exploreUrl" },
          { type: "stat-row", label: "Distance", value: "{distance}" },
          { type: "divider" },
          { type: "spacer" },
        ],
      }),
    ).toBe(true);
  });

  it("rejects unknown block types and malformed blocks", () => {
    expect(
      isEmailBlockDocument({
        subject: "x",
        blocks: [{ type: "script", text: "x" }],
      }),
    ).toBe(false);
    expect(
      isEmailBlockDocument({
        subject: "x",
        blocks: [{ type: "button", label: "x" }],
      }),
    ).toBe(false);
    expect(isEmailBlockDocument({ subject: "x", blocks: "nope" })).toBe(false);
    expect(isEmailBlockDocument({ blocks: [] })).toBe(false);
    expect(isEmailBlockDocument(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @tarmoto/shared test` → FAIL (module missing).

- [ ] **Step 3: Implement** — `packages/shared/src/email-blocks.ts`

```ts
/**
 * Structured email blocks authored by admins and rendered to safe, escaped
 * HTML by the backend's code-owned renderer. Deliberately NO raw-HTML block —
 * each block compiles to fixed markup, so an admin can never inject HTML. See
 * docs/superpowers/specs/2026-07-14-admin-email-template-editor-phase1-design.md
 */
export type EmailBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "button"; label: string; urlVar: string }
  | { type: "stat-row"; label: string; value: string }
  | { type: "divider" }
  | { type: "spacer" };

export const EMAIL_BLOCK_TYPES = [
  "heading",
  "paragraph",
  "button",
  "stat-row",
  "divider",
  "spacer",
] as const;

export interface EmailBlockDocument {
  /** Plain-text subject; whitelisted {vars} interpolated raw (not HTML). */
  subject: string;
  blocks: EmailBlock[];
}

function isBlock(v: unknown): v is EmailBlock {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  switch (b.type) {
    case "heading":
    case "paragraph":
      return typeof b.text === "string";
    case "button":
      return typeof b.label === "string" && typeof b.urlVar === "string";
    case "stat-row":
      return typeof b.label === "string" && typeof b.value === "string";
    case "divider":
    case "spacer":
      return true;
    default:
      return false;
  }
}

export function isEmailBlockDocument(v: unknown): v is EmailBlockDocument {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.subject === "string" &&
    Array.isArray(d.blocks) &&
    d.blocks.every(isBlock)
  );
}
```

Add `export * from "./email-blocks";` to `packages/shared/src/index.ts`.

- [ ] **Step 4: Run → pass.** `pnpm --filter @tarmoto/shared test` → PASS. Then `pnpm shared:build` (exit 0).
- [ ] **Step 5: Commit** — `feat(backend): shared email-block schema + validator`.

---

### Task 2: `email_template` entity + migration

**Files:**

- Create: `apps/backend/src/entities/email-template.entity.ts`
- Create: `apps/backend/src/migrations/<timestamp>-AddEmailTemplate.ts` (match the repo's migration filename/class convention — inspect a recent sibling for the timestamp format)
- Modify: `apps/backend/src/entities/index.ts`, `apps/backend/src/data-source.ts`, `apps/backend/src/modules/database/database.module.ts` (entity in all 3; migration in the 2 migration lists)
- Test: covered by `migration-registry.spec` + a live `pnpm db:migrate`

**Interfaces:**

- Produces: `EmailTemplate` entity with `template_tag: string`, `locale: SupportedLocale`, `subject: string`, `blocks: EmailBlock[]` (jsonb), `status: 'draft'|'published'`, `version: number`, `created_by: string|null`, `created_at: Date`, `published_at: Date|null`.

- [ ] **Step 1: Entity** — `email-template.entity.ts`

```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";
import type { EmailBlock } from "@tarmoto/shared";
import type { SupportedLocale } from "@tarmoto/shared";

@Entity("email_template")
// At most one published override per (tag, locale); drafts are unconstrained.
@Index("uq_email_template_published", ["template_tag", "locale"], {
  unique: true,
  where: "status = 'published'",
})
export class EmailTemplate {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 64 })
  template_tag!: string;

  @Column({ type: "varchar", length: 10 })
  locale!: SupportedLocale;

  @Column({ type: "text" })
  subject!: string;

  @Column({ type: "jsonb" })
  blocks!: EmailBlock[];

  @Column({ type: "varchar", length: 16, default: "draft" })
  status!: "draft" | "published";

  @Column({ type: "int", default: 1 })
  version!: number;

  @Column({ type: "uuid", nullable: true })
  created_by!: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;

  @Column({ type: "timestamptz", nullable: true })
  published_at!: Date | null;
}
```

- [ ] **Step 2: Migration** (mirror a recent `apps/backend/src/migrations/*` for the class-name + timestamp format; use a timestamp after the latest existing one):

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddEmailTemplate1810000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "email_template" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "template_tag" varchar(64) NOT NULL,
        "locale" varchar(10) NOT NULL,
        "subject" text NOT NULL,
        "blocks" jsonb NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'draft',
        "version" int NOT NULL DEFAULT 1,
        "created_by" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "published_at" timestamptz,
        CONSTRAINT "pk_email_template" PRIMARY KEY ("id")
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_email_template_published"
      ON "email_template" ("template_tag", "locale") WHERE status = 'published'`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "uq_email_template_published"`);
    await q.query(`DROP TABLE "email_template"`);
  }
}
```

(If `uuid_generate_v4()` isn't available, match how sibling migrations generate uuids — some use `gen_random_uuid()`.)

- [ ] **Step 3: Register** the entity in `entities/index.ts` (barrel), `data-source.ts` (entities list + migrations list), `database.module.ts` (entities list + migrations list). Add the migration to the 2 migration lists.
- [ ] **Step 4: Run** `pnpm db:up` (if needed) + `pnpm db:migrate` → applies; verify the table + partial unique index exist. `pnpm --filter @tarmoto/backend test -- migration-registry` → green.
- [ ] **Step 5: Commit** — `feat(backend): email_template override entity + migration`.

---

### Task 3: `presentationContext` + whitelists (byte-identical code-template refactor)

**Files:**

- Create: `apps/backend/src/modules/email/presentation/index.ts`
- Modify: `apps/backend/src/modules/email/templates/index.ts` (render from `presentationContext`)
- Test: `apps/backend/src/modules/email/presentation/presentation.spec.ts` + the existing `templates.snapshot.spec.ts` (guard)

**Interfaces:**

- Produces: for each editable tag, `presentationContext(ctx)` → a `Record<string, string>` of text vars + a `Record<string, string>` of url vars; and `TEMPLATE_WHITELIST: Record<EditableTag, { textVars: string[]; urlVars: string[] }>`.

- [ ] **Step 1: Define the presentation module.** For each of the 6 editable templates, a function that computes its **pre-formatted** vars from the raw context (reusing the existing `formatDistance`/`formatDuration`/`translateEmail` for pluralized words). Fully-worked `weekly-digest`:

```ts
import { formatDistance, type UnitSystem } from "@tarmoto/shared";
import { translateEmail } from "../i18n/index.js";
import type { SupportedLocale } from "@tarmoto/shared";

function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m % 60}m`;
}

export interface DigestPresentationInput {
  displayName: string;
  rideCount: number;
  totalKm: number;
  totalMinutes: number;
  bestQuality: number | null;
  percentExplored: number;
  riddenSegments: number;
  units: UnitSystem;
  exploreUrl: string;
  locale: SupportedLocale;
}

export function digestPresentation(ctx: DigestPresentationInput) {
  const rideWord =
    ctx.rideCount === 1
      ? translateEmail("digest.rideWord.one", undefined, ctx.locale)
      : translateEmail("digest.rideWord.other", undefined, ctx.locale);
  return {
    textVars: {
      displayName: ctx.displayName,
      rideSummary: `${ctx.rideCount} ${rideWord}`,
      distance: formatDistance(ctx.totalKm, ctx.units),
      duration: formatDuration(ctx.totalMinutes),
      quality:
        ctx.bestQuality != null ? `${ctx.bestQuality.toFixed(1)} / 5` : "",
      riddenSegments: String(ctx.riddenSegments),
      percentExplored: `${ctx.percentExplored}%`,
    },
    urlVars: { exploreUrl: ctx.exploreUrl },
  };
}
```

Define the other five analogously, extracting each template's current formatting verbatim:

- **subscription-confirmed:** text `displayName`, `planName`, `priceLabel`, `renewsText` (= the current `renewsAt ? "Your next renewal is on {utc}." : "Your subscription is active."`); url `manageBillingUrl`.
- **subscription-cancelled:** text `displayName`, `planName`, `accessText` (= current `endsAt ? "You'll keep {plan} access until {utc}." : "Your {plan} access has ended."`); url `resubscribeUrl`.
- **data-export-ready:** text `displayName`, `expiresText` (= `expiresAt.toUTCString()`); url `downloadUrl`.
- **account-deletion-scheduled:** text `displayName`, `scheduledDate` (`scheduledFor.toUTCString()`), `supportEmail`; **no url vars** (support shown as text — no CTA button in Phase 1).
- **account-deletion-completed:** text `displayName`, `deletedDate` (`deletedAt.toUTCString()`), `supportEmail`; **no url vars**.

`TEMPLATE_WHITELIST` lists each tag's `textVars`/`urlVars` keys (the `Object.keys` of the above).

- [ ] **Step 2: Refactor the 6 code templates to render from `presentationContext`.** Replace each template's inline formatting with a call to its presentation function and interpolate `presentation.textVars.*` / `.urlVars.*` into the SAME catalog keys. Output must be identical — run `pnpm --filter @tarmoto/backend test -- templates.snapshot` and require **0 snapshots written**. If a snapshot diffs, the extraction changed a rendered string — fix the presentation value to match, do NOT touch the snapshot. (Locked templates are untouched.)

- [ ] **Step 3: Test the whitelist/presentation** — `presentation.spec.ts`: `digestPresentation({... rideCount: 1 ...}).textVars.rideSummary === "1 ride"`; `... rideCount: 4 ...` → `"4 rides"`; `quality` empty when `bestQuality` null; `TEMPLATE_WHITELIST['weekly-digest'].urlVars` includes `exploreUrl`. (Ambient jest globals.)

- [ ] **Step 4: Guard.** `pnpm --filter @tarmoto/backend test -- "templates.snapshot|presentation"` → all green, 0 snapshots written. 0 new tsc errors in touched files.
- [ ] **Step 5: Commit** — `refactor(backend): extract per-template email presentationContext`.

---

### Task 4: `renderBlocks` block renderer

**Files:**

- Create: `apps/backend/src/modules/email/render/render-blocks.ts`
- Test: `apps/backend/src/modules/email/render/render-blocks.spec.ts`

**Interfaces:**

- Consumes: `EmailBlock`/`EmailBlockDocument` (Task 1); `renderLayout`/`renderTextFooter`/`escapeHtml` (`../templates/layout.js`); a `{ textVars, urlVars }` presentation (Task 3).
- Produces: `renderBlocks(doc, presentation, opts): { subject: string; html: string; text: string }` where `opts = { locale, preferencesUrl, marketingFooter }`.

- [ ] **Step 1: Write the failing test** — covering var resolution, escaping, unknown-var drop, whitelisted button url, and chrome wrapping:

```ts
import { renderBlocks } from "./render-blocks.js";

const PRES = {
  textVars: { displayName: "<b>Riku</b>", rideSummary: "4 rides" },
  urlVars: { exploreUrl: "https://x/explore" },
};
const OPTS = {
  locale: "en" as const,
  preferencesUrl: "https://x/prefs",
  marketingFooter: true,
};

it("resolves + escapes vars, drops unknowns, wraps in chrome", () => {
  const out = renderBlocks(
    {
      subject: "Hi {displayName} — {unknown}",
      blocks: [
        { type: "paragraph", text: "You rode {rideSummary}, {displayName}." },
        { type: "button", label: "Explore", urlVar: "exploreUrl" },
      ],
    },
    PRES,
    OPTS,
  );
  // subject: raw interpolation (plain-text header), unknown dropped
  expect(out.subject).toBe("Hi <b>Riku</b> — ");
  // html: user var escaped, unknown dropped, button url present, chrome present
  expect(out.html).toContain("You rode 4 rides, &lt;b&gt;Riku&lt;/b&gt;.");
  expect(out.html).toContain('href="https://x/explore"');
  expect(out.html).toContain("<!doctype html>");
  // text: raw var, plain projection
  expect(out.text).toContain("You rode 4 rides, <b>Riku</b>.");
});

it("throws/ignores a button whose urlVar is not in urlVars", () => {
  const out = renderBlocks(
    {
      subject: "x",
      blocks: [{ type: "button", label: "X", urlVar: "evilUrl" }],
    },
    PRES,
    OPTS,
  );
  expect(out.html).not.toContain("evilUrl");
  expect(out.html).not.toContain('href="evil');
});
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — `render-blocks.ts`:

```ts
import {
  renderLayout,
  renderTextFooter,
  escapeHtml,
} from "../templates/layout.js";
import type {
  EmailBlock,
  EmailBlockDocument,
  SupportedLocale,
} from "@tarmoto/shared";

interface Presentation {
  textVars: Record<string, string>;
  urlVars: Record<string, string>;
}
interface Opts {
  locale: SupportedLocale;
  preferencesUrl: string;
  marketingFooter: boolean;
}

const VAR = /\{(\w+)\}/g;
// Resolve {vars} from a map; unknown → "" (dropped). `escape` for HTML contexts.
function interp(
  text: string,
  vars: Record<string, string>,
  escape: boolean,
): string {
  return text.replace(VAR, (_m, k: string) => {
    const v = vars[k];
    if (v === undefined) return "";
    return escape ? escapeHtml(v) : v;
  });
}

function blockHtml(b: EmailBlock, p: Presentation): string {
  switch (b.type) {
    case "heading":
      return `<p style="font-size:18px;font-weight:600;color:#f8fafc;margin:0 0 12px;">${interp(b.text, p.textVars, true)}</p>`;
    case "paragraph":
      return `<p style="margin:0 0 16px;">${interp(b.text, p.textVars, true)}</p>`;
    case "button": {
      const url = p.urlVars[b.urlVar]; // whitelist-only; unknown → no button
      if (url === undefined) return "";
      return `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 24px;background:#06b6d4;color:#0f172a;text-decoration:none;font-weight:600;border-radius:8px;">${interp(b.label, p.textVars, true)}</a></p>`;
    }
    case "stat-row":
      return `<table role="presentation" width="100%" style="margin:6px 0;"><tr><td style="color:#94a3b8;font-size:14px;">${interp(b.label, p.textVars, true)}</td><td style="color:#f8fafc;font-size:16px;font-weight:600;text-align:right;">${interp(b.value, p.textVars, true)}</td></tr></table>`;
    case "divider":
      return `<hr style="border:none;border-top:1px solid #334155;margin:24px 0;" />`;
    case "spacer":
      return `<div style="height:16px;"></div>`;
  }
}

function blockText(b: EmailBlock, p: Presentation): string {
  switch (b.type) {
    case "heading":
    case "paragraph":
      return `${interp(b.text, p.textVars, false)}\n\n`;
    case "button": {
      const url = p.urlVars[b.urlVar];
      return url === undefined
        ? ""
        : `${interp(b.label, p.textVars, false)}: ${url}\n\n`;
    }
    case "stat-row":
      return `  • ${interp(b.label, p.textVars, false)}: ${interp(b.value, p.textVars, false)}\n`;
    case "divider":
      return `—\n\n`;
    case "spacer":
      return `\n`;
  }
}

export function renderBlocks(
  doc: EmailBlockDocument,
  p: Presentation,
  opts: Opts,
): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = interp(doc.subject, p.textVars, false); // subject is plain text → raw
  const bodyHtml = doc.blocks.map((b) => blockHtml(b, p)).join("\n");
  const html = renderLayout({
    preheader: subject,
    preferencesUrl: opts.preferencesUrl,
    marketingFooter: opts.marketingFooter,
    locale: opts.locale,
    bodyHtml,
  });
  const text = `${doc.blocks.map((b) => blockText(b, p)).join("")}${renderTextFooter(opts.preferencesUrl, opts.marketingFooter, opts.locale)}`;
  return { subject, html, text };
}
```

- [ ] **Step 4: Run → pass.** `pnpm --filter @tarmoto/backend test -- render-blocks`.
- [ ] **Step 5: Commit** — `feat(backend): code-owned email block renderer`.

---

### Task 5: Render-override seam in `EmailService`

**Files:**

- Modify: `apps/backend/src/modules/email/email.service.ts`
- Modify: `apps/backend/src/modules/email/email.module.ts` (add `TypeOrmModule.forFeature([EmailTemplate])`)
- Test: `apps/backend/src/modules/email/email.service.spec.ts`

**Interfaces:**

- Consumes: `EmailTemplate` (Task 2), `renderBlocks` (Task 4), the presentation functions + `TEMPLATE_WHITELIST` (Task 3), the editable-tag set.
- Produces: an internal `renderWithOverride(tag, ctx) → RenderedTemplate | null` used by `send*` before the code template.

- [ ] **Step 1:** Inject an `@Optional() @InjectRepository(EmailTemplate)` repo (mirrors the existing `@Optional` `EmailLog` repo so unit tests without the DB still construct the service).

- [ ] **Step 2:** Add a private helper: for an **editable** tag only, query the published override for `(tag, ctx.locale)`; if found and `isEmailBlockDocument({subject, blocks})`, call `renderBlocks(doc, <tag>Presentation(ctx), { locale: ctx.locale, preferencesUrl, marketingFooter: tag === 'weekly-digest' })` and return `{ subject, html, text, tag }`. On no-row / invalid-doc / **any thrown error**, return `null` (→ caller uses the code template). Locked tags: never query (return `null` immediately). Wrap the whole helper in try/catch that logs + returns `null` — a lookup failure must never block a send.

- [ ] **Step 3:** In each **editable** `send*`, render via the override if present, else the code template:

```ts
async sendWeeklyDigest(to, ctx, locale = DEFAULT_LOCALE) {
  const base = this.withBase(ctx, locale);
  const overridden = await this.renderOverride("weekly-digest", base);
  return this.dispatch(to, overridden ?? weeklyDigestTemplate(base));
}
```

(Locked `send*` are unchanged — they never call `renderOverride`.)

- [ ] **Step 4: Tests** (ambient globals, stub the `EmailTemplate` repo): a published block override for `weekly-digest`+`en` → the dispatched message is the block-rendered one (assert a block string appears); no override → the code template (existing subject); a repo `findOne` that throws → falls back to the code template (no error propagates); a locked tag (`sendVerification`) never calls the repo (assert `findOne` not called). Keep the existing `email.service` tests green.

- [ ] **Step 5:** `cd apps/backend && npx tsc -p tsconfig.json --noEmit` (0 new errors) + `pnpm --filter @tarmoto/backend test -- email` (all green, 45 snapshots byte-identical).
- [ ] **Step 6: Commit** — `feat(backend): render published email overrides, code fallback`.

---

### Task 6: PR verification + open PR

- [ ] **Step 1:** `pnpm shared:build && pnpm --filter @tarmoto/backend build && pnpm --filter @tarmoto/backend test -- email && pnpm --filter @tarmoto/shared test` → all green; 45 snapshots byte-identical; migration applied.
- [ ] **Step 2:** Confirm no OpenAPI/Postman diff (Phase 1 adds no endpoints/DTOs — the entity + renderer are internal). `git status` shows no generated-artifact churn.
- [ ] **Step 3:** Open PR `feat(backend): admin email template override foundation`; body notes it's Phase 1 of 3 (no UI yet), the additive-override-with-code-fallback model, the safety boundary (code-owned renderer, whitelisted+escaped vars, whitelist-only button URLs, locked emails), and byte-identical current output. Link the spec.

## Self-review (completed)

- **Spec coverage:** storage → T2; block schema → T1; presentationContext + whitelist → T3; block renderer → T4; render-override seam → T5; safety model → enforced in T1 (no raw HTML), T4 (escape/whitelist/whitelist-only URL/chrome), T5 (fallback + locked). Non-goals (no UI/API, no versioning workflow) respected.
- **Type consistency:** `EmailBlock`/`EmailBlockDocument`/`isEmailBlockDocument` (T1) used in T2 (jsonb), T4 (renderer), T5 (validate); `renderBlocks(doc, presentation, opts)` signature consistent T4→T5; presentation `{textVars, urlVars}` shape consistent T3→T4→T5.
- **Byte-identical:** only T3 touches rendering; guarded by the 45 snapshots (0 written). T5 adds a branch but the no-override path is unchanged.
- **Deferred/flagged:** deletion templates have no url vars (support-as-text) in Phase 1; inline `<strong>` dropped (plain-text blocks); `password-changed` locked.
