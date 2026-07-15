# UI Text-Field Family — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `Select` on `react-aria-components` (custom menu matching §09) and add a searchable `Combobox`, then migrate the 4 companion `Select` consumers to the new options-array API and preview both.

**Architecture:** Introduce `react-aria-components` as the first runtime dependency of `@tarmoto/ui`. `Select` and `Combobox` are headless react-aria primitives styled with the existing Tailwind tokens + the P1 `fieldChrome`/`FieldLabel`/`FieldHint` primitives. `Select`'s public API changes from `<option>` children to an `options` prop (breaking — the 4 companion call sites migrate in the same phase). Controlled value stays a `string`.

**Tech Stack:** React 19, TypeScript strict (`exactOptionalPropertyTypes`), Tailwind v4 tokens, `react-aria-components`. Test stack from P1 (Vitest + @testing-library/react + user-event).

## Global Constraints

- New runtime dependency: **`react-aria-components` only** (NOT `@internationalized/date` — that's P3, used solely by the date/time pickers). Add to `packages/ui` `dependencies`.
- Design tokens are Tailwind v4 classes from `theme.css`: `cream`/`paper`/`paper-2`/`ink`; `accent`; error `quality-q1`; text `fg-dim`/`fg-mute`; borders `line`/`line-strong`. No hardcoded hex.
- §09 Select spec: closed field reuses `fieldChrome`; chevron rotates 180° when open; menu = `p-1` (4px) + `rounded-[10px]` + `shadow-card`; selected option = ink fill + accent check; hover/focus option = paper fill. Combobox: in-menu search input, an "N matches" header, substring **accent-wash** highlight on matches, selected check; "use for >8 options".
- New public `SelectProps`: `{ value: string; onChange: (value: string) => void; options: { value: string; label: ReactNode }[]; id?; disabled?; tone?; error?; ariaLabel?; className? }`. Value stays a `string`; callers convert (e.g. `Number(v)`) at the call site, exactly as the old API required.
- a11y: react-aria provides listbox/combobox roles + keyboard nav; keep `aria-invalid` on error, associate label/hint. `exactOptionalPropertyTypes`: pass optional props via conditional spread when the value may be `undefined` (as established in P1).
- Migrate all 4 companion `Select` consumers in this phase so `pnpm --filter @tarmoto/companion typecheck` stays green. No behavior change at the call sites (same options, same value semantics).
- Tests assert behaviour/roles (open, select, filter, selected state), not class strings. Conventional commits, scope `cross`, lowercase subject.

## File Structure

- `packages/ui/src/controls/Select.tsx` — rebuilt (react-aria `Select`).
- `packages/ui/src/controls/Combobox.tsx` — new (react-aria `ComboBox`).
- `packages/ui/src/controls/__tests__/Select.test.tsx`, `Combobox.test.tsx` — new/updated.
- `packages/ui/src/controls/index.ts` — export `Combobox` + type; `Select` export unchanged in name.
- `apps/companion/src/components/{TripStopsPanel,TripCollaborateModal,PassesPanel,planner/RoundtripDialog}.tsx` — migrated call sites.
- `apps/ui-preview/src/sections/Controls.tsx` — Select (closed/open) + Combobox preview blocks.

---

### Task 1: Add `react-aria-components` + API smoke test

**Files:**

- Modify: `packages/ui/package.json`
- Test: `packages/ui/src/controls/__tests__/react-aria-smoke.test.tsx`

**Interfaces:**

- Produces: `react-aria-components` resolvable in `@tarmoto/ui`; confirms the exact component/prop names the later tasks depend on (`Select`, `Button`, `SelectValue`, `Popover`, `ListBox`, `ListBoxItem`, `selectedKey`, `onSelectionChange`).

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @tarmoto/ui add react-aria-components@^1`

- [ ] **Step 2: Write a smoke test that renders a minimal react-aria Select**

`packages/ui/src/controls/__tests__/react-aria-smoke.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Select,
  Button,
  SelectValue,
  Popover,
  ListBox,
  ListBoxItem,
} from "react-aria-components";

