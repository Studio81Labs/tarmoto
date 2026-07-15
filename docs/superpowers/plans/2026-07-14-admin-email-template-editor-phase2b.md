# Admin Email Template Editor — Phase 2b (Admin UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin-app UI to author, preview, test-send, draft, publish, and reset the per-`(tag, locale)` email-template overrides, seeded from the current email when no override exists.

**Architecture:** A small **backend** addition seeds the existing `GET` with a per-tag default block document (no contract change), and the **admin app** (Vite SPA) gets a templates-list screen plus a focused editor page that consumes the Phase-2a endpoints via `$api` hooks. Spec: `docs/superpowers/specs/2026-07-14-admin-email-template-editor-phase2b-ui-design.md`.

**Tech Stack:** NestJS + TypeORM (backend); React 19 + Vite + Tailwind v4 + `@tarmoto/ui` + `openapi-react-query` (`$api`) + `@tarmoto/openapi-client` + **Vitest** + Testing Library (admin app).

## Global Constraints

- **No OpenAPI/Postman/contract change.** Seeding rides on the existing `EmailTemplateDetailDto` shape. Do NOT run `openapi:gen`/`postman:gen`; do NOT add DTOs.
- **Only the 6 editable tags** ever appear: `weekly-digest`, `subscription-confirmed`, `subscription-cancelled`, `data-export-ready`, `account-deletion-scheduled`, `account-deletion-completed`. Locked tags never surface.
- **Roles:** `support` = list/get/save-draft/preview/test-send; `super_admin` = publish/reset. The UI **hides** (not disables) Publish/Reset for non-`super_admin` via `canAccess(role, 'super_admin')`. The backend `@AdminRoles('super_admin')` stays the real gate.
- **`en`-only** for v1: routes carry `:locale` but default to `en`.
- **Block vocabulary is fixed:** `heading`/`paragraph`/`button`/`stat-row`/`divider`/`spacer`. `button.urlVar` is whitelist-only (a `Select`, never a typed URL). No raw HTML, no new block types, no drag-and-drop dependency (up/down reorder).
- **Var insertion appends** `{var}` to the field (no caret positioning) — keeps it dependency-free.
- **Backend:** TypeScript strict; jest is transpile-only (gate = 0 NEW `tsc` errors in touched files); ambient jest globals (no `@jest/globals` import).
- **Admin app:** `@tarmoto/ui` components (`Button` variants incl. `primary`/`secondary`; `Input`/`Select` `onChange:(value:string)=>void`; `DataTable` has `onRowClick`) + Tailwind semantic tokens (`text-fg-dim`, `bg-cream`, `text-ink`, `border-line`, `bg-paper`); DTO types from `components["schemas"][...]` in `@tarmoto/openapi-client`. Vitest + Testing Library, mirroring `EmailScreen.tsx`/`EmailScreen`-style tests. **Admin CI type-checks test files** — run `pnpm --filter @tarmoto/admin exec tsc --noEmit` after editing any `.tsx`/`.test.tsx`.
- **Commits:** conventional, lowercase subject, `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer. Backend commits use scope `backend`; admin commits use scope `admin`.
- Branch: `feat/email-template-editor-ui` (already created off `main`).

## File Structure & task order

Tasks are ordered **leaf-first** so each compiles when implemented (subagent-driven runs them in order): backend seed → hooks → routes plumbing → editor subcomponents → editor page → list screen → App wiring.

- T1 `apps/backend/src/modules/admin-email/default-template-blocks.ts` (+ spec)
- T2 modify `admin-email-template.service.ts` `get()` (+ update its spec)
- T3 `apps/admin/src/data/useAdminEmailTemplates.ts`
- T4 modify `apps/admin/src/app/routes.ts` (route + `params`) (+ `routes.test.ts`)
- T5 `apps/admin/src/components/email-template/{VarChips,BlockCard,PreviewPane}.tsx` (+ tests)
- T6 `apps/admin/src/screens/EmailTemplateEditor.tsx` (+ test)
- T7 `apps/admin/src/screens/EmailTemplatesScreen.tsx` (+ test)
- T8 modify `apps/admin/src/app/App.tsx` (render the screen) + full verify + PR

---

### Task 1: Backend — `DEFAULT_TEMPLATE_BLOCKS` + validation guarantee

**Files:**

- Create: `apps/backend/src/modules/admin-email/default-template-blocks.ts`
- Test: `apps/backend/src/modules/admin-email/default-template-blocks.spec.ts`

**Interfaces:**

- Consumes: `EmailBlockDocument` (`@tarmoto/shared`); `EditableTag`, `TEMPLATE_WHITELIST` (`../email/presentation/index.js`); `validateBlockDocument` (`../email/render/validate-block-document.js`).
- Produces: `export const DEFAULT_TEMPLATE_BLOCKS: Record<EditableTag, EmailBlockDocument>`.

Each default is a faithful approximation of the current email — read `apps/backend/src/modules/email/templates/index.ts` + the `en` catalog under `apps/backend/src/modules/email/i18n/` to match copy — using **only** that tag's whitelist vars. The docs below are the concrete starting point; refine copy but keep every `{var}` within the tag's whitelist (the test enforces it).

- [ ] **Step 1: Write the failing test** — `default-template-blocks.spec.ts` (ambient jest globals):

```ts
import {
  EDITABLE_TAGS,
  TEMPLATE_WHITELIST,
} from "../email/presentation/index.js";
import { validateBlockDocument } from "../email/render/validate-block-document.js";
import { DEFAULT_TEMPLATE_BLOCKS } from "./default-template-blocks.js";

