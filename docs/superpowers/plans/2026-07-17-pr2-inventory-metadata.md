# SEO/OG Metadata i18n Audit — apps/companion/src/app

Read-only audit. Scope command used:
`grep -rn 'generateMetadata\|export const metadata' src/app --include='*.tsx' --include='*.ts'`

## Headline numbers

- **10 metadata files total: 7 dynamic (`generateMetadata`) + 3 static (`export const metadata`)**
- **23 raw (untranslated) user-facing metadata strings** across those 10 files
- **1 file partially wrapped**: `community/collections/shared/[slug]/page.tsx` (the description field, via `t()` with an explicit locale + a nested wrapped fallback)
- **All 3 static files need conversion to `generateMetadata`** — every one of them carries real user-facing copy (title/description/siteName), not just machine config
- 2 additional `r.description` fields (region/subregion best-roads pages) are **data-sourced, not literals in these files** — flagged separately, not in the raw-23 count
- **Architectural blocker for `roads/best/**`**: those 3 dynamic pages run under `export const revalidate = 604800`(weekly ISR).`readLocale()`needs`cookies()`/`headers()`, which aren't available during background ISR regen — `resolveFromRequest()`silently falls back to`DEFAULT_LOCALE`in that case (try/catch, see`src/i18n/server.ts`). So wiring `readLocale()`into these 3`generateMetadata` functions as-is would mostly serve English metadata to everyone regardless of visitor locale, not true per-visitor localization. The reference pattern (`force-dynamic`) doesn't have this problem. The plan needs an explicit answer for this (e.g. locale-suffixed static params / accept-language-agnostic SEO copy / drop ISR for these routes).

---

## Reference pattern — `src/app/community/collections/shared/[slug]/page.tsx`

This is the one file with any translator wiring in its `generateMetadata`. Quoted verbatim (lines 26–59):

```tsx
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const detail = await fetchSharedCollection(slug);
  const locale = await readLocale();
  if (!detail) {
    return {
      title: "Collection — Tarmoto",
      robots: { index: false, follow: false },
    };
  }
  return {
    title: `${detail.title} — Tarmoto collection`,
    description:
      detail.description ??
      t(
        "{count, plural, one {# curated route} other {# curated routes}} shared by {owner}",
        {
          count: detail.item_count,
          owner: detail.owner_name || t("a Tarmoto rider", undefined, locale),
        },
        locale,
      ),
    // Public collections are indexable; unlisted ones must stay out of the
    // index. We branch on the resolved visibility.
    robots:
      detail.visibility === "public"
        ? { index: true, follow: true }
        : { index: false, follow: false },
  };
}
```

Pattern to replicate: `const locale = await readLocale();` inside `generateMetadata`, then pass `locale` as the explicit 3rd positional arg to every `t()` call reached from that function — **including nested fallback calls** (`t("a Tarmoto rider", undefined, locale)` inside the `owner` interpolation value). Relying on the module-global `activeLocale` (the `t()` default param) is not safe inside `generateMetadata` because Next may resolve metadata outside/ahead of the component render that would otherwise set it via `setActiveLocale`.

**What's wrapped vs raw in this file itself:**

- `description` (found-branch): **wrapped** — outer `t(...)` + nested fallback `t("a Tarmoto rider", ...)` also wrapped. 2 `t()` calls total.
- `title` (found-branch): `` `${detail.title} — Tarmoto collection` `` — **raw**. `detail.title` is user-authored content (not translatable UI copy), but the fixed suffix `" — Tarmoto collection"` is untranslated UI chrome.
- `title` (not-found branch): `"Collection — Tarmoto"` — **raw**.
- `robots`: machine (EXCLUDE).

Locale resolution: `readLocale()` from `@/i18n/server`, explicit locale threading. Runs under `export const dynamic = "force-dynamic";` (safe — real request context always available).

---

## Test pattern — `src/app/roads/best/metadata.test.ts`

Imports the page modules' `generateMetadata` functions directly (renamed on import: `generateCountryMetadata`, `generateRegionMetadata`, `generateSubregionMetadata`), calls them with a hand-built `params: Promise.resolve({...})`, and asserts on the returned `Metadata` object's fields directly (`metadata.description` regex match, `JSON.stringify(metadata.openGraph)` substring match for the OG image path). No rendering, no i18n mocking, no locale param passed in today. One line: **direct unit-call of the exported `generateMetadata` with a mocked `params` promise, asserting on returned `Metadata` fields via regex/substring — no locale/catalog mocking yet, so the plan must add a locale-parameterized variant of this pattern (or an explicit `locale` param once these pages accept one) to cover translated output.**

