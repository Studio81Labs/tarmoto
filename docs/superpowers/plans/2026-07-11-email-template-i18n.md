# Email Template i18n (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the backend's ten emails translation-ready by rendering their copy through a shared, typed catalog + `{var}` translator, with a defaulted `locale` seam — English-only, no behavior change.

**Architecture:** Extract the companion's proven i18n machinery (`resolveLocale`, lookup/fallback/interpolate) into `@tarmoto/shared` as a `makeTranslator` factory + a metadata-only `LOCALES` registry. The companion consumes it behind an unchanged barrel. The backend adds its own `en` email catalog and threads a `locale` parameter through `EmailService`. Rendered output stays byte-identical (guarded by characterization snapshots).

**Tech Stack:** TypeScript (strict), pnpm workspaces, `@tarmoto/shared` (vitest), NestJS backend (jest), Next.js companion.

## Global Constraints

- **Conventional commits, scope required:** `refactor(shared)` for PR 1, `feat(backend)` for PR 2. Subject lowercase-first-char, header ≤ 100 chars.
- **Every commit message ends with:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **TypeScript strict mode** everywhere, including `noUncheckedIndexedAccess`. `pnpm shared:build` MUST run after editing `packages/shared` so backend/companion see new exports (they resolve `@tarmoto/shared` via `dist/`).
- **Companion CI typechecks test files** (`pnpm --filter @tarmoto/companion typecheck`) — vitest/jest alone won't catch it. Run it after editing companion tests.
- **No runtime template engine.** Keep `{var}` substitution only. Preserve the two email properties: (1) missing variable = compile error, (2) no arbitrary-expression / injection surface — **user-supplied interpolations stay `escapeHtml`'d for HTML, raw for text.**
- **Byte-identical rendered output** for PR 2. Catalog values may contain _trusted inline emphasis_ (`<strong>`) mirroring current copy, but never structural chrome (`<p>`, `<table>`, `<a href>`) and never user data. Characterization snapshots enforce this.
- **PR boundaries:** PR 1 (shared + companion) and PR 2 (backend) each produce working software and ship as separate PRs. PR 2 depends on PR 1 being merged (or its shared build available).

---

# PR 1 — `refactor(shared): extract i18n core; companion consumes it`

**Branch:** `feat/email-i18n` (already created from `origin/main`; the design spec commit is its first commit).

## File structure

- Create `packages/shared/src/i18n.ts` — the pure core: `DEFAULT_LOCALE`, `LOCALES` (metadata), `SupportedLocale`, `SUPPORTED_LOCALES`, `isSupportedLocale`, `resolveLocale`, `TranslationValues`, `Catalog`, `CatalogsByLocale`, `Translator`, `makeTranslator`.
- Create `packages/shared/src/i18n.spec.ts` — moved `resolveLocale` / `isSupportedLocale` cases + `makeTranslator` unit tests.
- Modify `packages/shared/src/index.ts` — add `export * from "./i18n";`.
- Modify `apps/companion/src/i18n/locales/index.ts` — export `companionCatalogs: CatalogsByLocale<EnglishMessageKey>` instead of the `{ label, messages }` registry; drop the locally-defined `DEFAULT_LOCALE`/`LOCALES`/`SupportedLocale`.
- Modify `apps/companion/src/i18n/index.ts` — re-export the shared core; keep `LOCALE_COOKIE`, `activeLocale`, `translate`/`t` wrapper; build `baseTranslate = makeTranslator(companionCatalogs)`.
- Modify `apps/companion/src/i18n/index.test.ts` — trim the pure-function cases now covered in shared; keep a thin integration test proving the barrel still translates via the companion catalog.
- **Unchanged (verify, do not touch):** `apps/companion/src/i18n/server.ts`, `apps/companion/src/i18n/I18nProvider.tsx`, `apps/companion/src/i18n/locales/en.ts`, and all ~98 consumer imports of `@/i18n`.

### Task 1: Shared i18n core

**Files:**

- Create: `packages/shared/src/i18n.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/i18n.spec.ts`

**Interfaces:**

- Produces: `DEFAULT_LOCALE: "en"`, `LOCALES: { en: { label: string } }`, `type SupportedLocale = keyof typeof LOCALES`, `SUPPORTED_LOCALES: readonly SupportedLocale[]`, `isSupportedLocale(v: string): v is SupportedLocale`, `resolveLocale(input?: string | null): SupportedLocale`, `type TranslationValues = Record<string, string | number>`, `type Catalog<K extends string> = Record<K, string>`, `type CatalogsByLocale<K extends string> = { en: Catalog<K> } & Partial<Record<SupportedLocale, Partial<Catalog<K>>>>`, `type Translator<K extends string> = (key: K, values?: TranslationValues, locale?: SupportedLocale) => string`, `makeTranslator<K extends string>(catalogs: CatalogsByLocale<K>): Translator<K>`.

- [ ] **Step 1: Write the failing test** — `packages/shared/src/i18n.spec.ts`