describe("DEFAULT_TEMPLATE_BLOCKS", () => {
  it.each(EDITABLE_TAGS)(
    "%s default is a valid, whitelist-clean doc",
    (tag) => {
      // A seed must always be savable/publishable as-is.
      expect(validateBlockDocument(tag, DEFAULT_TEMPLATE_BLOCKS[tag]).ok).toBe(
        true,
      );
    },
  );

  it.each(EDITABLE_TAGS)(
    "%s default has a non-empty subject and >=1 block",
    (tag) => {
      const doc = DEFAULT_TEMPLATE_BLOCKS[tag];
      expect(doc.subject.trim().length).toBeGreaterThan(0);
      expect(doc.blocks.length).toBeGreaterThan(0);
    },
  );

  it("covers exactly the editable tags", () => {
    expect(Object.keys(DEFAULT_TEMPLATE_BLOCKS).sort()).toEqual(
      [...EDITABLE_TAGS].sort(),
    );
    // A guard so the whitelist reference below stays meaningful.
    expect(TEMPLATE_WHITELIST["weekly-digest"].textVars).toContain(
      "displayName",
    );
  });
});
```

- [ ] **Step 2: Run → fail:** `cd <root> && pnpm --filter @tarmoto/backend exec jest src/modules/admin-email/default-template-blocks.spec.ts`

- [ ] **Step 3: Implement** `default-template-blocks.ts`:

```ts
import type { EmailBlockDocument } from "@tarmoto/shared";
import type { EditableTag } from "../email/presentation/index.js";

/**
 * Per-tag starting block documents for the admin editor. Served by
 * `AdminEmailTemplateService.get()` when a (tag, locale) has no override yet,
 * so the admin edits a real starting point instead of a blank slate. These
 * APPROXIMATE each current code email (fixed block vocabulary, different
 * renderer → not byte-identical) and reference ONLY each tag's whitelisted
 * vars — `default-template-blocks.spec.ts` proves both.
 */
export const DEFAULT_TEMPLATE_BLOCKS: Record<EditableTag, EmailBlockDocument> =
  {
    "weekly-digest": {
      subject: "Your week — {rideSummary}",
      blocks: [
        { type: "heading", text: "Hi {displayName}" },
        { type: "paragraph", text: "Here's your week on Tarmoto." },
        { type: "stat-row", label: "Rides", value: "{rideSummary}" },
        { type: "stat-row", label: "Distance", value: "{distance}" },
        { type: "stat-row", label: "Time in the saddle", value: "{duration}" },
        { type: "stat-row", label: "Best road quality", value: "{quality}" },
        {
          type: "paragraph",
          text: "You've ridden {riddenSegments} road segments — {percentExplored} of your area explored.",
        },
        { type: "button", label: "Explore your map", urlVar: "exploreUrl" },
      ],
    },
    "subscription-confirmed": {
      subject: "Your Tarmoto {planName} subscription is active",
      blocks: [
        { type: "heading", text: "Hi {displayName}" },
        { type: "paragraph", text: "You're now on Tarmoto {planName}." },
        { type: "stat-row", label: "Plan", value: "{planName}" },
        { type: "stat-row", label: "Price", value: "{priceLabel}" },
        { type: "paragraph", text: "{renewsText}" },
        { type: "button", label: "Manage billing", urlVar: "manageBillingUrl" },
      ],
    },
    "subscription-cancelled": {
      subject: "Your Tarmoto {planName} subscription is cancelled",
      blocks: [
        { type: "heading", text: "Hi {displayName}" },
        {
          type: "paragraph",
          text: "Your {planName} subscription has been cancelled.",
        },
        { type: "paragraph", text: "{accessText}" },
        { type: "button", label: "Resubscribe", urlVar: "resubscribeUrl" },
      ],
    },
    "data-export-ready": {
      subject: "Your Tarmoto data export is ready",
      blocks: [
        { type: "heading", text: "Hi {displayName}" },
        { type: "paragraph", text: "Your data export is ready to download." },
        { type: "paragraph", text: "This link expires {expiresText}." },
        { type: "button", label: "Download your data", urlVar: "downloadUrl" },
      ],
    },
    "account-deletion-scheduled": {
      subject: "Your Tarmoto account is scheduled for deletion",
      blocks: [
        { type: "heading", text: "Hi {displayName}" },
        {
          type: "paragraph",
          text: "Your account is scheduled for deletion on {scheduledDate}.",
        },
        {
          type: "paragraph",
          text: "Changed your mind during the grace window? Contact {supportEmail} and we can stop it.",
        },
      ],
    },
    "account-deletion-completed": {
      subject: "Your Tarmoto account has been deleted",
      blocks: [
        { type: "heading", text: "Hi {displayName}" },
        {
          type: "paragraph",
          text: "Your account and data were deleted on {deletedDate}.",
        },
        { type: "paragraph", text: "Questions? Reach us at {supportEmail}." },
      ],
    },
  };
```

- [ ] **Step 4: Run → pass.** Any validator rejection = a var not in that tag's whitelist; fix the var.
- [ ] **Step 5: 0 new tsc errors:** `pnpm --filter @tarmoto/backend exec tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'default-template-blocks' || echo clean`
- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/admin-email/default-template-blocks.ts apps/backend/src/modules/admin-email/default-template-blocks.spec.ts
git commit -m "feat(backend): default block documents to seed the email-template editor"
```

---

### Task 2: Backend — seed `get()` from the default when there's no override

**Files:**

- Modify: `apps/backend/src/modules/admin-email/admin-email-template.service.ts`
- Test: `apps/backend/src/modules/admin-email/admin-email-template.service.spec.ts`

**Interfaces:**

- Consumes: `DEFAULT_TEMPLATE_BLOCKS` (T1); `TEMPLATE_WHITELIST` (already imported); private `assertEditable`, `toDetail`.
- Produces: `get()` returns the seeded default (`status:'none'`, `version:0`) when neither a draft nor a published row exists; unchanged otherwise.

- [ ] **Step 1: Update the existing spec.** In `admin-email-template.service.spec.ts`, find the `get` test asserting the empty starter when there's no override and REPLACE its content assertions to expect the seeded default; add a focused test:

```ts
import { DEFAULT_TEMPLATE_BLOCKS } from "./default-template-blocks.js";

it("get seeds from the default doc when there is no draft or published row", async () => {
  const { service, templates } = make();
  templates.findOne.mockResolvedValue(null); // no draft, no published
  const result = await service.get("weekly-digest", "en");
  expect(result.status).toBe("none");
  expect(result.version).toBe(0);
  expect(result.subject).toBe(DEFAULT_TEMPLATE_BLOCKS["weekly-digest"].subject);
  expect(result.blocks).toEqual(
    DEFAULT_TEMPLATE_BLOCKS["weekly-digest"].blocks,
  );
  expect(result.whitelist.textVars).toContain("displayName");
});
```