test("react-aria Select opens and selects by key", async () => {
  const onSelectionChange = vi.fn();
  render(
    <Select aria-label="demo" onSelectionChange={onSelectionChange}>
      <Button>
        <SelectValue />
      </Button>
      <Popover>
        <ListBox>
          <ListBoxItem id="a">Alpha</ListBoxItem>
          <ListBoxItem id="b">Bravo</ListBoxItem>
        </ListBox>
      </Popover>
    </Select>,
  );
  await userEvent.click(screen.getByRole("button"));
  await userEvent.click(screen.getByRole("option", { name: "Bravo" }));
  expect(onSelectionChange).toHaveBeenCalledWith("b");
});
```

- [ ] **Step 3: Run it — expect PASS**

Run: `pnpm --filter @tarmoto/ui test src/controls/__tests__/react-aria-smoke`
Expected: PASS. **If any import name or prop differs in the installed version, STOP and report the exact working API** — Tasks 2–3 must use the confirmed names.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/package.json packages/ui/src/controls/__tests__/react-aria-smoke.test.tsx pnpm-lock.yaml
git commit -m "feat(cross): add react-aria-components dependency to @tarmoto/ui"
```

---

### Task 2: Rebuild `Select` on react-aria

**Files:**

- Modify: `packages/ui/src/controls/Select.tsx`
- Test: `packages/ui/src/controls/__tests__/Select.test.tsx`

**Interfaces:**

- Consumes: `react-aria-components` (Task 1), `fieldChrome` from `./field/fieldChrome`.
- Produces:

  ```ts
  interface SelectOption {
    value: string;
    label: ReactNode;
  }
  interface SelectProps {
    value: string;
    onChange: (value: string) => void;
    options: SelectOption[];
    id?: string;
    disabled?: boolean;
    tone?: "paper" | "cream";
    error?: boolean;
    ariaLabel?: string;
    className?: string;
  }
  function Select(props: SelectProps): JSX.Element;
  ```

- [ ] **Step 1: Write the failing test**

`packages/ui/src/controls/__tests__/Select.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Select } from "../Select";

const OPTIONS = [
  { value: "any", label: "Any" },
  { value: "good", label: "Good or better" },
  { value: "excellent", label: "Excellent only" },
];

test("renders the selected value and reports changes by value", async () => {
  const onChange = vi.fn();
  render(
    <Select
      ariaLabel="quality"
      value="good"
      onChange={onChange}
      options={OPTIONS}
    />,
  );
  // closed field shows the selected label
  expect(
    screen.getByRole("button", { name: /Good or better/ }),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button"));
  await userEvent.click(screen.getByRole("option", { name: "Excellent only" }));
  expect(onChange).toHaveBeenCalledWith("excellent");
});

test("marks the current option selected", async () => {
  render(
    <Select
      ariaLabel="quality"
      value="good"
      onChange={() => {}}
      options={OPTIONS}
    />,
  );
  await userEvent.click(screen.getByRole("button"));
  expect(
    screen.getByRole("option", { name: "Good or better" }),
  ).toHaveAttribute("aria-selected", "true");
});

test("disabled prevents opening", async () => {
  render(
    <Select
      ariaLabel="q"
      value="any"
      onChange={() => {}}
      options={OPTIONS}
      disabled
    />,
  );
  expect(screen.getByRole("button")).toBeDisabled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tarmoto/ui test src/controls/__tests__/Select`
Expected: FAIL — the current native-select `Select` has no `options` prop / different structure.

- [ ] **Step 3: Rewrite `Select.tsx`**

Use the API confirmed in Task 1. Reference implementation:

```tsx
import type { ReactNode } from "react";
import {
  Select as AriaSelect,
  Button,
  SelectValue,
  Popover,
  ListBox,
  ListBoxItem,
} from "react-aria-components";
import { cn } from "../utils/cn";
import { fieldChrome } from "./field/fieldChrome";

export interface SelectOption {
  value: string;
  label: ReactNode;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  id?: string;
  disabled?: boolean;
  tone?: "paper" | "cream";
  error?: boolean;
  ariaLabel?: string;
  className?: string;
}

/**
 * Select · single-choice dropdown (§09). react-aria `Select` styled with the
 * shared field chrome: chevron rotates 180° open; menu is paper-carded;
 * selected option = ink fill + accent check; hover/focus = paper fill.
 * Value stays a string — convert (e.g. `Number(v)`) at the call site.
 */
export function Select({
  value,
  onChange,
  options,
  id,
  disabled = false,
  tone = "paper",
  error = false,
  ariaLabel,
  className,
}: SelectProps) {
  return (
    <AriaSelect
      id={id}
      aria-label={ariaLabel}
      aria-invalid={error || undefined}
      isDisabled={disabled}
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key))}
      className={cn("relative w-full", className)}
    >
      <Button
        className={cn(
          fieldChrome({ tone, disabled, error, hasTrailing: true }),
          "flex items-center justify-between text-left",
          !disabled && "cursor-pointer hover:border-ink/40",
        )}
      >
        <SelectValue className="truncate data-[placeholder]:text-fg-mute" />
        <svg
          aria-hidden="true"
          className="pointer-events-none size-3 text-fg-mute transition-transform group-data-[open]:rotate-180"
          viewBox="0 0 12 8"
          fill="none"
        >
          <path
            d="M1 1l5 5 5-5"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        </svg>
      </Button>
      <Popover
        className={cn(
          "w-[--trigger-width] rounded-[10px] border border-line-strong bg-paper p-1 shadow-card",
          "entering:animate-in exiting:animate-out",
        )}
      >
        <ListBox className="outline-none">
          {options.map((opt) => (
            <ListBoxItem
              key={opt.value}
              id={opt.value}
              textValue={typeof opt.label === "string" ? opt.label : opt.value}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm text-ink outline-none",
                "data-[hovered]:bg-paper-2 data-[focused]:bg-paper-2",
                "data-[selected]:bg-ink data-[selected]:text-cream",
              )}
            >
              {({ isSelected }) => (
                <>
                  <span className="truncate">{opt.label}</span>
                  {isSelected && (
                    <svg
                      aria-hidden="true"
                      className="size-3.5 text-accent"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.4}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </>
              )}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}
```