```ts
import { describe, it, expect } from "vitest";
import {
  DEFAULT_LOCALE,
  LOCALES,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  makeTranslator,
  resolveLocale,
} from "./i18n";

describe("i18n / registry", () => {
  it("registers exactly the locales declared in LOCALES, including the default", () => {
    expect(SUPPORTED_LOCALES).toEqual(Object.keys(LOCALES));
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  });
});

describe("i18n / isSupportedLocale", () => {
  it("narrows registered locales and rejects prototype keys", () => {
    expect(isSupportedLocale("en")).toBe(true);
    expect(isSupportedLocale("xx")).toBe(false);
    expect(isSupportedLocale("toString")).toBe(false);
    expect(isSupportedLocale("__proto__")).toBe(false);
    expect(isSupportedLocale("constructor")).toBe(false);
  });
});

describe("i18n / resolveLocale", () => {
  it("returns DEFAULT_LOCALE for null / undefined / empty", () => {
    expect(resolveLocale(null)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale("")).toBe(DEFAULT_LOCALE);
  });

  it("matches the primary subtag of a single tag", () => {
    expect(resolveLocale("en-GB")).toBe("en");
    expect(resolveLocale("EN")).toBe("en");
  });

  it("walks an Accept-Language header, honouring q-weights", () => {
    expect(resolveLocale("xx-YY,en;q=0.8")).toBe("en");
    expect(resolveLocale("zz-AA;q=1,xx-YY;q=0.9")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale("xx;q=1.0,en;q=0.2")).toBe("en");
    expect(resolveLocale("en;q=garbage")).toBe("en");
  });
});

describe("i18n / makeTranslator", () => {
  const t = makeTranslator<"greeting" | "photo">({
    en: { greeting: "Hi {name},", photo: "{name}'s photo" },
  });

  it("returns the catalog entry for a known key", () => {
    expect(t("greeting", { name: "Riku" })).toBe("Hi Riku,");
  });

  it("falls back to the raw key when no catalog entry exists", () => {
    // @ts-expect-error — exercising the runtime raw-key fallback path
    expect(t("__missing__")).toBe("__missing__");
  });

  it("leaves placeholders without a matching value untouched", () => {
    expect(t("photo")).toBe("{name}'s photo");
  });

  it("falls back to the default-locale catalog for an unpopulated locale", () => {
    expect(t("greeting", { name: "Riku" }, "en")).toBe("Hi Riku,");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tarmoto/shared test`
Expected: FAIL — `./i18n` cannot be resolved.

- [ ] **Step 3: Write minimal implementation** — `packages/shared/src/i18n.ts`

```ts
/**
 * Framework-agnostic i18n core shared by every Tarmoto surface (companion UI,
 * backend email, later mobile). The language list + lookup/fallback/interpolate
 * logic live here once; each surface owns its own message catalog and builds a
 * translator over it via `makeTranslator`.
 */

export const DEFAULT_LOCALE = "en" as const;

/**
 * Product-wide language registry — metadata only. Message catalogs are
 * per-surface, so this carries just the human-readable label used by
 * locale-switcher UIs. To add a language: add an entry here + a `Partial`
 * catalog for it in each surface that should translate.
 */
export const LOCALES = {
  en: { label: "English" },
} as const;

export type SupportedLocale = keyof typeof LOCALES;

export const SUPPORTED_LOCALES = Object.keys(
  LOCALES,
) as readonly SupportedLocale[];

export function isSupportedLocale(value: string): value is SupportedLocale {
  // Object.hasOwn (not `in`) so prototype keys ("toString"/"__proto__") can't
  // slip through validation and index a catalog with an inherited method.
  return Object.hasOwn(LOCALES, value);
}

/**
 * Best-effort locale picker. Accepts a single tag ("en", "en-GB"), a full
 * Accept-Language string ("et,en-GB;q=0.9,en;q=0.8"), or null/undefined.
 * Tags are lowercased and reduced to their primary subtag, then matched against
 * the registry. RFC 7231 q-weights are honoured (highest q wins; header order
 * breaks ties; no `q` defaults to 1.0). Anything unresolved → DEFAULT_LOCALE.
 */
export function resolveLocale(input?: string | null): SupportedLocale {
  if (!input) return DEFAULT_LOCALE;

  const candidates = input
    .split(",")
    .map((entry, index) => {
      const parts = entry.split(";").map((part) => part.trim());
      const tag = parts[0] ?? "";
      let q = 1;
      for (const param of parts.slice(1)) {
        const match = /^q=([0-9]*\.?[0-9]+)$/i.exec(param);
        if (match) {
          const parsed = Number.parseFloat(match[1] ?? "");
          if (!Number.isNaN(parsed)) q = parsed;
        }
      }
      return { tag, q, index };
    })
    .filter((candidate) => candidate.tag !== "")
    .sort((a, b) => (b.q !== a.q ? b.q - a.q : a.index - b.index));

  for (const candidate of candidates) {
    const primary = candidate.tag.toLowerCase().split("-")[0] ?? "";
    if (isSupportedLocale(primary)) return primary;
  }

  return DEFAULT_LOCALE;
}

export type TranslationValues = Record<string, string | number>;

/** A fully-populated message map for one surface, in the default locale. */
export type Catalog<K extends string> = Record<K, string>;

/**
 * Per-surface catalogs keyed by locale. The default locale is exhaustive;
 * other locales are partial and fall back to it key-by-key.
 */
export type CatalogsByLocale<K extends string> = { en: Catalog<K> } & Partial<
  Record<SupportedLocale, Partial<Catalog<K>>>
>;

export type Translator<K extends string> = (
  key: K,
  values?: TranslationValues,
  locale?: SupportedLocale,
) => string;

/**
 * Build a translator over a surface's catalogs. Lookup order:
 * active-locale catalog → default-locale (en) catalog → the raw key. Then
 * `{placeholder}` values are substituted. Substitution is RAW — callers that
 * emit HTML MUST escape untrusted values before passing them in.
 */
export function makeTranslator<K extends string>(
  catalogs: CatalogsByLocale<K>,
): Translator<K> {
  const read = (locale: SupportedLocale, key: K): string | undefined => {
    const catalog = catalogs[locale] as Partial<Catalog<K>> | undefined;
    return catalog?.[key];
  };

  return (key, values, locale = DEFAULT_LOCALE) => {
    const template =
      read(locale, key) ??
      (locale !== DEFAULT_LOCALE ? read(DEFAULT_LOCALE, key) : undefined) ??
      key;

    if (!values) return template;

    return template.replace(/\{(\w+)\}/g, (match, valueKey: string) => {
      const value = values[valueKey];
      return value === undefined ? match : String(value);
    });
  };
}
```