If any existing test still asserts `subject: ''`/`blocks: []` for the no-override case, update those two expectations to the seeded values (do NOT leave a test asserting the empty starter).

- [ ] **Step 2: Run → fail:** `pnpm --filter @tarmoto/backend exec jest src/modules/admin-email/admin-email-template.service.spec.ts`

- [ ] **Step 3: Implement.** Add the import and replace `get()`'s body:

```ts
import { DEFAULT_TEMPLATE_BLOCKS } from "./default-template-blocks.js";
```

```ts
async get(
  tag: string,
  locale: SupportedLocale,
): Promise<EmailTemplateDetailDto> {
  this.assertEditable(tag);
  const draft = await this.templates.findOne({
    where: { template_tag: tag, locale, status: 'draft' },
  });
  const row =
    draft ??
    (await this.templates.findOne({
      where: { template_tag: tag, locale, status: 'published' },
    }));
  if (row) return this.toDetail(tag, locale, row);
  // No override yet — seed the editor from the tag's default block document
  // instead of a blank starter. Still status:'none'/version:0: nothing is
  // published, the code template keeps rendering until the admin publishes.
  const seed = DEFAULT_TEMPLATE_BLOCKS[tag];
  return {
    tag,
    locale,
    subject: seed.subject,
    blocks: seed.blocks,
    status: 'none',
    version: 0,
    whitelist: TEMPLATE_WHITELIST[tag],
  };
}
```

(`tag` is narrowed to `EditableTag` by `assertEditable`, so `DEFAULT_TEMPLATE_BLOCKS[tag]`/`TEMPLATE_WHITELIST[tag]` type-check.)

- [ ] **Step 4: Run → pass** (the whole service spec).
- [ ] **Step 5: 0 new tsc errors:** `pnpm --filter @tarmoto/backend exec tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'admin-email-template.service' || echo clean`
- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/admin-email/admin-email-template.service.ts apps/backend/src/modules/admin-email/admin-email-template.service.spec.ts
git commit -m "feat(backend): seed the editor GET from the default when no override exists"
```

---

### Task 3: Admin — `useAdminEmailTemplates` hooks

**Files:**

- Create: `apps/admin/src/data/useAdminEmailTemplates.ts`

**Interfaces:**

- Consumes: `$api` (`./apiClient.js`).
- Produces: `useEmailTemplates`, `useEmailTemplate`, `useSaveDraft`, `usePreview`, `useTestSend`, `usePublish`, `useReset`.

Mirror `useAdminEmail.ts`; path-param calls pass `{ params: { path: { tag, locale } } }` (query) / `.mutate({ params: { path: { tag, locale } }, body })` (mutation), as in `useAdminUsers.ts`/`ContentScreen.tsx`.

- [ ] **Step 1: Implement** (no unit test — exercised by screen tests; `tsc` is the gate):

```ts
import { $api } from "./apiClient.js";

export function useEmailTemplates() {
  return $api.useQuery("get", "/admin/email/templates");
}

export function useEmailTemplate(tag: string, locale: string) {
  return $api.useQuery(
    "get",
    "/admin/email/templates/{tag}/{locale}",
    { params: { path: { tag, locale } } },
    { enabled: tag.length > 0 },
  );
}

export function useSaveDraft() {
  return $api.useMutation("put", "/admin/email/templates/{tag}/{locale}/draft");
}
export function usePreview() {
  return $api.useMutation(
    "post",
    "/admin/email/templates/{tag}/{locale}/preview",
  );
}
export function useTestSend() {
  return $api.useMutation(
    "post",
    "/admin/email/templates/{tag}/{locale}/test-send",
  );
}
export function usePublish() {
  return $api.useMutation(
    "post",
    "/admin/email/templates/{tag}/{locale}/publish",
  );
}
export function useReset() {
  return $api.useMutation(
    "delete",
    "/admin/email/templates/{tag}/{locale}/override",
  );
}
```

- [ ] **Step 2: Typecheck (the gate):** `pnpm --filter @tarmoto/admin exec tsc --noEmit 2>&1 | grep -E 'useAdminEmailTemplates' || echo clean` — expected clean (a wrong path string errors against the generated `paths`).
- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/data/useAdminEmailTemplates.ts
git commit -m "feat(admin): data hooks for the email-template editor endpoints"
```

---

### Task 4: Admin — route entry + hash `params` (no App wiring yet)

**Files:**

- Modify: `apps/admin/src/app/routes.ts`
- Test: `apps/admin/src/app/routes.test.ts`

**Interfaces:**

- Produces: a new route `email-templates`; `useHashRoute()` now returns `{ active, params, navigate }` where `params` = path segments after the base key; `navigate` accepts a slash-path (`"email-templates/weekly-digest/en"`).

`currentKey()` currently matches the whole hash, so `#/email-templates/weekly-digest/en` would fall back to `overview`. Match the first segment; expose the rest as `params`. (App still shows "Coming soon" for the route until Task 8 wires it — that's a fine intermediate state.)

- [ ] **Step 1: Write the failing test** — `routes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { routes } from "./routes.js";

describe("routes", () => {
  it("includes the email-templates route for support+", () => {
    const r = routes.find((x) => x.key === "email-templates");
    expect(r).toBeDefined();
    expect(r?.minRole).toBe("support");
  });
});
```

- [ ] **Step 2: Run → fail:** `pnpm --filter @tarmoto/admin exec vitest run src/app/routes.test.ts`

- [ ] **Step 3: Implement `routes.ts`.** Add the route after `email`:

```ts
  { key: "email", label: "Email Log", minRole: "support" },
  { key: "email-templates", label: "Email Templates", minRole: "support" },
  { key: "poi-imports", label: "POI Imports", minRole: "support" },
```

Replace `currentKey()`/`useHashRoute` (keep the `useState/useEffect/useCallback` imports):

```ts
function currentSegments(): string[] {
  return window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
}

function currentKey(): string {
  const key = currentSegments()[0] ?? "";
  return routes.some((r) => r.key === key) ? key : "overview";
}

export function useHashRoute() {
  const [, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const segments = currentSegments();
  const active = currentKey();
  const params = segments.slice(1);
  const navigate = useCallback((path: string) => {
    window.location.hash = `#/${path}`;
  }, []);
  return { active, params, navigate };
}
```

(The unused `setHash` state exists only to re-render on `hashchange`; `active`/`params` recompute from `window.location.hash` each render. Keep `currentKey` exported/defined if other code imports it.)

- [ ] **Step 4: Run → pass** + typecheck: `pnpm --filter @tarmoto/admin exec vitest run src/app/routes.test.ts && pnpm --filter @tarmoto/admin exec tsc --noEmit 2>&1 | grep -E 'routes' || echo clean`
- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/app/routes.ts apps/admin/src/app/routes.test.ts
git commit -m "feat(admin): route entry + hash params for the email-template editor"
```