Notes for the implementer: verify against the Task-1-confirmed API. The chevron `group-data-[open]` hook requires the `Button`/`Select` to expose an `open` data attribute — if the installed version differs, use a render-prop on `AriaSelect` (`{({ isOpen }) => ...}`) to toggle the rotation class. `shadow-card` must exist in the theme; if not, substitute the nearest existing shadow token and note it. Keep the selected-check `text-accent` on the ink fill (accent on ink is per §09).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tarmoto/ui test src/controls/__tests__/Select`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tarmoto/ui typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/controls/Select.tsx packages/ui/src/controls/__tests__/Select.test.tsx
git commit -m "feat(cross): rebuild Select on react-aria with the §09 custom menu"
```

---

### Task 3: `Combobox` (searchable select)

**Files:**

- Create: `packages/ui/src/controls/Combobox.tsx`
- Modify: `packages/ui/src/controls/index.ts`
- Test: `packages/ui/src/controls/__tests__/Combobox.test.tsx`

**Interfaces:**

- Produces:

  ```ts
  interface ComboboxProps {
    value: string;
    onChange: (value: string) => void;
    options: SelectOption[]; // reuse SelectOption from Select
    id?: string;
    disabled?: boolean;
    tone?: "paper" | "cream";
    error?: boolean;
    ariaLabel?: string;
    placeholder?: string;
    className?: string;
  }
  function Combobox(props: ComboboxProps): JSX.Element;
  ```

  `Select` exports `SelectOption`; `Combobox` imports and re-uses it. Barrel exports `Combobox` + `ComboboxProps`.

- [ ] **Step 1: Write the failing test**

`packages/ui/src/controls/__tests__/Combobox.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Combobox } from "../Combobox";

const CITIES = [
  { value: "prague", label: "Prague, CZ" },
  { value: "prachatice", label: "Prachatice, CZ" },
  { value: "ostrava", label: "Ostrava, CZ" },
];

test("filters options as the user types and selects by value", async () => {
  const onChange = vi.fn();
  render(
    <Combobox
      ariaLabel="region"
      value=""
      onChange={onChange}
      options={CITIES}
    />,
  );
  const input = screen.getByRole("combobox", { name: "region" });
  await userEvent.type(input, "Pra");
  // Ostrava filtered out; the two Pra* remain
  expect(
    screen.getByRole("option", { name: "Prague, CZ" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: "Ostrava, CZ" }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("option", { name: "Prague, CZ" }));
  expect(onChange).toHaveBeenCalledWith("prague");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tarmoto/ui test src/controls/__tests__/Combobox`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `Combobox.tsx`**

Use the react-aria `ComboBox` primitive with client-side substring filtering, an "N matches" header, and an accent-wash substring highlight. Reference implementation:

```tsx
import { useMemo, useState, type ReactNode } from "react";
import {
  ComboBox as AriaComboBox,
  Input,
  Button,
  Popover,
  ListBox,
  ListBoxItem,
} from "react-aria-components";
import { cn } from "../utils/cn";
import { fieldChrome } from "./field/fieldChrome";
import type { SelectOption } from "./Select";

export interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  id?: string;
  disabled?: boolean;
  tone?: "paper" | "cream";
  error?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
}

function labelText(label: ReactNode, fallback: string): string {
  return typeof label === "string" ? label : fallback;
}

/** Highlights the matched substring with an accent wash. */
function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <span className="rounded-[3px] bg-accent/[0.14] text-ink">
        {text.slice(i, i + query.length)}
      </span>
      {text.slice(i + query.length)}
    </>
  );
}

/**
 * Combobox · searchable select (§09). Use for >8 options. Type filters the
 * list; the matched substring gets an accent-wash highlight; an "N matches"
 * header sits above the options; the selected option carries an accent check.
 */
export function Combobox({
  value,
  onChange,
  options,
  id,
  disabled = false,
  tone = "paper",
  error = false,
  ariaLabel,
  placeholder,
  className,
}: ComboboxProps) {
  const selected = options.find((o) => o.value === value);
  const [query, setQuery] = useState(labelText(selected?.label, ""));

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      labelText(o.label, o.value).toLowerCase().includes(q),
    );
  }, [options, query]);

  return (
    <AriaComboBox
      id={id}
      aria-label={ariaLabel}
      aria-invalid={error || undefined}
      isDisabled={disabled}
      selectedKey={value || null}
      inputValue={query}
      onInputChange={setQuery}
      onSelectionChange={(key) => {
        if (key != null) onChange(String(key));
      }}
      items={matches}
      className={cn("relative w-full", className)}
      allowsEmptyCollection
    >
      <div className="relative">
        <Input
          placeholder={placeholder}
          className={fieldChrome({ tone, disabled, error, hasTrailing: true })}
        />
        <Button
          aria-hidden="true"
          tabIndex={-1}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-mute"
        >
          <svg className="size-3" viewBox="0 0 12 8" fill="none">
            <path
              d="M1 1l5 5 5-5"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          </svg>
        </Button>
      </div>
      <Popover className="w-[--trigger-width] rounded-[10px] border border-line-strong bg-paper p-1 shadow-card">
        <div className="px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-fg-mute">
          {matches.length} {matches.length === 1 ? "match" : "matches"}
        </div>
        <ListBox className="outline-none">
          {(opt: SelectOption) => (
            <ListBoxItem
              id={opt.value}
              textValue={labelText(opt.label, opt.value)}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm text-ink outline-none",
                "data-[hovered]:bg-paper-2 data-[focused]:bg-paper-2",
                "data-[selected]:bg-ink data-[selected]:text-cream",
              )}
            >
              {({ isSelected }) => (
                <>
                  <span className="truncate">
                    {highlight(labelText(opt.label, opt.value), query)}
                  </span>
                  {isSelected && (
                    <svg
                      aria-hidden="true"
                      className="size-3.5 text-accent"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.4}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaComboBox>
  );
}
```

Notes for the implementer: verify the ComboBox controlled props (`selectedKey`/`inputValue`/`onInputChange`/`onSelectionChange`/`items`/`allowsEmptyCollection`) against the Task-1 installed version. If react-aria's built-in filtering conflicts with the manual `matches` filtering, prefer the manual filter (we own the "N matches" + highlight). The highlight `bg-accent/[0.14]` is the accent-wash; adjust only if a token is missing.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tarmoto/ui test src/controls/__tests__/Combobox`
Expected: PASS.

- [ ] **Step 5: Export from the barrel**

In `packages/ui/src/controls/index.ts`, add:

```ts
export { Combobox, type ComboboxProps } from "./Combobox";
export { type SelectOption } from "./Select";
```