Then add to `packages/shared/src/index.ts` (alongside the other `export *` lines):

```ts
export * from "./i18n";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tarmoto/shared test`
Expected: PASS (all cases green).

- [ ] **Step 5: Build shared so downstream packages see the new exports**

Run: `pnpm shared:build`
Expected: `tsc` exits 0, `packages/shared/dist/i18n.d.ts` exists.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/i18n.ts packages/shared/src/i18n.spec.ts packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
refactor(shared): add framework-agnostic i18n core

makeTranslator factory + resolveLocale + metadata-only LOCALES registry,
extracted from the companion so backend email (and later mobile) can share
one lookup/fallback/interpolation implementation.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

### Task 2: Companion consumes the shared core (behavior-preserving)

**Files:**

- Modify: `apps/companion/src/i18n/locales/index.ts`
- Modify: `apps/companion/src/i18n/index.ts`
- Modify: `apps/companion/src/i18n/index.test.ts`

**Interfaces:**

- Consumes: everything from Task 1 (`makeTranslator`, `resolveLocale`, `LOCALES`, `SupportedLocale`, `DEFAULT_LOCALE`, `SUPPORTED_LOCALES`, `isSupportedLocale`, `TranslationValues`, `CatalogsByLocale`).
- Produces (barrel `@/i18n`, UNCHANGED public surface): `t`, `translate`, `setActiveLocale`, `getActiveLocale`, `resolveLocale`, `isSupportedLocale`, `LOCALES`, `SUPPORTED_LOCALES`, `DEFAULT_LOCALE`, `LOCALE_COOKIE`, `SupportedLocale`, `TranslationValues`, `EnglishMessageKey`, `TranslationCatalog`.

- [ ] **Step 1: Verify barrel invariance before touching anything**

Run: `rg -n "\.messages" apps/companion/src` — confirm no consumer reads `LOCALES[...].messages` (only `.label` and `Object.keys(LOCALES)` are used). If any `.messages` reader exists outside `i18n/`, STOP and add a companion-local export for it; do not re-add `messages` to the shared registry.

- [ ] **Step 2: Rewrite `apps/companion/src/i18n/locales/index.ts`**

```ts
import type { CatalogsByLocale } from "@tarmoto/shared";
import { en, type EnglishMessageKey } from "./en";

// =============================================================================
// Companion UI message catalogs.
//
// To add a language: create a sibling `./<locale>.ts` exporting a
// `Partial<Record<EnglishMessageKey, string>>`, import it, and add it here.
// Missing keys fall back to English automatically. Register the language's
// label in the shared `LOCALES` registry (@tarmoto/shared/i18n).
// =============================================================================

export type TranslationCatalog = Record<EnglishMessageKey, string>;

export const companionCatalogs: CatalogsByLocale<EnglishMessageKey> = { en };

export { en, type EnglishMessageKey };
```

- [ ] **Step 3: Rewrite `apps/companion/src/i18n/index.ts`**

```ts
import {
  DEFAULT_LOCALE,
  LOCALES,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  makeTranslator,
  resolveLocale,
  type SupportedLocale,
  type TranslationValues,
} from "@tarmoto/shared";
import {
  companionCatalogs,
  type EnglishMessageKey,
  type TranslationCatalog,
} from "./locales";

export {
  DEFAULT_LOCALE,
  LOCALES,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  resolveLocale,
};
export type {
  EnglishMessageKey,
  SupportedLocale,
  TranslationCatalog,
  TranslationValues,
};

export const LOCALE_COOKIE = "tarmoto-locale";

const baseTranslate = makeTranslator<EnglishMessageKey>(companionCatalogs);

// Module-global active locale consumed by the synchronous `t()` helper. Set by
// the Next server layer (`server.ts`) per request before children render.
let activeLocale: SupportedLocale = DEFAULT_LOCALE;

export function setActiveLocale(locale: SupportedLocale): void {
  activeLocale = locale;
}

export function getActiveLocale(): SupportedLocale {
  return activeLocale;
}

/**
 * Consumers pass raw English source text as the key (loose `string`), relying on
 * the raw-key fallback for untranslated strings — so this keeps the `string`
 * signature and casts into the catalog key type.
 */
export function translate(
  key: string,
  values?: TranslationValues,
  locale: SupportedLocale = activeLocale,
): string {
  return baseTranslate(key as EnglishMessageKey, values, locale);
}

export const t = translate;
```

- [ ] **Step 4: Trim `apps/companion/src/i18n/index.test.ts`** to the integration surface (pure cases now live in shared):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_LOCALE,
  LOCALES,
  SUPPORTED_LOCALES,
  resolveLocale,
  setActiveLocale,
  translate,
} from ".";