---

### Task 5: Admin — editor building blocks (`VarChips`, `BlockCard`, `PreviewPane`)

**Files:**

- Create: `apps/admin/src/components/email-template/VarChips.tsx`, `BlockCard.tsx`, `PreviewPane.tsx`
- Test: `apps/admin/src/components/email-template/BlockCard.test.tsx`, `PreviewPane.test.tsx`

**Interfaces:**

- Produces:
  - `VarChips({ vars, onInsert }: { vars: string[]; onInsert: (token: string) => void })` — a clickable chip per var; click calls `onInsert("{var}")`.
  - `type EditorBlock = components["schemas"]["EmailBlockDto"]`.
  - `BlockCard({ block, index, total, textVars, urlVars, onChange, onMove, onRemove })` — fields + `[↑][↓][✕]`. `onChange(next)`, `onMove(dir:-1|1)`, `onRemove()`.
  - `PreviewPane({ tag, locale, subject, blocks })` — a `Preview` button (calls `usePreview`), renders subject + a sandboxed `<iframe>`; a 400 → inline error.

- [ ] **Step 1: Write the failing tests** — `BlockCard.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BlockCard } from "./BlockCard.js";

describe("BlockCard", () => {
  it("edits a paragraph's text", () => {
    const onChange = vi.fn();
    render(
      <BlockCard
        block={{ type: "paragraph", text: "hi" }}
        index={0}
        total={2}
        textVars={["displayName"]}
        urlVars={["exploreUrl"]}
        onChange={onChange}
        onMove={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/text/i), {
      target: { value: "hey {displayName}" },
    });
    expect(onChange).toHaveBeenCalledWith({
      type: "paragraph",
      text: "hey {displayName}",
    });
  });

  it("appends a var via a chip", () => {
    const onChange = vi.fn();
    render(
      <BlockCard
        block={{ type: "paragraph", text: "hi " }}
        index={0}
        total={2}
        textVars={["displayName"]}
        urlVars={[]}
        onChange={onChange}
        onMove={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "{displayName}" }));
    expect(onChange).toHaveBeenCalledWith({
      type: "paragraph",
      text: "hi {displayName}",
    });
  });

  it("moves and removes", () => {
    const onMove = vi.fn();
    const onRemove = vi.fn();
    render(
      <BlockCard
        block={{ type: "divider" }}
        index={1}
        total={3}
        textVars={[]}
        urlVars={[]}
        onChange={vi.fn()}
        onMove={onMove}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByLabelText(/move up/i));
    expect(onMove).toHaveBeenCalledWith(-1);
    fireEvent.click(screen.getByLabelText(/remove/i));
    expect(onRemove).toHaveBeenCalled();
  });
});
```

`PreviewPane.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PreviewPane } from "./PreviewPane.js";

const mutate = vi.fn();
vi.mock("../../data/useAdminEmailTemplates.js", () => ({
  usePreview: () => ({ mutate, isPending: false }),
}));

describe("PreviewPane", () => {
  it("renders the returned html + subject after Preview", async () => {
    mutate.mockImplementation((_vars, { onSuccess }) =>
      onSuccess({ subject: "Hi Riku", html: "<p>hello</p>", text: "hello" }),
    );
    render(
      <PreviewPane
        tag="weekly-digest"
        locale="en"
        subject="Hi {displayName}"
        blocks={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    await waitFor(() =>
      expect(screen.getByText("Hi Riku")).toBeInTheDocument(),
    );
    expect(screen.getByTitle(/email preview/i)).toBeInTheDocument(); // the iframe
  });
});
```

- [ ] **Step 2: Run → fail:** `pnpm --filter @tarmoto/admin exec vitest run src/components/email-template`

- [ ] **Step 3: Implement.** `VarChips.tsx`:

```tsx
export function VarChips({
  vars,
  onInsert,
}: {
  vars: string[];
  onInsert: (token: string) => void;
}) {
  if (vars.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {vars.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onInsert(`{${v}}`)}
          className="rounded border border-line px-1.5 py-0.5 font-mono text-xs text-fg-dim transition hover:border-accent hover:text-ink"
        >
          {`{${v}}`}
        </button>
      ))}
    </div>
  );
}
```

`BlockCard.tsx` (var chips **append** to the field — no ref/caret):

