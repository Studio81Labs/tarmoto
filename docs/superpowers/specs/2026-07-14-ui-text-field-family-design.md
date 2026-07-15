# Design — Text-field family for `@tarmoto/ui`

**Date:** 2026-07-14
**Scope labels:** `cross` (`packages/ui`, `apps/ui-preview`, `apps/companion`)
**Status:** Approved design → implementation planning

## Goal

Bring the design system's **"09 · Form controls"** section fully into the
`@tarmoto/ui` library and its preview. The updated design files add a
**text-field family** — text input, textarea, select (custom menu), searchable
select/combobox, and date / time / date-time pickers — sharing one field chrome
(8 px radius, ink focus ring). Today the library has native/partial versions of
Input, Textarea, Select and NumberField, but they predate the new states, the
custom Select menu, the combobox, and all three pickers, and the preview section
only renders toggle/segment/slider/radio.

## Current state (verified)

- `packages/ui/src/controls/` already contains: `Input`, `Textarea`, `Select`
  (native `<select>` wrapper), `NumberField`, plus Toggle/SegmentedControl/
  Slider/RadioCard/NumberGrid/SwatchPicker/Checkbox/Button.
- Styling convention: Tailwind + design tokens (`text-ink`, `bg-paper`,
  `bg-cream`, `border-line-strong`, `text-fg-mute`, `focus:border-accent`),
  `cn()` (clsx) helper, controlled `value`/`onChange`, `tone: "paper" | "cream"`,
  `ariaLabel`, `className` passthrough. Shared `fieldClasses(tone, disabled)`
  lives in `Input.tsx`.
- Missing vs the new spec: **Combobox**, **DatePicker**, **TimePicker**,
  **DateTimePicker**; and the new **leading-icon / error / hint / focus-ring**
  states on Input/Textarea/Select, plus the **custom Select menu**.
- `Select` is a native `<select>` wrapper — structurally cannot render the
  spec's open menu (hover, ink-fill selected, accent check), so it must be
  rebuilt as a custom listbox.
- Consumers of `Select` from `@tarmoto/ui`: **4 companion files** —
  `TripCollaborateModal.tsx`, `PassesPanel.tsx`, `TripStopsPanel.tsx`,
  `planner/RoundtripDialog.tsx`.
- `date-fns@4` exists in the monorepo (companion dep) but **not** in
  `packages/ui`. No existing date/time picker component anywhere.

## Decisions

- **Headless a11y library:** add `react-aria-components` + `@internationalized/date`
  to `packages/ui`. One library cohesively covers ComboBox, Select, DatePicker/
  Calendar, TimeField and DateField with full ARIA + keyboard, headless so we
  style with the existing Tailwind tokens via `data-[selected]` / `data-[focused]`
  / render-prop state. `packages/ui` peer is React ≥18 (dev 19) — compatible.
- **Value API (public):** ISO strings at the component boundary —
  Date → `"2026-05-18"`, Time → `"08:30"`, DateTime → `"2026-05-18T08:30"`.
  Internally convert with `@internationalized/date` (`parseDate` / `parseTime` /
  `parseDateTime` + `.toString()`). `date-fns` is **not** added to `packages/ui`;
  display formatting uses react-aria's Intl-based formatter.
- **Select:** rebuilt on react-aria (breaking API change from `<option>` children
  to an `options` prop). The **4 companion call sites are migrated in the same
  change** so typecheck/CI stays green. No parallel second select.
- **Accessibility bar:** match the existing controls — proper roles
  (listbox / combobox / grid), keyboard navigation, `aria-describedby` for
  hint/error, `aria-invalid` on error. Provided largely by react-aria.
- **Scope:** full family, all phases retained (user confirmed "keep all").

## Architecture

### Shared field primitives (new, `packages/ui/src/controls/field/`)

- `FieldLabel` — the `field-label` style (small caps label above a field).
- `FieldHint` — the `field-hint` style with `tone?: "default" | "error"`
  (error = Q1 color).
- `fieldChrome()` — supersedes `fieldClasses()`; adds the spec focus ring
  (**ink border + 3 px accent @ 18%**), an `error` state (Q1 border), and
  leading/trailing **adornment** padding. Re-exported so Input/Select/Textarea/
  pickers share one source of truth.
- `Field` — optional wrapper that composes `FieldLabel` + control + `FieldHint`
  and wires `htmlFor`/`id`, `aria-describedby`, `aria-invalid`.