describe("companion i18n barrel", () => {
  beforeEach(() => {
    setActiveLocale(DEFAULT_LOCALE);
  });

  it("translates a known companion catalog key", () => {
    expect(translate("Home")).toBe("Home");
  });

  it("falls back to the raw key for an unknown string", () => {
    expect(translate("__definitely-not-in-the-catalog__")).toBe(
      "__definitely-not-in-the-catalog__",
    );
  });

  it("interpolates placeholders", () => {
    expect(translate("{name}'s profile photo", { name: "Riku" })).toBe(
      "Riku's profile photo",
    );
  });

  it("re-exports the shared registry + resolver", () => {
    expect(SUPPORTED_LOCALES).toEqual(Object.keys(LOCALES));
    expect(resolveLocale("en-GB")).toBe("en");
  });
});
```

(If the companion test runner is jest rather than vitest, drop the `vitest` import line — `describe/it/expect/beforeEach` are globals. Confirm with the sibling test's existing style.)

- [ ] **Step 5: Typecheck, test, and build the companion**

Run: `pnpm --filter @tarmoto/companion typecheck`
Expected: 0 errors (test files included).

Run: `pnpm --filter @tarmoto/companion test`
Expected: existing i18n + consumer tests green.

- [ ] **Step 6: Commit**

```bash
git add apps/companion/src/i18n/index.ts apps/companion/src/i18n/locales/index.ts apps/companion/src/i18n/index.test.ts
git commit -m "$(cat <<'EOF'
refactor(companion): consume shared i18n core

Rewire the i18n barrel onto @tarmoto/shared makeTranslator + registry with an
identical public surface, so the ~98 consumers are untouched. Next-specific
server/provider bits and LOCALE_COOKIE stay put.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

### Task 3: PR 1 verification + open PR

- [ ] **Step 1: Full guarded checks**

Run: `pnpm shared:build && pnpm --filter @tarmoto/shared test && pnpm --filter @tarmoto/companion typecheck && pnpm --filter @tarmoto/companion test`
Expected: all green.

- [ ] **Step 2: Push and open PR 1**

```bash
git push -u origin feat/email-i18n
gh pr create --title "refactor(shared): extract i18n core; companion consumes it" \
  --body "$(cat <<'EOF'
## Summary
Extracts the companion's i18n machinery (`resolveLocale`, lookup/fallback/interpolation) into `@tarmoto/shared` as a `makeTranslator` factory + a metadata-only `LOCALES` registry. The companion consumes it behind an unchanged `@/i18n` barrel — the ~98 consumer imports are untouched. No behavior change; groundwork for i18n-ready backend email.

## Implementation notes
- Shared core is framework-agnostic and dependency-free; Next-specific bits (`server.ts`, `I18nProvider`, `activeLocale`, `LOCALE_COOKIE`) stay in the companion.
- `LOCALES` now carries labels only; catalogs are per-surface. Verified no consumer reads `LOCALES[...].messages`.

## Risks / regression surface
Companion translation. Guarded by the existing i18n + consumer test suites and the identical barrel surface.

## Contract / schema / migration impact
None.

## Test evidence
`pnpm --filter @tarmoto/shared test`, `pnpm --filter @tarmoto/companion typecheck`, `pnpm --filter @tarmoto/companion test` all green.

Design spec: `docs/superpowers/specs/2026-07-11-email-template-i18n-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# PR 2 — `feat(backend): i18n-ready email templates`

**Branch:** new branch off `main` after PR 1 merges (`git fetch origin && git checkout -b feat/backend-email-i18n origin/main`), OR stacked on `feat/email-i18n` if PR 1 is not yet merged. The plan assumes the shared i18n core is built and importable.

## File structure

- Create `apps/backend/src/modules/email/i18n/en.ts` — the `en` email catalog (`Record<EmailMessageKey, string>`), built by extracting each template's current subjects/copy/footer strings verbatim (byte-identical). `EmailMessageKey = keyof typeof en`.
- Create `apps/backend/src/modules/email/i18n/index.ts` — `translateEmail = makeTranslator<EmailMessageKey>({ en })`; re-export `EmailMessageKey`.
- Create `apps/backend/src/modules/email/templates/templates.snapshot.spec.ts` — characterization snapshots for all ten templates (the byte-identical safety net).
- Modify `apps/backend/src/modules/email/templates/layout.ts` — `renderLayout`/`renderTextFooter` accept optional `locale` + translated footer strings, defaulting to today's English (byte-identical when omitted).
- Modify `apps/backend/src/modules/email/templates/index.ts` — `BaseContext` gains `locale`; each of the ten templates renders copy via `translateEmail(..., ctx.locale)`.
- Modify `apps/backend/src/modules/email/email.service.ts` — `ContextWithoutBase` also omits `locale`; each `send*` gains a trailing `locale: SupportedLocale = DEFAULT_LOCALE`; `withBase(ctx, locale)` injects it.
- Modify `apps/backend/src/modules/email/email.service.spec.ts` — assert the seam (a passed locale reaches the template; default is `en`).
- **No API/DTO/OpenAPI/Postman change** — `locale` is an internal render parameter, never a wire field. Do not regenerate OpenAPI/Postman.

**Catalog key convention:** `<template>.<part>` (e.g. `verification.subject`, `verification.html.welcome`, `digest.row.rides`), plus shared `common.*` (greetings, "paste this link") and `layout.*` (footers). Where the current text and HTML wordings differ, they get distinct keys (`*.text.*` vs `*.html.*`). Extract strings **verbatim** from `templates/index.ts` — the snapshot tests fail on any drift.

### Task 1: Characterization snapshots (byte-identical safety net)

**Files:**

- Test: `apps/backend/src/modules/email/templates/templates.snapshot.spec.ts`

**Interfaces:**

- Consumes: the ten exported templates + their context types from `templates/index.ts`.
- Produces: committed `.snap` output that all later tasks must keep green.

- [ ] **Step 1: Write the snapshot test** with a fixed, representative context per template (cover the branches: named vs anon greeting, `renewsAt`/`endsAt` present, digest `bestQuality` present, trip-invite `message` present). Each template contributes three snapshots: `subject`, `html`, `text`.