```tsx
import type { components } from "@tarmoto/openapi-client";
import { Button, Input, Select } from "@tarmoto/ui";
import { VarChips } from "./VarChips.js";

export type EditorBlock = components["schemas"]["EmailBlockDto"];

interface BlockCardProps {
  block: EditorBlock;
  index: number;
  total: number;
  textVars: string[];
  urlVars: string[];
  onChange: (next: EditorBlock) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}

export function BlockCard({
  block,
  index,
  total,
  textVars,
  urlVars,
  onChange,
  onMove,
  onRemove,
}: BlockCardProps) {
  const patch = (partial: Partial<EditorBlock>) =>
    onChange({ ...block, ...partial });

  return (
    <div className="rounded-lg border border-line bg-paper p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-xs uppercase text-fg-dim">
          {block.type}
        </span>
        <div className="flex gap-1">
          <Button
            variant="secondary"
            size="sm"
            ariaLabel="Move up"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            ↑
          </Button>
          <Button
            variant="secondary"
            size="sm"
            ariaLabel="Move down"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </Button>
          <Button
            variant="secondary"
            size="sm"
            ariaLabel="Remove block"
            onClick={onRemove}
          >
            ✕
          </Button>
        </div>
      </div>

      {(block.type === "heading" || block.type === "paragraph") && (
        <div>
          <Input
            value={block.text ?? ""}
            onChange={(v) => patch({ text: v })}
            ariaLabel="Text"
            placeholder="Text (may contain {vars})"
          />
          <VarChips
            vars={textVars}
            onInsert={(token) => patch({ text: (block.text ?? "") + token })}
          />
        </div>
      )}

      {block.type === "stat-row" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            value={block.label ?? ""}
            onChange={(v) => patch({ label: v })}
            ariaLabel="Label"
            placeholder="Label"
          />
          <div>
            <Input
              value={block.value ?? ""}
              onChange={(v) => patch({ value: v })}
              ariaLabel="Value"
              placeholder="Value (may contain {vars})"
            />
            <VarChips
              vars={textVars}
              onInsert={(token) =>
                patch({ value: (block.value ?? "") + token })
              }
            />
          </div>
        </div>
      )}

      {block.type === "button" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            value={block.label ?? ""}
            onChange={(v) => patch({ label: v })}
            ariaLabel="Button label"
            placeholder="Button label"
          />
          <Select
            value={block.urlVar ?? ""}
            onChange={(v) => patch({ urlVar: v })}
            ariaLabel="Button link"
          >
            <option value="" disabled>
              Choose a link…
            </option>
            {urlVars.map((u) => (
              <option key={u} value={u}>{`{${u}}`}</option>
            ))}
          </Select>
        </div>
      )}

      {(block.type === "divider" || block.type === "spacer") && (
        <p className="text-xs text-fg-dim">
          No content — renders a {block.type}.
        </p>
      )}
    </div>
  );
}
```

`PreviewPane.tsx`:

```tsx
import { useState } from "react";
import type { components } from "@tarmoto/openapi-client";
import { Alert, Button } from "@tarmoto/ui";
import { usePreview } from "../../data/useAdminEmailTemplates.js";

type PreviewResponse = components["schemas"]["PreviewResponseDto"];

export function PreviewPane({
  tag,
  locale,
  subject,
  blocks,
}: {
  tag: string;
  locale: string;
  subject: string;
  blocks: components["schemas"]["EmailBlockDto"][];
}) {
  const preview = usePreview();
  const [result, setResult] = useState<PreviewResponse | null>(null);
  const [tab, setTab] = useState<"html" | "text">("html");
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    preview.mutate(
      { params: { path: { tag, locale } }, body: { subject, blocks } },
      {
        onSuccess: (res: PreviewResponse) => setResult(res),
        onError: (err: unknown) =>
          setError(
            (err as { message?: string } | undefined)?.message ??
              "Preview failed — check the fields.",
          ),
      },
    );
  }

  return (
    <div className="rounded-lg border border-line p-3">
      <div className="mb-2 flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={preview.isPending}
          onClick={run}
        >
          Preview
        </Button>
        {result ? (
          <div className="ml-auto flex gap-1">
            <Button
              variant={tab === "html" ? "primary" : "secondary"}
              size="sm"
              onClick={() => setTab("html")}
            >
              HTML
            </Button>
            <Button
              variant={tab === "text" ? "primary" : "secondary"}
              size="sm"
              onClick={() => setTab("text")}
            >
              Text
            </Button>
          </div>
        ) : null}
      </div>
      {error ? (
        <Alert intent="danger" title={error} compact className="mb-2" />
      ) : null}
      {result ? (
        <div>
          <p className="mb-2 text-sm">
            <span className="text-fg-dim">Subject: </span>
            <span className="text-ink">{result.subject}</span>
          </p>
          {tab === "html" ? (
            <iframe
              title="Email preview"
              srcDoc={result.html}
              sandbox=""
              className="h-[480px] w-full rounded border border-line bg-white"
            />
          ) : (
            <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded border border-line bg-paper p-3 text-xs text-ink">
              {result.text}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Typecheck:** `pnpm --filter @tarmoto/admin exec tsc --noEmit 2>&1 | grep -E 'email-template/' || echo clean`
- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/components/email-template
git commit -m "feat(admin): block-editor building blocks (var chips, block card, preview pane)"
```

---

### Task 6: Admin — `EmailTemplateEditor` (assembly, actions, role gating, dirty guard)

**Files:**

- Create: `apps/admin/src/screens/EmailTemplateEditor.tsx`
- Test: `apps/admin/src/screens/EmailTemplateEditor.test.tsx`

**Interfaces:**

- Consumes: `useEmailTemplate/useSaveDraft/useTestSend/usePublish/useReset/usePreview` (T3); `BlockCard`/`VarChips`/`PreviewPane` (T5); `useAdminAuth` (`../auth/useAdminAuth.js`, `.user.role`); `canAccess` (`../lib/roleRank.js`); `Dialog` (`../components/Dialog.js`); `@tarmoto/ui` (`Button`, `Input`, `Alert`, `Pill`).
- Produces: `EmailTemplateEditor({ tag, locale, onBack }: { tag: string; locale: string; onBack: () => void })`.

- [ ] **Step 1: Write the failing test** (role gate is the key assertion):

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EmailTemplateEditor } from "./EmailTemplateEditor.js";