### Upgraded components (additive, non-breaking)

- `Input` — add `leadingIcon?`, `error?`, `hint?`, the new focus ring. Existing
  props unchanged.
- `Textarea` — add `hint?`, `error?`, `minHeight`/rows; existing props unchanged.
- `NumberField` — add a trailing **unit adornment** (`unit?: string`, e.g. "KM").
  The km/mi `SegmentedControl` stays a _sibling_ (composition in the preview),
  per the spec: "unit toggle rides alongside the number field — never inside it."

### Rebuilt component (breaking, migrated)

- `Select` — react-aria `Select` + `ListBox` + `Popover`. New API:
  `options: { value: string; label: ReactNode }[]`, `value`, `onChange`,
  `tone`, `disabled`, `error?`, plus label/hint. Renders closed field with
  chevron (rotates 180° open); menu = 4 px pad / 10 radius / shadow-card;
  selected = ink fill + accent check; hover = paper fill. Migrate the 4
  companion files.

### New components

- `Combobox` — react-aria `ComboBox`. In-menu search input, "N matches" header,
  substring **accent-wash highlight** on matches, selected check. For >8 options.
  Public API mirrors `Select` plus async/filter hooks as needed.
- `DatePicker` — react-aria `DatePicker` + `Calendar`. Mono numerals,
  **today = accent ring**, **selected = ink fill**, dim adjacent-month days,
  chevron month nav. Value = ISO date string.
- `TimePicker` — 24h. Trigger field + popover with two scroll columns (HR / MIN)
  built on react-aria `ListBox`es. **Minutes snap to a configurable step,
  default 15.** Value = ISO time string.
- `DateTimePicker` — Calendar + inline `HH:MM` steppers below a divider.
  **Single** date-time only; the range shading in the mock is style reference
  and is **out of scope** (documented). Value = ISO datetime string.

### Preview (`apps/ui-preview/src/sections/Controls.tsx`)

- Rename heading to _"Toggle, segment, slider, radio — and the text-field
  family."_
- Add the "Text-field family" divider and blocks matching the screenshots:
  Input states (rest/placeholder, focus, leading icon, disabled, error+hint),
  Textarea + segmented-input pair, Select (closed & open), Combobox, and the
  three pickers. Existing toggle/segment/slider/radio/number-grid/swatch blocks
  stay.

## Testing

- vitest + React Testing Library per existing control test conventions.
- Per component: state/behaviour (value/onChange, disabled, error) and role
  assertions (`role="listbox"`/`combobox`/`grid`, `aria-invalid`,
  `aria-describedby`). Pickers: open/select/keyboard, minute-snap, ISO in/out
  round-trip.
- The ui-preview section is the visual check (not automated).

## Consumer / contract impact

- **Breaking:** `Select` API change → 4 companion files migrated in the same PR
  as the Select rebuild (P2).
- No backend/OpenAPI/shared-type impact (pure UI library).
- Bundle: `react-aria-components` is tree-shakeable; only imported pieces ship.
  Net add to the companion Worker is expected in the low-hundreds-of-KB gzip —
  comfortable under the 10 MiB cap, but **watch companion bundle size** after P2/P3.

## Phasing (one spec, staged reviewable PRs)

- **P1** — test harness + field primitives
  (`FieldLabel`/`FieldHint`/`fieldChrome`/`Field`) + Input / Textarea /
  NumberField upgrades + their preview blocks + tests. **No new runtime
  dependency** — only dev-only test deps.
- **P2** — add the runtime deps (`react-aria-components`,
  `@internationalized/date`) + Select rebuild + Combobox + migrate the 4
  companion Select call sites, plus preview blocks + tests.
- **P3** — DatePicker / TimePicker / DateTimePicker + preview blocks + tests.

## Out of scope

- Date/time **range** selection (single values only).
- Free-form color hex picker (design says curated swatches only — already exists).
- Native mobile (`apps/mobile`) equivalents — this is the web `@tarmoto/ui` only.
- Changing any backend / OpenAPI / shared contract.

## Risks

- **Bundle weight** from react-aria on the companion Worker (mitigated by
  tree-shaking; monitored after P2/P3).
- **Select migration** touching 4 companion components — covered by their
  existing tests + typecheck; migrate in-PR to avoid a broken intermediate state.
- **Pixel parity** of the bespoke calendar/time columns against headless
  react-aria — addressed by styling to tokens and checking against the preview
  screenshots.