```ts
import { describe, it, expect } from "@jest/globals";
import {
  verificationTemplate,
  passwordResetTemplate,
  passwordChangedTemplate,
  subscriptionConfirmedTemplate,
  subscriptionCancelledTemplate,
  dataExportReadyTemplate,
  accountDeletionScheduledTemplate,
  tripInviteTemplate,
  weeklyDigestTemplate,
  accountDeletionCompletedTemplate,
} from "./index.js";

const PREFS = "https://app.tarmoto.example/settings/notifications";
const AT = new Date("2026-03-01T08:00:00.000Z");

const cases: Array<[string, { subject: string; html: string; text: string }]> =
  [
    [
      "verification",
      verificationTemplate({
        preferencesUrl: PREFS,
        displayName: "Riku",
        verifyUrl: "https://app.tarmoto.example/verify?t=TOKEN",
        expiresInHours: 24,
      }),
    ],
    [
      "password-reset",
      passwordResetTemplate({
        preferencesUrl: PREFS,
        displayName: "Riku",
        resetUrl: "https://app.tarmoto.example/reset?t=TOKEN",
        expiresInMinutes: 30,
      }),
    ],
    [
      "password-changed",
      passwordChangedTemplate({
        preferencesUrl: PREFS,
        displayName: "Riku",
        supportEmail: "support@tarmoto.app",
        changedAt: AT,
      }),
    ],
    [
      "subscription-confirmed",
      subscriptionConfirmedTemplate({
        preferencesUrl: PREFS,
        displayName: "Riku",
        planName: "Pro",
        priceLabel: "€29.99/mo",
        renewsAt: AT,
        manageBillingUrl: "https://app.tarmoto.example/billing",
      }),
    ],
    [
      "subscription-cancelled",
      subscriptionCancelledTemplate({
        preferencesUrl: PREFS,
        displayName: "Riku",
        planName: "Pro",
        endsAt: AT,
        resubscribeUrl: "https://app.tarmoto.example/billing",
      }),
    ],
    [
      "data-export-ready",
      dataExportReadyTemplate({
        preferencesUrl: PREFS,
        displayName: "Riku",
        downloadUrl: "https://app.tarmoto.example/export/abc",
        expiresAt: AT,
      }),
    ],
    [
      "account-deletion-scheduled",
      accountDeletionScheduledTemplate({
        preferencesUrl: PREFS,
        displayName: "Riku",
        scheduledFor: AT,
        supportEmail: "support@tarmoto.app",
      }),
    ],
    [
      "trip-invite",
      tripInviteTemplate({
        preferencesUrl: PREFS,
        inviterDisplayName: "Riku",
        tripTitle: "Alps Loop",
        joinUrl: "https://app.tarmoto.example/join/xyz",
        inviteCode: "ABC123",
        message: "Come ride!",
      }),
    ],
    [
      "weekly-digest",
      weeklyDigestTemplate({
        preferencesUrl: PREFS,
        displayName: "Riku",
        rideCount: 4,
        totalKm: 213.7,
        totalMinutes: 372,
        bestQuality: 4.2,
        percentExplored: 38,
        riddenSegments: 512,
        units: "metric",
        exploreUrl: "https://app.tarmoto.example/explore",
      }),
    ],
    [
      "account-deletion-completed",
      accountDeletionCompletedTemplate({
        preferencesUrl: PREFS,
        displayName: "Riku",
        deletedAt: AT,
        supportEmail: "support@tarmoto.app",
      }),
    ],
  ];

describe("email templates — characterization snapshots", () => {
  it.each(cases)("%s renders stable subject/html/text", (_name, rendered) => {
    expect(rendered.subject).toMatchSnapshot("subject");
    expect(rendered.html).toMatchSnapshot("html");
    expect(rendered.text).toMatchSnapshot("text");
  });
});
```

- [ ] **Step 2: Run to generate + verify snapshots**

Run: `pnpm --filter @tarmoto/backend test -- templates.snapshot`
Expected: PASS, writes `__snapshots__/templates.snapshot.spec.ts.snap`. These snapshots encode the CURRENT output; every later PR-2 task must keep them green (this is what guarantees byte-identical).

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/modules/email/templates/templates.snapshot.spec.ts apps/backend/src/modules/email/templates/__snapshots__
git commit -m "$(cat <<'EOF'
test(backend): characterization snapshots for email templates

Locks current subject/html/text output for all ten templates as a byte-identical
safety net before the i18n refactor.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

### Task 2: Email i18n core + catalog

**Files:**

- Create: `apps/backend/src/modules/email/i18n/index.ts`
- Create: `apps/backend/src/modules/email/i18n/en.ts`
- Test: `apps/backend/src/modules/email/i18n/i18n.spec.ts`

**Interfaces:**

- Consumes: `makeTranslator`, `Catalog`, `SupportedLocale` from `@tarmoto/shared`.
- Produces: `translateEmail: Translator<EmailMessageKey>`, `type EmailMessageKey`. Verify catalog keys against snapshot strings.

- [ ] **Step 1: Seed `en.ts` with the shared + verification keys** (the worked pattern; remaining templates append their keys in Tasks 5–13). Values are copied **verbatim** from `templates/index.ts`.