const detail = {
  tag: "weekly-digest",
  locale: "en",
  subject: "Hi {displayName}",
  blocks: [{ type: "paragraph", text: "hello" }],
  status: "none",
  version: 0,
  whitelist: { textVars: ["displayName"], urlVars: ["exploreUrl"] },
};
const saveMutate = vi.fn();
const publishMutate = vi.fn();
vi.mock("../data/useAdminEmailTemplates.js", () => ({
  useEmailTemplate: () => ({
    data: detail,
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
  useSaveDraft: () => ({ mutate: saveMutate, isPending: false }),
  useTestSend: () => ({ mutate: vi.fn(), isPending: false }),
  usePublish: () => ({ mutate: publishMutate, isPending: false }),
  useReset: () => ({ mutate: vi.fn(), isPending: false }),
  usePreview: () => ({ mutate: vi.fn(), isPending: false }),
}));
let role = "support";
vi.mock("../auth/useAdminAuth.js", () => ({
  useAdminAuth: () => ({ user: { role } }),
}));

describe("EmailTemplateEditor", () => {
  beforeEach(() => {
    saveMutate.mockReset();
    publishMutate.mockReset();
  });

  it("hides Publish/Reset for support and shows Save draft", () => {
    role = "support";
    render(
      <EmailTemplateEditor tag="weekly-digest" locale="en" onBack={vi.fn()} />,
    );
    expect(
      screen.getByRole("button", { name: /save draft/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^publish$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^reset$/i }),
    ).not.toBeInTheDocument();
  });

  it("shows Publish for super_admin and confirms before publishing", async () => {
    role = "super_admin";
    render(
      <EmailTemplateEditor tag="weekly-digest" locale="en" onBack={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^publish$/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /publish now/i }),
    );
    await waitFor(() => expect(publishMutate).toHaveBeenCalled());
  });

  it("saves the draft with the edited body", () => {
    role = "support";
    render(
      <EmailTemplateEditor tag="weekly-digest" locale="en" onBack={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /save draft/i }));
    expect(saveMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { path: { tag: "weekly-digest", locale: "en" } },
        body: expect.objectContaining({ subject: "Hi {displayName}" }),
      }),
      expect.anything(),
    );
  });
});
```

- [ ] **Step 2: Run → fail:** `pnpm --filter @tarmoto/admin exec vitest run src/screens/EmailTemplateEditor.test.tsx`

- [ ] **Step 3: Implement** `EmailTemplateEditor.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { components } from "@tarmoto/openapi-client";
import { Alert, Button, Input, Pill } from "@tarmoto/ui";
import { Dialog } from "../components/Dialog.js";
import {
  BlockCard,
  type EditorBlock,
} from "../components/email-template/BlockCard.js";
import { VarChips } from "../components/email-template/VarChips.js";
import { PreviewPane } from "../components/email-template/PreviewPane.js";
import { useAdminAuth } from "../auth/useAdminAuth.js";
import { canAccess } from "../lib/roleRank.js";
import {
  useEmailTemplate,
  useSaveDraft,
  useTestSend,
  usePublish,
  useReset,
} from "../data/useAdminEmailTemplates.js";

const BLOCK_TYPES: EditorBlock["type"][] = [
  "heading",
  "paragraph",
  "button",
  "stat-row",
  "divider",
  "spacer",
];

function emptyBlock(type: EditorBlock["type"]): EditorBlock {
  switch (type) {
    case "heading":
    case "paragraph":
      return { type, text: "" };
    case "stat-row":
      return { type, label: "", value: "" };
    case "button":
      return { type, label: "", urlVar: "" };
    default:
      return { type };
  }
}
function serverMessage(err: unknown, fallback: string): string {
  return (err as { message?: string } | undefined)?.message ?? fallback;
}