---

## Per-file inventory

### 1. `src/app/layout.tsx` — STATIC (root layout)

- `title`: `"Tarmoto"` — raw
- `description`: `"Know the road before you ride it"` — raw
- Locale resolution: component body calls `const locale = await readLocale();` (used for `<html lang={locale}>` and `AppProviders`) — but the static `metadata` export is a module-scope const evaluated once and **cannot** see this. No `t` import.
- Raw count: 2. Needs conversion to `generateMetadata` to gain any locale awareness.

### 2. `src/app/explore/layout.tsx` — STATIC

- `title` (const, reused in `openGraph.title` + `twitter.title`): `"Road Quality Explorer — Tarmoto"` — raw
- `description` (const, reused in `openGraph.description` + `twitter.description`): `"Explore crowdsourced road surface quality and active hazards on an interactive map. Find the best riding roads before you head out."` — raw
- `openGraph.siteName`: `"Tarmoto"` — raw
- `alternates.canonical`: `/explore` — EXCLUDE (path)
- `openGraph.url`: `/explore` — EXCLUDE (path)
- `openGraph.type`: `"website"` — EXCLUDE (enum)
- `twitter.card`: `"summary_large_image"` — EXCLUDE (enum)
- `metadataBase`: `new URL(siteUrl())` — EXCLUDE (machine URL)
- Locale resolution: none. No `readLocale`/`t` import anywhere in file. (Component body only calls `auth()`.)
- Raw count: 3 distinct strings (title/description/siteName each fan out to 2–3 Metadata fields via the shared const, but only 1 edit site each).

### 3. `src/app/roads/best/layout.tsx` — STATIC

- `title` (const, reused in `openGraph.title` + `twitter.title`): `"Best Motorcycle Roads — Tarmoto"` — raw
- `description` (const, reused in `openGraph.description` + `twitter.description`): `"Curated lists of the highest-rated motorcycle roads in each region, " + "ranked by quality and curviness from crowdsourced rider data."` — raw
- `openGraph.siteName`: `"Tarmoto"` — raw
- `alternates.canonical`: `/roads/best` — EXCLUDE
- `openGraph.url`: `/roads/best` — EXCLUDE
- `openGraph.type` / `twitter.card` / `metadataBase` — EXCLUDE (same as above)
- Locale resolution: none. No `readLocale`/`t` import. (Component body only calls `auth()`.)
- Raw count: 3 distinct strings.

### 4. `src/app/rides/shared/[token]/page.tsx` — DYNAMIC

```tsx
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Shared ride — Tarmoto",
    description: "Public Tarmoto shared ride page.",
    robots: { index: false, follow: false },
  };
}
```

- `title`: `"Shared ride — Tarmoto"` — raw
- `description`: `"Public Tarmoto shared ride page."` — raw
- `robots` — EXCLUDE
- Locale resolution: **none inside `generateMetadata`** — no `readLocale`/`getServerLocale` call, no branching. Notably the file **does** `import { t } from "@/i18n"` and uses it extensively in the page body (`t("Shared ride")`, `t("Public route share")`, plural view-count, etc.) — so the translator is already wired for the rendered page, just not for its own metadata function.
- Runs under `export const dynamic = "force-dynamic";` — safe for `readLocale()` (real request context, same shape as the reference file; no branching on found/not-found needed here since `notFound()` only happens in the page body, not in `generateMetadata`).
- Raw count: 2.

### 5. `src/app/rides/road-map/shared/[token]/page.tsx` — DYNAMIC

```tsx
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Shared road map — Tarmoto",
    description: "Public Tarmoto personal road map.",
    robots: { index: false, follow: false },
  };
}
```

- `title`: `"Shared road map — Tarmoto"` — raw
- `description`: `"Public Tarmoto personal road map."` — raw
- `robots` — EXCLUDE
- Locale resolution: none inside `generateMetadata`. Same as above, body already imports/uses `t` heavily; metadata function doesn't.
- `export const dynamic = "force-dynamic";` — safe for `readLocale()`.
- Raw count: 2.

### 6. `src/app/trips/shared/[token]/page.tsx` — DYNAMIC