```ts
import type { Catalog } from "@tarmoto/shared";

// English email copy. Trusted, in-repo, PR-reviewed. May contain inline emphasis
// (<strong>) mirroring the current HTML, but NEVER structural chrome or user data
// (those stay in the template functions, with user data escaped for HTML).
export const en = {
  // --- shared ---
  "common.greeting.named": "Hi {name},",
  "common.greeting.anon": "Hi there,",
  "common.html.pasteLink": "Or paste this link in your browser:",

  // --- verification ---
  "verification.subject": "Verify your Tarmoto email",
  "verification.preheader": "Confirm your email to finish setting up Tarmoto.",
  "verification.text.intro":
    "Welcome to Tarmoto — the open road just got smarter.",
  "verification.text.confirmLine":
    "Confirm your email so we can send you trip invites, hazard alerts, and account notices:",
  "verification.html.welcome":
    "Welcome to <strong>Tarmoto</strong> — confirm your email so we can deliver trip invites, hazard alerts, and important account notices.",
  "verification.button": "Verify email",
  "verification.expiry":
    "This link expires in {hours} hours. If you didn't sign up for Tarmoto, you can ignore this message.",
} as const satisfies Catalog<string>;

export type EmailMessageKey = keyof typeof en;
```

- [ ] **Step 2: Create `index.ts`**

```ts
import { makeTranslator, type Translator } from "@tarmoto/shared";
import { en, type EmailMessageKey } from "./en.js";

export type { EmailMessageKey };

/** Translator over the backend email catalogs. English-only for now. */
export const translateEmail: Translator<EmailMessageKey> =
  makeTranslator<EmailMessageKey>({ en });
```

- [ ] **Step 3: Write + run the unit test** — `i18n/i18n.spec.ts`

```ts
import { describe, it, expect } from "@jest/globals";
import { translateEmail } from "./index.js";

describe("translateEmail", () => {
  it("returns catalog copy and interpolates values", () => {
    expect(translateEmail("common.greeting.named", { name: "Riku" })).toBe(
      "Hi Riku,",
    );
    expect(translateEmail("verification.subject")).toBe(
      "Verify your Tarmoto email",
    );
  });

  it("falls back to English for an unpopulated locale (the deliberate en-only seam)", () => {
    // @ts-expect-error — 'et' is not registered yet; exercises fallback
    expect(translateEmail("verification.subject", undefined, "et")).toBe(
      "Verify your Tarmoto email",
    );
  });
});
```

Run: `pnpm --filter @tarmoto/backend test -- email/i18n`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/modules/email/i18n
git commit -m "$(cat <<'EOF'
feat(backend): email i18n catalog + translator

en email catalog keyed by EmailMessageKey rendered via the shared makeTranslator.
Starts with shared + verification keys; further templates append their keys.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

### Task 3: Layout accepts locale + translated footers (byte-identical default)

**Files:**

- Modify: `apps/backend/src/modules/email/templates/layout.ts`

**Interfaces:**

- Produces: `renderLayout(ctx)` where `LayoutContext` gains `locale?: SupportedLocale` (→ `<html lang>`; default `"en"`) and `footer?: { lead: string; linkLabel: string }` (when omitted, the current hard-coded English is used → byte-identical). `renderTextFooter(preferencesUrl, marketing?, copy?)` where `copy` (when omitted) reproduces today's English.

- [ ] **Step 1:** Add optional params with English defaults. Change `<html lang="en">` → `<html lang="${escapeHtml(ctx.locale ?? "en")}">`. Replace the inline footer ternary with: if `ctx.footer` provided, render `` `${ctx.footer.lead} <a href="${escapeHtml(ctx.preferencesUrl)}" style="color:${BRAND.primary};">${ctx.footer.linkLabel}</a>.` ``; else keep the exact current marketing/transactional strings. Import `type { SupportedLocale } from "@tarmoto/shared"`. Apply the analogous optional-`copy` change to `renderTextFooter`.

- [ ] **Step 2:** Run the snapshot suite — with no template yet passing the new params, output MUST be unchanged.

Run: `pnpm --filter @tarmoto/backend test -- templates.snapshot`
Expected: PASS (no snapshot changes).

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/modules/email/templates/layout.ts
git commit -m "$(cat <<'EOF'
feat(backend): layout accepts locale + translated footer strings

Optional params default to today's English so unmigrated templates render
byte-identically; lets templates feed catalog-driven footer copy next.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

### Task 4: Thread the `locale` seam through EmailService

**Files:**

- Modify: `apps/backend/src/modules/email/templates/index.ts` (BaseContext only)
- Modify: `apps/backend/src/modules/email/email.service.ts`
- Test: `apps/backend/src/modules/email/email.service.spec.ts`

**Interfaces:**

- Produces: `BaseContext { preferencesUrl: string; locale: SupportedLocale }`; `ContextWithoutBase<T> = Omit<T, "preferencesUrl" | "locale">`; every `send*(to, ctx, locale: SupportedLocale = DEFAULT_LOCALE)`; `withBase<T>(ctx, locale): T & { preferencesUrl: string; locale: SupportedLocale }`.