(Keep the existing `Select` export; update it to also export `SelectProps`/`SelectOption` if not already.)

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @tarmoto/ui typecheck` (expect clean), then:

```bash
git add packages/ui/src/controls/Combobox.tsx packages/ui/src/controls/index.ts packages/ui/src/controls/__tests__/Combobox.test.tsx packages/ui/src/controls/Select.tsx
git commit -m "feat(cross): add searchable Combobox to @tarmoto/ui"
```

---

### Task 4: Migrate the 4 companion `Select` call sites

**Files:**

- Modify: `apps/companion/src/components/TripStopsPanel.tsx:318`
- Modify: `apps/companion/src/components/TripCollaborateModal.tsx:681`
- Modify: `apps/companion/src/components/PassesPanel.tsx:215`
- Modify: `apps/companion/src/components/planner/RoundtripDialog.tsx:172`

**Interfaces:**

- Consumes: the new `Select` `options` API (Task 2). Each migration replaces `<option>` children with an `options={[...]}` prop; `value`/`onChange` stay as-is (onChange still receives a `string`).

- [ ] **Step 1: Read each call site and convert `<option>` children to `options`**

Mapping (preserve labels, values, and any `t()` calls exactly):

- **TripStopsPanel** — `options={[{ value: "", label: t("Any") }, { value: "3", label: t("3 stars or better") }, { value: "4", label: t("4 stars or better") }, { value: "5", label: t("5 stars only") }]}`.
- **TripCollaborateModal** — `options={[{ value: "editor", label: t("Editor") }, { value: "viewer", label: t("Viewer") }]}`.
- **PassesPanel** — the current `<option key={name} value={idx + 1}>` becomes `options={passes.map((name, idx) => ({ value: String(idx + 1), label: name }))}` (value is now a string; the existing `onChange` already receives a string — keep whatever `Number()` conversion the handler does).
- **RoundtripDialog** — `options={options.map((option) => ({ value: option, label: option }))}` (rename the local array if it collides with the prop name).

Keep every other prop (`value`, `onChange`, `id`, `tone`, `disabled`, `ariaLabel`) unchanged.

- [ ] **Step 2: Typecheck the companion**

Run: `pnpm --filter @tarmoto/companion typecheck`
Expected: clean. If a call site passed a numeric `value` to `Select`, coerce with `String(...)` at the prop (the new `value` is a `string`).

- [ ] **Step 3: Run any existing tests over the touched components**

Run: `pnpm --filter @tarmoto/companion test -- TripCollaborateModal PassesPanel TripStopsPanel RoundtripDialog 2>/dev/null || pnpm --filter @tarmoto/companion test`
Expected: pass (or no tests for these — note which).

- [ ] **Step 4: Commit**

```bash
git add apps/companion/src/components/TripStopsPanel.tsx apps/companion/src/components/TripCollaborateModal.tsx apps/companion/src/components/PassesPanel.tsx apps/companion/src/components/planner/RoundtripDialog.tsx
git commit -m "refactor(companion): migrate Select consumers to the options API"
```

---

### Task 5: Preview — Select (closed & open) + Combobox blocks

**Files:**

- Modify: `apps/ui-preview/src/sections/Controls.tsx`

**Interfaces:**

- Consumes: `Select`, `Combobox` from `@tarmoto/ui`; existing card/`SubStamp`/`FieldLabel`/`useState` conventions in the file.

- [ ] **Step 1: Add a "Select" card and a "Combobox" card after the text-field blocks**

Import `Select`, `Combobox` (merge into the existing `@tarmoto/ui` import). Using the file's existing card/state pattern:

- **Select · closed & open**: two `FieldLabel`+`Select` demos with the quality options (`Any` / `Fair or better` / `Good or better` / `Excellent only`), stateful `value`.
- **Searchable select · combobox**: a `FieldLabel`+`Combobox` "Home region" demo over a handful of CZ cities, with a `field-hint` ("Type filters the list… Use for > 8 options.").

Mirror the existing card structure; do not invent new section primitives.

- [ ] **Step 2: Build the preview**

Run: `pnpm --filter @tarmoto/ui-preview build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add apps/ui-preview/src/sections/Controls.tsx
git commit -m "feat(cross): preview the react-aria Select and Combobox"
```

---

### Task 6: P2 wrap-up — full verification

**Files:** none (verification only)

- [ ] **Step 1:** `pnpm --filter @tarmoto/ui test && pnpm --filter @tarmoto/ui typecheck` — expect all pass.
- [ ] **Step 2:** `pnpm --filter @tarmoto/companion typecheck` — expect clean (migration complete).
- [ ] **Step 3:** `pnpm --filter @tarmoto/ui-preview build` — expect success.
- [ ] **Step 4:** Check the companion bundle didn't blow past expectations — note `react-aria-components` is now in the companion graph via `@tarmoto/ui` (it was tree-shakeable in the design; confirm no unexpected size regression if a build is run).
- [ ] **Step 5:** Push the branch and open a PR referencing the design spec; call out the breaking `Select` API change + the 4 migrated consumers + the new runtime dep.

---

## Out of scope (P3)

- `DatePicker` / `TimePicker` / `DateTimePicker` and the `@internationalized/date` dependency.

## Self-review notes

- **Spec coverage:** P2 covers §"Rebuilt component (Select)" and §"New components (Combobox)" plus their preview slice and the companion migration. ✅
- **Placeholder scan:** react-aria code blocks are complete reference implementations; Tasks 2–3 flag that the implementer must confirm exact prop names against the Task-1-installed version (external-lib reality) and adjust the two named hooks (open-state chevron, shadow token) if they differ — these are concrete, bounded verifications, not open TODOs. ✅
- **Type consistency:** `SelectOption`/`SelectProps`/`ComboboxProps` are defined in Task 2/3 and consumed identically in the migration (Task 4) and preview (Task 5). Value is a `string` throughout. ✅