export function EmailTemplateEditor({
  tag,
  locale,
  onBack,
}: {
  tag: string;
  locale: string;
  onBack: () => void;
}) {
  const { data, isPending, error, refetch } = useEmailTemplate(tag, locale);
  const role = useAdminAuth().user?.role;
  const isSuper = role ? canAccess(role, "super_admin") : false;

  const saveDraft = useSaveDraft();
  const testSend = useTestSend();
  const publish = usePublish();
  const reset = useReset();

  const [subject, setSubject] = useState("");
  const [blocks, setBlocks] = useState<EditorBlock[]>([]);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{
    kind: "success" | "danger";
    text: string;
  } | null>(null);
  const [confirm, setConfirm] = useState<null | "publish" | "reset">(null);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    if (!data) return;
    setSubject(data.subject);
    setBlocks(data.blocks);
    setDirty(false);
  }, [data]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const whitelist = data?.whitelist ?? { textVars: [], urlVars: [] };
  const status = data?.status ?? "none";
  const params = { path: { tag, locale } };

  const setSubjectDirty = (v: string) => {
    setSubject(v);
    setDirty(true);
  };
  function setBlock(i: number, next: EditorBlock) {
    setBlocks((b) => b.map((x, j) => (j === i ? next : x)));
    setDirty(true);
  }
  function moveBlock(i: number, dir: -1 | 1) {
    setBlocks((b) => {
      const j = i + dir;
      if (j < 0 || j >= b.length) return b;
      const copy = [...b];
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      return copy;
    });
    setDirty(true);
  }
  function removeBlock(i: number) {
    setBlocks((b) => b.filter((_, j) => j !== i));
    setDirty(true);
  }
  function addBlock(type: EditorBlock["type"]) {
    setBlocks((b) => [...b, emptyBlock(type)]);
    setDirty(true);
    setAddOpen(false);
  }

  function handleSave() {
    saveDraft.mutate(
      { params, body: { subject, blocks } },
      {
        onSuccess: () => {
          setMsg({ kind: "success", text: "Draft saved." });
          setDirty(false);
          void refetch();
        },
        onError: (err: unknown) =>
          setMsg({
            kind: "danger",
            text: serverMessage(err, "Failed to save the draft."),
          }),
      },
    );
  }
  function handleTestSend() {
    testSend.mutate(
      { params, body: { subject, blocks } },
      {
        onSuccess: (res: { status: string }) =>
          setMsg({
            kind: res.status === "sent" ? "success" : "danger",
            text:
              res.status === "sent"
                ? "Test email sent to your address."
                : "Test send failed — check the provider.",
          }),
        onError: (err: unknown) =>
          setMsg({
            kind: "danger",
            text: serverMessage(err, "Failed to send the test."),
          }),
      },
    );
  }
  function doPublish() {
    publish.mutate(
      { params },
      {
        onSuccess: () => {
          setMsg({
            kind: "success",
            text: "Published. This override is now live.",
          });
          setConfirm(null);
          setDirty(false);
          void refetch();
        },
        onError: (err: unknown) => {
          setMsg({
            kind: "danger",
            text: serverMessage(err, "Failed to publish."),
          });
          setConfirm(null);
        },
      },
    );
  }
  function doReset() {
    reset.mutate(
      { params },
      {
        onSuccess: () => {
          setMsg({
            kind: "success",
            text: "Override removed — the code email renders again.",
          });
          setConfirm(null);
          void refetch();
        },
        onError: (err: unknown) => {
          setMsg({
            kind: "danger",
            text: serverMessage(err, "Failed to reset."),
          });
          setConfirm(null);
        },
      },
    );
  }
  function handleBack() {
    if (
      dirty &&
      !window.confirm("You have unsaved changes. Leave without saving?")
    )
      return;
    onBack();
  }

  const legalSensitive = tag.startsWith("account-deletion");
  if (error)
    return <Alert intent="danger" title="Failed to load this template." />;

  return (
    <section>
      <div className="mb-4 flex items-center gap-3">
        <Button variant="secondary" size="sm" onClick={handleBack}>
          ← Templates
        </Button>
        <h2 className="text-lg font-extrabold text-ink">{data?.tag ?? tag}</h2>
        <Pill variant={status === "published" ? "accent" : "ghost"}>
          {status === "published"
            ? "Live"
            : status === "draft"
              ? "Draft"
              : "Default"}
        </Pill>
        {data ? (
          <span className="text-xs text-fg-dim">v{data.version}</span>
        ) : null}
      </div>

      {msg ? (
        <Alert intent={msg.kind} title={msg.text} compact className="mb-4" />
      ) : null}

      {isPending ? (
        <p className="text-sm text-fg-dim">Loading…</p>
      ) : (
        <div className="grid gap-4">
          <div>
            <label className="mb-1 block text-sm font-bold text-ink">
              Subject
            </label>
            <Input
              value={subject}
              onChange={setSubjectDirty}
              ariaLabel="Subject"
              placeholder="Subject (may contain {vars})"
            />
            <VarChips
              vars={whitelist.textVars}
              onInsert={(token) => setSubjectDirty(subject + token)}
            />
          </div>

          <div className="flex flex-col gap-2">
            {blocks.map((block, i) => (
              <BlockCard
                key={i}
                block={block}
                index={i}
                total={blocks.length}
                textVars={whitelist.textVars}
                urlVars={whitelist.urlVars}
                onChange={(next) => setBlock(i, next)}
                onMove={(dir) => moveBlock(i, dir)}
                onRemove={() => removeBlock(i)}
              />
            ))}
            <div className="relative">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setAddOpen((o) => !o)}
              >
                + Add block
              </Button>
              {addOpen ? (
                <div className="absolute z-10 mt-1 flex flex-col rounded-lg border border-line bg-cream p-1 shadow">
                  {BLOCK_TYPES.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => addBlock(t)}
                      className="rounded px-3 py-1 text-left text-sm text-ink hover:bg-paper"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <PreviewPane
            tag={tag}
            locale={locale}
            subject={subject}
            blocks={blocks}
          />

          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={saveDraft.isPending}
              onClick={handleSave}
            >
              Save draft
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={testSend.isPending}
              onClick={handleTestSend}
            >
              Send test to me
            </Button>
            {isSuper ? (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setConfirm("publish")}
                >
                  Publish
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setConfirm("reset")}
                >
                  Reset
                </Button>
              </>
            ) : null}
          </div>
        </div>
      )}

      <Dialog
        open={confirm === "publish"}
        title="Publish this override?"
        onClose={() => setConfirm(null)}
        busy={publish.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirm(null)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={publish.isPending}
              onClick={doPublish}
            >
              Publish now
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">
          This makes the override the live email for <strong>{tag}</strong>.
          Save your draft first if you haven't.
        </p>
        {legalSensitive ? (
          <Alert
            intent="warning"
            compact
            className="mt-3"
            title="This is a GDPR/legal notice — check the wording carefully before publishing."
          />
        ) : null}
      </Dialog>

      <Dialog
        open={confirm === "reset"}
        title="Remove the published override?"
        onClose={() => setConfirm(null)}
        busy={reset.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirm(null)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={reset.isPending}
              onClick={doReset}
            >
              Remove override
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">
          The code email will render again for <strong>{tag}</strong>. Your
          draft (if any) is kept.
        </p>
      </Dialog>
    </section>
  );
}
```

(`useTestSend`'s `onSuccess` receives `TestSendResponseDto` `{ status: "sent" | "failed" }`; the `{ status: string }` annotation is loose but assignable. `Button` `primary`/`secondary` are real variants; keep the `ariaLabel`s so the tests resolve by name.)

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Typecheck:** `pnpm --filter @tarmoto/admin exec tsc --noEmit 2>&1 | grep -E 'EmailTemplateEditor' || echo clean`
- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/screens/EmailTemplateEditor.tsx apps/admin/src/screens/EmailTemplateEditor.test.tsx
git commit -m "feat(admin): email-template editor page with role-gated publish/reset"
```

---

### Task 7: Admin — `EmailTemplatesScreen` (list + list/editor sub-router)

**Files:**

- Create: `apps/admin/src/screens/EmailTemplatesScreen.tsx`
- Test: `apps/admin/src/screens/EmailTemplatesScreen.test.tsx`

**Interfaces:**

- Consumes: `useEmailTemplates` (T3); `useHashRoute` (T4, `.params`/`.navigate`); `EmailTemplateEditor` (T6); `@tarmoto/ui` (`PageHeader`, `DataTable`, `DataTableColumn`, `Pill`, `Alert`).
- Produces: the screen rendered by `App.tsx` for `active === "email-templates"`. `params` has a tag → `<EmailTemplateEditor tag locale onBack />`; else the list.

- [ ] **Step 1: Write the failing test:**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmailTemplatesScreen } from "./EmailTemplatesScreen.js";

vi.mock("../data/useAdminEmailTemplates.js", () => ({
  useEmailTemplates: () => ({
    data: [
      {
        tag: "weekly-digest",
        label: "Weekly digest",
        hasDraft: false,
        hasPublished: true,
        legalSensitive: false,
      },
      {
        tag: "account-deletion-scheduled",
        label: "Account deletion scheduled",
        hasDraft: true,
        hasPublished: false,
        legalSensitive: true,
      },
    ],
    isPending: false,
    error: null,
  }),
}));
const navigate = vi.fn();
vi.mock("../app/routes.js", () => ({
  useHashRoute: () => ({ active: "email-templates", params: [], navigate }),
  routes: [],
}));