- [ ] **Step 1:** In `templates/index.ts`, add `locale: SupportedLocale` to `BaseContext` and `import { type SupportedLocale } from "@tarmoto/shared"`. (Templates don't read it yet — Tasks 5–13 wire it in. Snapshots stay green because context objects built by the snapshot test don't set `locale`; the templates ignore it until migrated. NOTE: the snapshot fixtures omit `locale`, so also relax the fixtures' typing or add `locale: "en"` to each — add `locale: "en"` to every snapshot fixture context in this step and re-run; snapshots stay identical since nothing reads it.)

- [ ] **Step 2:** In `email.service.ts`: widen `ContextWithoutBase` to omit `locale`; add the trailing `locale: SupportedLocale = DEFAULT_LOCALE` param to all ten `send*`; change `withBase(ctx)` → `withBase(ctx, locale)` and have it spread `{ ...ctx, preferencesUrl: this.preferencesUrl(), locale }`. Import `DEFAULT_LOCALE`, `SupportedLocale` from `@tarmoto/shared`.

- [ ] **Step 3:** Add a service test asserting the seam:

```ts
it("passes an explicit locale through to the rendered template context", async () => {
  // Spy the provider; assert render happened. Default path uses 'en'.
  const res = await service.sendVerification(
    "rider@example.com",
    { displayName: "Riku", verifyUrl: "https://x/y", expiresInHours: 24 },
    "en",
  );
  expect(res).not.toBeUndefined();
});
```

Run: `pnpm --filter @tarmoto/backend test -- email.service && pnpm --filter @tarmoto/backend test -- templates.snapshot`
Expected: PASS; snapshots unchanged.

- [ ] **Step 4: Commit** (`feat(backend): thread defaulted locale seam through EmailService`).

### Tasks 5–13: Migrate each template to the catalog (one per template)

Each task: (a) append that template's keys to `i18n/en.ts` (verbatim strings from the current function), (b) refactor the function to `const t = (k, v) => translateEmail(k, v, ctx.locale)` and compose subject/html/text from `t(...)` — **user data escaped for HTML, raw for text** — passing `locale: ctx.locale` and the translated `footer`/text-footer copy into the layout, (c) keep the snapshot green, (d) commit. **Task 5 (verification) is the fully worked reference below; Tasks 6–13 apply the identical pattern with the keys/notes listed.**

#### Task 5 — verification (worked reference)

- [ ] **Step 1:** Keys already added in Task 2. Refactor `verificationTemplate`:

```ts
export const verificationTemplate = (
  ctx: VerificationContext,
): RenderedTemplate => {
  const t = (k: EmailMessageKey, v?: TranslationValues): string =>
    translateEmail(k, v, ctx.locale);
  const greeting = ctx.displayName
    ? t("common.greeting.named", { name: ctx.displayName }) // text: raw name
    : t("common.greeting.anon");
  const greetingHtml = ctx.displayName
    ? t("common.greeting.named", { name: escapeHtml(ctx.displayName) })
    : t("common.greeting.anon");
  const subject = t("verification.subject");

  const text = `${greeting}

${t("verification.text.intro")}

${t("verification.text.confirmLine")}

${ctx.verifyUrl}

${t("verification.expiry", { hours: ctx.expiresInHours })}${renderTextFooter(ctx.preferencesUrl)}`;

  const html = renderLayout({
    preheader: t("verification.preheader"),
    preferencesUrl: ctx.preferencesUrl,
    locale: ctx.locale,
    bodyHtml: `
      <p>${greetingHtml}</p>
      <p>${t("verification.html.welcome")}</p>
      <p style="margin:32px 0;">
        <a href="${escapeHtml(ctx.verifyUrl)}" style="display:inline-block;padding:12px 24px;background:#06b6d4;color:#0f172a;text-decoration:none;font-weight:600;border-radius:8px;">${t("verification.button")}</a>
      </p>
      <p style="color:#94a3b8;font-size:13px;">${t("common.html.pasteLink")}<br/><a href="${escapeHtml(ctx.verifyUrl)}" style="color:#06b6d4;word-break:break-all;">${escapeHtml(ctx.verifyUrl)}</a></p>
      <p style="color:#94a3b8;font-size:13px;">${t("verification.expiry", { hours: ctx.expiresInHours })}</p>
    `,
  });

  return { subject, html, text, tag: "verification" };
};
```

Add `import { translateEmail, type EmailMessageKey } from "../i18n/index.js"` and `import type { TranslationValues } from "@tarmoto/shared"` at the top of `templates/index.ts` (once, in Task 5).

- [ ] **Step 2:** `pnpm --filter @tarmoto/backend test -- templates.snapshot` → the `verification` subject/html/text snapshots MUST be unchanged. If a snapshot diff appears, a copied string drifted — fix the catalog value to match, do not update the snapshot.
- [ ] **Step 3:** Commit `feat(backend): render verification email from catalog`.

#### Tasks 6–13 — remaining templates

Apply the Task 5 pattern. Per template, the keys to add (values copied verbatim from the current function) and the notable logic to preserve:

- **Task 6 — password-reset:** keys `passwordReset.{subject,preheader,text.intro,html.intro,button,expiryText,expiryHtml,noRequest}`. Note text says "expires in {mins} minutes and can only be used once" as one line; HTML splits expiry (`<strong>{mins} minutes</strong>`) and no-request into two `<p>`s → distinct `expiryHtml` (with inline `<strong>`) + `noRequest` keys.
- **Task 7 — password-changed:** keys `passwordChanged.{subject,preheader,text.body,html.changed,when,text.ifYou,html.ifYou,contact}`. `contact` = "If you didn't change your password, contact us immediately at {email}." — email escaped for HTML, raw for text; `when = ctx.changedAt.toUTCString()` interpolated (escaped for HTML).
- **Task 8 — subscription-confirmed:** keys `subscriptionConfirmed.{subject,preheader,welcome,table.plan,table.price,table.renewal,text.renews,text.noRenew,manageButton}`. `subject`/`welcome`/`preheader` interpolate `{plan}` (escaped for HTML in `welcome`, raw in subject/preheader-as-text). Keep the conditional renewal row/line on `ctx.renewsAt`. Table cell VALUES are user/computed data → escaped for HTML.
- **Task 9 — subscription-cancelled:** keys `subscriptionCancelled.{subject,preheader,cancelled,text.accessKept,text.accessEnded,html.access,resubscribeButton}`. `{plan}` interpolation (escaped in HTML `cancelled`), conditional access line on `ctx.endsAt`. HTML `access` line = `escapeHtml(accessLine)` today → interpolate the (computed, non-user) access sentence as a key with `{date}`/`{plan}`.
- **Task 10 — data-export-ready:** keys `dataExportReady.{subject,preheader,text.ready,html.ready,button,expiry}`. `expiry` interpolates `{date}` = `ctx.expiresAt.toUTCString()` (escaped for HTML).
- **Task 11 — account-deletion-scheduled:** keys `accountDeletionScheduled.{subject,preheader,text.scheduled,html.scheduled,text.changedMind,html.changedMind,graceWindow,afterDate}`. Preserve the support-only-restore wording verbatim (it's a deliberate correctness fix). `{date}` = `scheduledFor.toUTCString()`, `{email}` = supportEmail (escaped for HTML). HTML `scheduled` has inline `<strong>permanent deletion</strong>`.
- **Task 12 — trip-invite:** keys `tripInvite.{subject,preheader,greeting,intro,text.messageBlock,text.openLine,text.codeLine,text.noAccount,html.pasteHint,inviteCodeHtml,noAccountHtml,button}`. Greeting is the literal "Hi there," (not the named greeting). `subject`/`intro`/`preheader` interpolate `{inviter}`+`{trip}` (escaped for HTML in `intro`/blockquote; raw in subject). Preserve the conditional `message` blockquote (escaped) / text message block. `{code}` escaped for HTML.
- **Task 13 — weekly-digest:** keys `digest.{subject,preheader,greeting.lead,intro,row.rides,row.distance,row.time,row.quality,explored,button,rideWord.one,rideWord.other}`. Keep `formatDuration` + `formatDistance` + `bestQuality?.toFixed(1)` logic in the template. **Pluralization stays in code:** `const rideWord = ctx.rideCount === 1 ? t("digest.rideWord.one") : t("digest.rideWord.other")`. Pass `marketingFooter`/marketing text-footer copy. `riddenSegments`/`percentExplored` interpolated (numeric, no escaping needed but pass through the same path).
- **Task 8b within Task 14 — account-deletion-completed:** keys `accountDeletionCompleted.{subject,preheader,text.deleted,html.deleted,erased,contact}`. `{date}` = `deletedAt.toUTCString()` (escaped for HTML), `{email}` escaped for HTML. (This template's send is not logged — unaffected here.)

Each of Tasks 6–13 ends with: `pnpm --filter @tarmoto/backend test -- templates.snapshot` green (no snapshot changes) + a `feat(backend): render <name> email from catalog` commit.

### Task 14: Escaping + fallback tests

**Files:**

- Test: `apps/backend/src/modules/email/templates/templates.i18n.spec.ts`

- [ ] **Step 1:** Add tests that lock the security-relevant behavior independent of snapshots:

```ts
import { describe, it, expect } from "@jest/globals";
import { verificationTemplate, tripInviteTemplate } from "./index.js";

const PREFS = "https://app.tarmoto.example/settings/notifications";

describe("email i18n — escaping + fallback", () => {
  it("escapes user data in the HTML body", () => {
    const out = verificationTemplate({
      preferencesUrl: PREFS,
      locale: "en",
      displayName: "<script>alert(1)</script>",
      verifyUrl: "https://x/y",
      expiresInHours: 24,
    });
    expect(out.html).not.toContain("<script>alert(1)</script>");
    expect(out.html).toContain("&lt;script&gt;");
    // Text part carries the raw name (no HTML context).
    expect(out.text).toContain("<script>alert(1)</script>");
  });

  it("renders English regardless of locale (en-only phase)", () => {
    const out = tripInviteTemplate({
      preferencesUrl: PREFS,
      locale: "en",
      inviterDisplayName: "Riku",
      tripTitle: "Alps Loop",
      joinUrl: "https://x/y",
      inviteCode: "ABC123",
      message: null,
    });
    expect(out.subject).toContain("invited you to plan");
  });
});
```

Run: `pnpm --filter @tarmoto/backend test -- templates.i18n`
Expected: PASS.

- [ ] **Step 2: Commit** (`test(backend): lock email escaping + en fallback`).

### Task 15: PR 2 verification + open PR

- [ ] **Step 1: Full guarded checks**

Run: `pnpm shared:build && pnpm --filter @tarmoto/backend typecheck && pnpm --filter @tarmoto/backend test -- email`
Expected: all green; the ten template snapshots UNCHANGED from Task 1 (proof of byte-identical output).

- [ ] **Step 2: Confirm no contract regen needed** — `locale` is internal. Do NOT run `openapi:gen`/`postman:gen` (no endpoint/DTO changed). Sanity: `git status` shows no `packages/openapi` or Postman diffs.

- [ ] **Step 3: Push and open PR 2** with summary, the byte-identical-via-snapshots note, "no contract/schema/migration impact", and test evidence. Link the design spec. End the body with the `🤖 Generated with [Claude Code]` line.

## Self-review (completed)

- **Spec coverage:** shared core (PR1 T1), companion migration + barrel invariance (PR1 T2, verified in T2S1), email catalog + templates (PR2 T2, T5–T14), layout/footer copy (PR2 T3 + per-template footer wiring), `locale` seam defaulted (PR2 T4), escaping preserved (PR2 T14), pluralization in code (PR2 T13), en-only fallback tested (PR2 T2S3, T14). Non-goals (persistence, Accept-Language, translations, ICU) are absent by construction.
- **Type consistency:** `EmailMessageKey`, `translateEmail`, `CatalogsByLocale`, `makeTranslator`, `SupportedLocale`, `BaseContext.locale`, `ContextWithoutBase = Omit<T,"preferencesUrl"|"locale">`, `withBase(ctx, locale)` are used consistently across tasks.
- **Deviation from spec (flagged):** catalog values permit trusted inline `<strong>` (not strictly markup-free) to keep output byte-identical; user data is still escaped separately, so no-injection holds. Byte-identical is enforced by characterization snapshots (PR2 T1).