```tsx
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Shared trip — Tarmoto",
    description: "Public Tarmoto shared trip page.",
    robots: { index: false, follow: false },
  };
}
```

- `title`: `"Shared trip — Tarmoto"` — raw
- `description`: `"Public Tarmoto shared trip page."` — raw
- `robots` — EXCLUDE
- Locale resolution: none inside `generateMetadata`. Body already imports/uses `t` heavily.
- `export const dynamic = "force-dynamic";` — safe for `readLocale()`.
- Raw count: 2.

### 7. `src/app/community/collections/shared/[slug]/page.tsx` — DYNAMIC (reference; see full quote above)

- `title` (found): template `` `${detail.title} — Tarmoto collection` `` — raw
- `title` (not-found): `"Collection — Tarmoto"` — raw
- `description` (found): **wrapped** — `t("{count, plural, one {# curated route} other {# curated routes}} shared by {owner}", { count, owner: detail.owner_name || t("a Tarmoto rider", undefined, locale) }, locale)`
- `robots` — EXCLUDE
- Locale resolution: **already wired** — `const locale = await readLocale();`, threaded explicitly as the 3rd arg to both the outer and the nested fallback `t()` call.
- Raw count: 2 (both are titles). Already-wrapped: 1 field / 2 `t()` calls.

### 8. `src/app/roads/best/[country]/page.tsx` — DYNAMIC

```tsx
const title = `Best motorcycle roads in ${c.name} — Tarmoto`;
const description = `Ranked lists of the top-rated motorcycle roads in ${c.name}, scored by quality and curviness.`;
return buildBestRoadsMetadata({
  title,
  description,
  canonicalPath: `/roads/best/${c.code}`,
  imageAlt: `Best motorcycle roads in ${c.name}`,
});
```

- `title`: template `` `Best motorcycle roads in ${c.name} — Tarmoto` `` — raw (fans out to `title` + `openGraph.title` + `twitter.title` via `buildBestRoadsMetadata`)
- `description`: template — raw (fans out to `description` + `openGraph.description` + `twitter.description`)
- `imageAlt`: template `` `Best motorcycle roads in ${c.name}` `` — raw (→ `openGraph.images[0].alt`)
- `canonicalPath` — EXCLUDE (path, → `alternates.canonical` + `openGraph.url`)
- `openGraph.images[0].url` (`/og/best-roads.svg`), `.width`/`.height`, `openGraph.type: "website"`, `twitter.card` — all EXCLUDE (set inside the shared `buildBestRoadsMetadata` helper in `src/lib/best-roads-metadata.ts`, not per-page)
- Locale resolution: **none** — no `readLocale`/`t` import in this file at all for `generateMetadata`. Notable contrast: the page **body** below already does `import { t } from "@/i18n"` and wraps `t("Best roads ")`, `t("Best motorcycle roads in ")`, the plural region-count string, `t("— tap through for ranked roads...")`, `t("Best season: ")` — so, like the `rides`/`trips` share pages, the body is translator-aware but `generateMetadata` is not.
- Not-found (`!c`) branch returns `{}` (no fallback title/description at all — differs from the collections reference, which returns a friendly fallback title). Worth a plan decision: add a fallback title here too, or accept Next's default.
- Runs under `export const revalidate = 604800;` (ISR) — see the architectural blocker above; `readLocale()` cannot reliably localize this per-visitor under background regeneration.
- Raw count: 3 (title, description, imageAlt).

### 9. `src/app/roads/best/[country]/[region]/page.tsx` — DYNAMIC

```tsx
const title = `Best motorcycle roads in ${r.name} — Tarmoto`;
return buildBestRoadsMetadata({
  title,
  description: r.description,
  canonicalPath: `/roads/best/${r.country}/${r.slug}`,
  imageAlt: `Best motorcycle roads in ${r.name}`,
});
```

- `title`: template — raw
- `description`: `r.description` — **data-sourced**, not a literal in this file (comes from the region catalog in `@tarmoto/shared` via `findRegion`). Flagged separately; not counted in the raw-23 total, but the plan needs to decide how region/country descriptive data gets translated (separate concern from UI-chrome copy — likely a content-catalog problem, not a `t()`-call problem).
- `imageAlt`: template — raw
- `canonicalPath`, `openGraph.type`, `twitter.card`, image url/width/height — EXCLUDE (as above)
- Locale resolution: none. No `readLocale`/`t` import in this file.
- Guard-only not-found (`!r || r.parent`) returns `{}` — no strings.
- `export const revalidate = 604800;` — same ISR blocker as file 8.
- Raw count: 2 (title, imageAlt) + 1 data-sourced description flagged separately.