describe("EmailTemplatesScreen (list)", () => {
  beforeEach(() => navigate.mockReset());
  it("lists templates with Live/Draft status and a legal badge", () => {
    render(<EmailTemplatesScreen />);
    expect(screen.getByText("Weekly digest")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText(/legal/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run → fail:** `pnpm --filter @tarmoto/admin exec vitest run src/screens/EmailTemplatesScreen.test.tsx`

- [ ] **Step 3: Implement** `EmailTemplatesScreen.tsx`:

```tsx
import type { components } from "@tarmoto/openapi-client";
import {
  Alert,
  DataTable,
  type DataTableColumn,
  PageHeader,
  Pill,
} from "@tarmoto/ui";
import { useHashRoute } from "../app/routes.js";
import { useEmailTemplates } from "../data/useAdminEmailTemplates.js";
import { EmailTemplateEditor } from "./EmailTemplateEditor.js";

type TemplateRow = components["schemas"]["EmailTemplateSummaryDto"];

function statusOf(row: TemplateRow): {
  label: string;
  variant: "accent" | "ghost";
} {
  if (row.hasPublished) return { label: "Live", variant: "accent" };
  if (row.hasDraft) return { label: "Draft", variant: "ghost" };
  return { label: "Default", variant: "ghost" };
}

export function EmailTemplatesScreen() {
  // Both hooks called unconditionally (rules of hooks) before branching.
  const { params, navigate } = useHashRoute();
  const templates = useEmailTemplates();

  const editorTag = params[0];
  if (editorTag) {
    return (
      <EmailTemplateEditor
        tag={editorTag}
        locale={params[1] ?? "en"}
        onBack={() => navigate("email-templates")}
      />
    );
  }

  const { data, isPending, error } = templates;
  const rows: TemplateRow[] = data ?? [];

  const columns: ReadonlyArray<DataTableColumn<TemplateRow>> = [
    { key: "label", label: "Template", primary: true },
    {
      key: "status",
      label: "Status",
      size: "140px",
      render: (row) => {
        const s = statusOf(row);
        return <Pill variant={s.variant}>{s.label}</Pill>;
      },
    },
    {
      key: "legalSensitive",
      label: "",
      size: "160px",
      render: (row) =>
        row.legalSensitive ? (
          <Pill variant="danger">⚠ Legal-sensitive</Pill>
        ) : null,
    },
  ];

  return (
    <section>
      <PageHeader title="Email Templates" />
      {error ? (
        <Alert
          intent="danger"
          title="Failed to load templates."
          className="my-4"
        />
      ) : null}
      <DataTable
        columns={columns}
        rows={isPending ? [] : rows}
        rowKey={(row) => row.tag}
        onRowClick={(row) => navigate(`email-templates/${row.tag}/en`)}
        emptyState={
          <span className="text-sm text-fg-dim">
            {isPending ? "—" : "No templates."}
          </span>
        }
        ariaLabel="Editable email templates"
      />
    </section>
  );
}
```

(Both hooks are called unconditionally at the top before the editor branch — that's the rules-of-hooks-clean shape shown above.)

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Typecheck + lint:** `pnpm --filter @tarmoto/admin exec tsc --noEmit 2>&1 | grep -E 'EmailTemplatesScreen' || echo clean` and `pnpm --filter @tarmoto/admin exec eslint src/screens/EmailTemplatesScreen.tsx`
- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/screens/EmailTemplatesScreen.tsx apps/admin/src/screens/EmailTemplatesScreen.test.tsx
git commit -m "feat(admin): email-templates list screen + list/editor sub-router"
```

---

### Task 8: Admin — wire `App.tsx` + full verify + PR

**Files:**

- Modify: `apps/admin/src/app/App.tsx`

- [ ] **Step 1: Wire the screen.** Import beside the other screens:

```ts
import { EmailTemplatesScreen } from "../screens/EmailTemplatesScreen.js";
```

Add the branch right after the `email` branch in the `active === …` ternary:

```tsx
) : active === "email" ? (
  <EmailScreen />
) : active === "email-templates" ? (
  <EmailTemplatesScreen />
) : active === "poi-imports" ? (
```

- [ ] **Step 2: Full admin verify:**

```bash
pnpm --filter @tarmoto/admin exec tsc --noEmit
pnpm --filter @tarmoto/admin exec vitest run
pnpm --filter @tarmoto/admin build
```

Expected: all clean/green.

- [ ] **Step 3: Backend verify:**

```bash
pnpm --filter @tarmoto/backend exec jest src/modules/admin-email
pnpm --filter @tarmoto/backend build
```

Expected: green/clean.

- [ ] **Step 4: Confirm NO contract churn:**

```bash
git status --porcelain packages/openapi packages/postman 2>/dev/null
```

Expected: empty. Revert any change here — Phase 2b has no contract change.

- [ ] **Step 5: Commit + push + PR:**

```bash
git add apps/admin/src/app/App.tsx
git commit -m "feat(admin): mount the email-templates screen in the admin shell"
git push -u origin feat/email-template-editor-ui
gh pr create --base main --title "feat(cross): admin email-template editor UI (Phase 2b)" --body "<summary per AGENTS.md: what shipped, roles, seed-no-contract-change, test evidence, links Phase 2a #988>"
```

Add the `cross` scope label (the PR spans `backend` seed + `admin` UI).

---

## Notes for the executor

- **Verify `@tarmoto/ui` prop names** against `packages/ui` where in doubt — this plan mirrors `EmailScreen.tsx` (the source of truth for the kit's API). Confirmed here: `Button` (`variant` incl. `primary`/`secondary`, `size`, `loading`, `disabled`, `onClick`, `ariaLabel`), `Input`/`Select` (`value`, `onChange:(value)=>void`, `ariaLabel`, `placeholder`), `DataTable` (`columns`, `rows`, `rowKey`, `onRowClick`, `emptyState`, `ariaLabel`), `Pill` (`variant`), `Alert` (`intent`, `title`, `compact`, `className`), `PageHeader` (`title`).
- **Admin CI type-checks test files** — run `pnpm --filter @tarmoto/admin exec tsc --noEmit` (not just `vitest`) after editing any `.tsx`/`.test.tsx`.
- **No `openapi:gen`/`postman:gen`** — the seed rides on the existing DTO shape.
- **Rules of hooks:** in `EmailTemplatesScreen`, call `useHashRoute()` and `useEmailTemplates()` unconditionally before branching to the editor (see the note in Task 7).