### 10. `src/app/roads/best/[country]/[region]/[subregion]/page.tsx` — DYNAMIC

```tsx
const title = `Best motorcycle roads in ${r.name} — Tarmoto`;
const url = `/roads/best/${r.country}/${r.parent}/${r.slug}`;
return buildBestRoadsMetadata({
  title,
  description: r.description,
  canonicalPath: url,
  imageAlt: `Best motorcycle roads in ${r.name}`,
});
```

- `title`: template — raw
- `description`: `r.description` — data-sourced (same as file 9), flagged separately
- `imageAlt`: template — raw
- `canonicalPath`/`url`, `openGraph.type`, `twitter.card`, image fields — EXCLUDE
- Locale resolution: none. No `readLocale`/`t` import.
- Guard-only not-found (`!r || r.parent !== region`) returns `{}` — no strings.
- `export const revalidate = 604800;` — same ISR blocker.
- Raw count: 2 (title, imageAlt) + 1 data-sourced description flagged separately.

---

## Shared helper (not a metadata site itself, but the fan-out point for files 8–10)

`src/lib/best-roads-metadata.ts` — `buildBestRoadsMetadata({ title, description, canonicalPath, imageAlt })` takes already-resolved strings from the 3 caller pages and fans them into `title`/`description`/`alternates.canonical`/`openGraph.{title,description,url,type,images}`/`twitter.{card,title,description,images}`. It holds no string literals of its own except the machine `BEST_ROADS_OG_IMAGE` path and `OG_IMAGE_SIZE` numbers (EXCLUDE). Converting the 3 callers to pass already-`t()`-translated strings through this helper requires no change to the helper itself.

---

## EXCLUDE list (machine/non-displayed — confirmed present, out of scope for `t()`)

- `robots: { index, follow }` — booleans (rides/shared, rides/road-map/shared, trips/shared, community/collections/shared/[slug])
- `alternates.canonical` / `openGraph.url` / `canonicalPath` — URL paths (explore/layout, roads/best/layout, best-roads-metadata.ts callers ×3)
- `metadataBase: new URL(siteUrl())` — root layout does not set this; `explore/layout.tsx` and `roads/best/layout.tsx` do
- `openGraph.type: "website"` — enum literal, all files that set it
- `twitter.card: "summary_large_image"` — enum literal
- `openGraph.images[].url` (`/og/best-roads.svg`), `.width` (1200), `.height` (630) — asset path + dimensions, in `best-roads-metadata.ts`
- `export const revalidate = 604800` / `export const dynamic = "force-dynamic"` — render-mode config, not copy
- `generateStaticParams()` return values (country/region/subregion codes+slugs) — routing params, not display copy
- `src/app/robots.ts` and `src/app/sitemap.ts` — checked for completeness (out of the task's grep scope: they export `default function robots()/sitemap()`, not `generateMetadata`/`const metadata`); contents are 100% machine (user-agent rules, allow/disallow paths, sitemap URL entries, `changeFrequency`/`priority` numbers) — zero user-facing strings, not counted as metadata files, no action needed.

---

## Raw user-facing metadata string count

| File                                               | Raw    | Already wrapped       | Data-sourced (flagged, uncounted) |
| -------------------------------------------------- | ------ | --------------------- | --------------------------------- |
| layout.tsx (root)                                  | 2      | 0                     | 0                                 |
| explore/layout.tsx                                 | 3      | 0                     | 0                                 |
| roads/best/layout.tsx                              | 3      | 0                     | 0                                 |
| rides/shared/[token]/page.tsx                      | 2      | 0                     | 0                                 |
| rides/road-map/shared/[token]/page.tsx             | 2      | 0                     | 0                                 |
| trips/shared/[token]/page.tsx                      | 2      | 0                     | 0                                 |
| community/collections/shared/[slug]/page.tsx       | 2      | 1 (2 `t()` calls)     | 0                                 |
| roads/best/[country]/page.tsx                      | 3      | 0                     | 0                                 |
| roads/best/[country]/[region]/page.tsx             | 2      | 0                     | 1                                 |
| roads/best/[country]/[region]/[subregion]/page.tsx | 2      | 0                     | 1                                 |
| **Total**                                          | **23** | **1 field / 2 calls** | **2**                             |
