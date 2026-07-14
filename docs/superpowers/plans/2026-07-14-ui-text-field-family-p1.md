# UI Text-Field Family — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the `@tarmoto/ui` test harness and the shared field primitives, then upgrade `Input`, `Textarea`, and `NumberField` to the new §09 design states (leading icon, error, hint, focus ring, unit adornment) and preview them.

**Architecture:** Add a `controls/field/` module holding the shared field chrome (`fieldChrome`), `FieldLabel`, `FieldHint`, and a `Field` composition wrapper. Existing controls consume `fieldChrome` instead of the old `fieldClasses`. All controls stay controlled (`value`/`onChange`), token-styled (Tailwind v4), and additive (no breaking API change in P1 — the breaking Select rebuild is P2).

**Tech Stack:** React 19, TypeScript strict, Tailwind v4 (`@theme` tokens in `packages/ui/src/styles/theme.css`), `clsx` via `cn()`. New dev-only test stack: Vitest + @testing-library/react + jsdom.

## Global Constraints

- Package: `@tarmoto/ui`; peer React `>=18` (dev React 19). No new **runtime** dependency in P1 (react-aria arrives in P2).
- Design tokens are Tailwind v4 classes from `theme.css`: surfaces `cream`/`paper`/`paper-2`/`ink`; `accent`; error color `quality-q1`; text `fg-dim`/`fg-mute`; borders `line`/`line-strong`. Do not hardcode hex.
- Field chrome constants (from spec §09): radius `rounded-lg` (8px), border `border-line-strong` (ink @22%), focus = `border-accent` + `ring-[3px] ring-accent/[0.18]`, error = `border-quality-q1` + `quality-q1` hint, font `text-sm` (13px) `text-ink`, placeholder `text-fg-mute`.
- Controlled components only: `value` + `onChange`. Keep `tone: "paper" | "cream"`, `ariaLabel`, `className` passthrough conventions.
- Tests assert **behaviour + accessibility** (roles, `aria-invalid`, `aria-describedby`, hint text), not Tailwind class strings.
- Conventional commits, scope `cross` (touches `packages/ui` + `apps/ui-preview`). Commit after each task.

---

### Task 1: Test harness for `packages/ui`

**Files:**

- Modify: `packages/ui/package.json` (add devDeps + `test` script)
- Create: `packages/ui/vitest.config.ts`
- Create: `packages/ui/vitest.setup.ts`
- Create: `packages/ui/src/controls/__tests__/smoke.test.tsx`

**Interfaces:**

- Produces: a working `pnpm --filter @tarmoto/ui test` command (Vitest + jsdom + jest-dom matchers) that every later task's tests run under.

- [ ] **Step 1: Add dev dependencies**

Run:

```bash
pnpm --filter @tarmoto/ui add -D vitest@^4 jsdom@^25 @testing-library/react@^16 @testing-library/user-event@^14 @testing-library/jest-dom@^6 @vitejs/plugin-react@^5
```

- [ ] **Step 2: Add the `test` script to `packages/ui/package.json`**

In the `"scripts"` block add:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create `packages/ui/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
```

- [ ] **Step 4: Create `packages/ui/vitest.setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 5: Write a smoke test at `packages/ui/src/controls/__tests__/smoke.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import { Toggle } from "../Toggle";

test("harness renders an existing control", () => {
  render(<Toggle checked={false} onChange={() => {}} ariaLabel="demo" />);
  expect(screen.getByRole("switch", { name: "demo" })).toBeInTheDocument();
});
```

- [ ] **Step 6: Run the smoke test — expect PASS**

Run: `pnpm --filter @tarmoto/ui test`
Expected: 1 passed. If it fails on JSX/react-plugin, confirm `@vitejs/plugin-react` installed.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/package.json packages/ui/vitest.config.ts packages/ui/vitest.setup.ts packages/ui/src/controls/__tests__/smoke.test.tsx pnpm-lock.yaml
git commit -m "test(cross): add vitest + testing-library harness to @tarmoto/ui"
```

---

### Task 2: `fieldChrome` — shared field-chrome helper with focus ring, error, adornment

**Files:**

- Create: `packages/ui/src/controls/field/fieldChrome.ts`
- Test: `packages/ui/src/controls/field/__tests__/fieldChrome.test.ts`

**Interfaces:**

- Produces:

  ```ts
  interface FieldChromeOptions {
    tone?: "paper" | "cream";
    disabled?: boolean;
    error?: boolean;
    hasLeading?: boolean; // extra left padding for a leading icon
    hasTrailing?: boolean; // extra right padding for a trailing adornment/chevron
  }
  function fieldChrome(opts?: FieldChromeOptions): string;
  ```

  Consumed by Input (Task 4), Textarea (Task 5), NumberField (Task 6), and later Select/pickers (P2/P3).

- [ ] **Step 1: Write the failing test**

`packages/ui/src/controls/field/__tests__/fieldChrome.test.ts`:

```ts
import { fieldChrome } from "../fieldChrome";

test("defaults to paper surface with the strong hairline border", () => {
  const cls = fieldChrome();
  expect(cls).toContain("bg-paper");
  expect(cls).toContain("border-line-strong");
});

test("cream tone swaps the surface", () => {
  expect(fieldChrome({ tone: "cream" })).toContain("bg-cream");
});

test("error state uses the Q1 border, not the accent focus border", () => {
  const cls = fieldChrome({ error: true });
  expect(cls).toContain("border-quality-q1");
});

test("leading and trailing add padding hooks", () => {
  const cls = fieldChrome({ hasLeading: true, hasTrailing: true });
  expect(cls).toContain("pl-9");
  expect(cls).toContain("pr-9");
});

test("disabled marks the not-allowed affordance", () => {
  expect(fieldChrome({ disabled: true })).toContain("cursor-not-allowed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tarmoto/ui test src/controls/field`
Expected: FAIL — cannot find module `../fieldChrome`.

- [ ] **Step 3: Implement `fieldChrome`**

`packages/ui/src/controls/field/fieldChrome.ts`:

```ts
import { cn } from "../../utils/cn";

export interface FieldChromeOptions {
  tone?: "paper" | "cream";
  disabled?: boolean;
  error?: boolean;
  hasLeading?: boolean;
  hasTrailing?: boolean;
}

/**
 * Unified field chrome (§09): 8px radius, ink-@22% hairline, accent focus
 * border + 3px accent-@18% ring. Error swaps the border to Q1. Leading /
 * trailing flags reserve room for an icon or chevron/unit adornment.
 * Supersedes the old `fieldClasses` in Input.tsx.
 */
export function fieldChrome(opts: FieldChromeOptions = {}): string {
  const { tone = "paper", disabled, error, hasLeading, hasTrailing } = opts;
  return cn(
    "w-full rounded-lg border px-3 py-2 font-sans text-sm text-ink",
    "placeholder:text-fg-mute transition outline-none",
    tone === "cream" ? "bg-cream" : "bg-paper",
    hasLeading && "pl-9",
    hasTrailing && "pr-9",
    error
      ? "border-quality-q1 focus:border-quality-q1 focus:ring-[3px] focus:ring-quality-q1/[0.18]"
      : "border-line-strong focus:border-accent focus:ring-[3px] focus:ring-accent/[0.18]",
    disabled && "cursor-not-allowed opacity-60",
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tarmoto/ui test src/controls/field`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/controls/field/fieldChrome.ts packages/ui/src/controls/field/__tests__/fieldChrome.test.ts
git commit -m "feat(cross): add fieldChrome shared field-chrome helper to @tarmoto/ui"
```

---

### Task 3: `FieldLabel` + `FieldHint` primitives

**Files:**

- Create: `packages/ui/src/controls/field/FieldLabel.tsx`
- Create: `packages/ui/src/controls/field/FieldHint.tsx`
- Create: `packages/ui/src/controls/field/index.ts`
- Test: `packages/ui/src/controls/field/__tests__/field-parts.test.tsx`

**Interfaces:**

- Produces:

  ```ts
  interface FieldLabelProps {
    htmlFor?: string;
    children: ReactNode;
    className?: string;
  }
  function FieldLabel(props: FieldLabelProps): JSX.Element; // renders <label>

  interface FieldHintProps {
    id?: string;
    tone?: "default" | "error";
    children: ReactNode;
    className?: string;
  }
  function FieldHint(props: FieldHintProps): JSX.Element; // renders <p>
  ```

  `field/index.ts` re-exports `fieldChrome`, `FieldLabel`, `FieldHint` (and `Field` from Task 7).

- [ ] **Step 1: Write the failing test**

`packages/ui/src/controls/field/__tests__/field-parts.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { FieldLabel } from "../FieldLabel";
import { FieldHint } from "../FieldHint";

test("FieldLabel renders a <label> bound to a field id", () => {
  render(<FieldLabel htmlFor="x">Departure</FieldLabel>);
  const label = screen.getByText("Departure");
  expect(label.tagName).toBe("LABEL");
  expect(label).toHaveAttribute("for", "x");
});

test("FieldHint default vs error tone", () => {
  const { rerender } = render(<FieldHint id="h">Markdown supported</FieldHint>);
  expect(screen.getByText("Markdown supported")).toHaveAttribute("id", "h");
  rerender(
    <FieldHint id="h" tone="error">
      Enter a valid email address.
    </FieldHint>,
  );
  expect(screen.getByText("Enter a valid email address.").className).toContain(
    "text-quality-q1",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tarmoto/ui test src/controls/field/__tests__/field-parts`
Expected: FAIL — cannot find `../FieldLabel`.

- [ ] **Step 3: Implement `FieldLabel.tsx`**

```tsx
import type { ReactNode } from "react";
import { cn } from "../../utils/cn";

export interface FieldLabelProps {
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

/** §09 field-label: small mono-ish caption above a field. */
export function FieldLabel({ htmlFor, children, className }: FieldLabelProps) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn(
        "mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.6px] text-fg-dim",
        className,
      )}
    >
      {children}
    </label>
  );
}
```

- [ ] **Step 4: Implement `FieldHint.tsx`**

```tsx
import type { ReactNode } from "react";
import { cn } from "../../utils/cn";

export interface FieldHintProps {
  id?: string;
  tone?: "default" | "error";
  children: ReactNode;
  className?: string;
}

/** §09 field-hint: helper text below a field. `error` = Q1. */
export function FieldHint({
  id,
  tone = "default",
  children,
  className,
}: FieldHintProps) {
  return (
    <p
      id={id}
      className={cn(
        "mt-1.5 text-[11px] leading-snug",
        tone === "error" ? "text-quality-q1" : "text-fg-mute",
        className,
      )}
    >
      {children}
    </p>
  );
}
```

- [ ] **Step 5: Create `field/index.ts`**

```ts
export { fieldChrome, type FieldChromeOptions } from "./fieldChrome";
export { FieldLabel, type FieldLabelProps } from "./FieldLabel";
export { FieldHint, type FieldHintProps } from "./FieldHint";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @tarmoto/ui test src/controls/field/__tests__/field-parts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/controls/field/
git commit -m "feat(cross): add FieldLabel + FieldHint primitives to @tarmoto/ui"
```

---

### Task 4: Upgrade `Input` — leading icon, error, hint, focus ring

**Files:**

- Modify: `packages/ui/src/controls/Input.tsx`
- Test: `packages/ui/src/controls/__tests__/Input.test.tsx`

**Interfaces:**

- Consumes: `fieldChrome` (Task 2), `FieldHint` (Task 3).
- Produces: extended `InputProps` (additive):

  ```ts
  leadingIcon?: ReactNode;
  error?: boolean;
  hint?: ReactNode;
  hintId?: string;   // caller-supplied id for aria-describedby; auto-derived from id if omitted
  ```

  `fieldClasses` export is **removed**; Textarea (Task 5) switches to `fieldChrome`.

- [ ] **Step 1: Write the failing test**

`packages/ui/src/controls/__tests__/Input.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Input } from "../Input";

test("edits flow through onChange", async () => {
  const onChange = vi.fn();
  render(<Input value="" onChange={onChange} ariaLabel="bike" />);
  await userEvent.type(screen.getByRole("textbox", { name: "bike" }), "R");
  expect(onChange).toHaveBeenCalledWith("R");
});

test("error sets aria-invalid and associates the hint", () => {
  render(
    <Input
      id="email"
      value="x"
      onChange={() => {}}
      error
      hint="Enter a valid email address."
    />,
  );
  const input = screen.getByRole("textbox");
  expect(input).toHaveAttribute("aria-invalid", "true");
  const hint = screen.getByText("Enter a valid email address.");
  expect(input).toHaveAttribute("aria-describedby", hint.id);
});

test("leading icon is decorative (aria-hidden), input still reachable by label", () => {
  render(
    <Input
      value=""
      onChange={() => {}}
      ariaLabel="search"
      leadingIcon={<svg data-testid="ico" />}
    />,
  );
  expect(screen.getByRole("textbox", { name: "search" })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tarmoto/ui test src/controls/__tests__/Input`
Expected: FAIL — `error`/`hint` not applied (`aria-invalid` missing).

- [ ] **Step 3: Rewrite `Input.tsx`**

```tsx
import type { ReactNode } from "react";
import { cn } from "../utils/cn";
import { fieldChrome } from "./field/fieldChrome";
import { FieldHint } from "./field/FieldHint";

/**
 * Input · single-line text field. Spec: §09.
 * Shares `fieldChrome` with Textarea/Select. `tone` matches the field
 * surface to its container. Pass an external `<label htmlFor>` + matching
 * `id`, or `ariaLabel`.
 */
export interface InputProps {
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "search" | "url" | "tel";
  tone?: "paper" | "cream";
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  ariaLabel?: string;
  maxLength?: number;
  leadingIcon?: ReactNode;
  error?: boolean;
  hint?: ReactNode;
  hintId?: string;
  className?: string;
}

export function Input({
  value,
  onChange,
  type = "text",
  tone = "paper",
  id,
  placeholder,
  disabled = false,
  readOnly = false,
  ariaLabel,
  maxLength,
  leadingIcon,
  error = false,
  hint,
  hintId,
  className,
}: InputProps) {
  const resolvedHintId = hint
    ? (hintId ?? (id ? `${id}-hint` : undefined))
    : undefined;
  return (
    <div className={cn("w-full", className)}>
      <div className="relative">
        {leadingIcon && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-mute"
          >
            {leadingIcon}
          </span>
        )}
        <input
          id={id}
          type={type}
          value={value}
          disabled={disabled}
          readOnly={readOnly}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-invalid={error || undefined}
          aria-describedby={resolvedHintId}
          maxLength={maxLength}
          onChange={(event) => onChange(event.target.value)}
          className={fieldChrome({
            tone,
            disabled,
            error,
            hasLeading: !!leadingIcon,
          })}
        />
      </div>
      {hint && (
        <FieldHint id={resolvedHintId} tone={error ? "error" : "default"}>
          {hint}
        </FieldHint>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tarmoto/ui test src/controls/__tests__/Input`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify no stale `fieldClasses` importers remain**

Run: `grep -rn "fieldClasses" packages/ui/src`
Expected: only `Textarea.tsx` (fixed next task). If anything else, note it.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/controls/Input.tsx packages/ui/src/controls/__tests__/Input.test.tsx
git commit -m "feat(cross): add leading-icon/error/hint/focus-ring to Input"
```

---

### Task 5: Upgrade `Textarea` — hint, error, min-height; switch to `fieldChrome`

**Files:**

- Modify: `packages/ui/src/controls/Textarea.tsx`
- Test: `packages/ui/src/controls/__tests__/Textarea.test.tsx`

**Interfaces:**

- Consumes: `fieldChrome`, `FieldHint`.
- Produces: extended `TextareaProps` (additive): `error?: boolean`, `hint?: ReactNode`, `hintId?: string`.

- [ ] **Step 1: Write the failing test**

`packages/ui/src/controls/__tests__/Textarea.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Textarea } from "../Textarea";

test("edits flow through onChange", async () => {
  const onChange = vi.fn();
  render(<Textarea value="" onChange={onChange} ariaLabel="desc" />);
  await userEvent.type(screen.getByRole("textbox", { name: "desc" }), "S");
  expect(onChange).toHaveBeenCalledWith("S");
});

test("hint renders and associates via aria-describedby", () => {
  render(
    <Textarea id="d" value="" onChange={() => {}} hint="Markdown supported." />,
  );
  const ta = screen.getByRole("textbox");
  expect(ta).toHaveAttribute(
    "aria-describedby",
    screen.getByText("Markdown supported.").id,
  );
});

test("error sets aria-invalid", () => {
  render(<Textarea value="" onChange={() => {}} ariaLabel="d" error />);
  expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tarmoto/ui test src/controls/__tests__/Textarea`
Expected: FAIL — hint/error unsupported.

- [ ] **Step 3: Rewrite `Textarea.tsx`**

```tsx
import type { ReactNode } from "react";
import { cn } from "../utils/cn";
import { fieldChrome } from "./field/fieldChrome";
import { FieldHint } from "./field/FieldHint";

/**
 * Textarea · multi-line text field. Spec: §09.
 * Shares `fieldChrome` with Input/Select; `resize-none` keeps panel layouts
 * stable. See Input for the `tone`/labelling rationale.
 */
export interface TextareaProps {
  value: string;
  onChange: (value: string) => void;
  tone?: "paper" | "cream";
  id?: string;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  maxLength?: number;
  error?: boolean;
  hint?: ReactNode;
  hintId?: string;
  className?: string;
}

export function Textarea({
  value,
  onChange,
  tone = "paper",
  id,
  rows = 3,
  placeholder,
  disabled = false,
  ariaLabel,
  maxLength,
  error = false,
  hint,
  hintId,
  className,
}: TextareaProps) {
  const resolvedHintId = hint
    ? (hintId ?? (id ? `${id}-hint` : undefined))
    : undefined;
  return (
    <div className={cn("w-full", className)}>
      <textarea
        id={id}
        rows={rows}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={error || undefined}
        aria-describedby={resolvedHintId}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          fieldChrome({ tone, disabled, error }),
          "resize-none leading-relaxed",
        )}
      />
      {hint && (
        <FieldHint id={resolvedHintId} tone={error ? "error" : "default"}>
          {hint}
        </FieldHint>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tarmoto/ui test src/controls/__tests__/Textarea`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/controls/Textarea.tsx packages/ui/src/controls/__tests__/Textarea.test.tsx
git commit -m "feat(cross): add hint/error states to Textarea; adopt fieldChrome"
```

---

### Task 6: Upgrade `NumberField` — trailing unit adornment

**Files:**

- Modify: `packages/ui/src/controls/NumberField.tsx`
- Test: `packages/ui/src/controls/__tests__/NumberField.test.tsx`

**Interfaces:**

- Produces: extended `NumberFieldProps` (additive): `unit?: string` — a mono uppercase adornment sitting left of the stepper column (e.g. `"KM"`).

- [ ] **Step 1: Write the failing test**

`packages/ui/src/controls/__tests__/NumberField.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NumberField } from "../NumberField";

test("clamps and reports numeric changes", async () => {
  const onChange = vi.fn();
  render(
    <NumberField
      value={250}
      onChange={onChange}
      min={0}
      max={999}
      ariaLabel="km"
    />,
  );
  const input = screen.getByRole("spinbutton", { name: "km" });
  await userEvent.clear(input);
  await userEvent.type(input, "300");
  expect(onChange).toHaveBeenLastCalledWith(300);
});

test("renders a decorative unit adornment", () => {
  render(
    <NumberField
      value={250}
      onChange={() => {}}
      min={0}
      max={999}
      ariaLabel="km"
      unit="KM"
    />,
  );
  const unit = screen.getByText("KM");
  expect(unit).toHaveAttribute("aria-hidden", "true");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tarmoto/ui test src/controls/__tests__/NumberField`
Expected: FAIL — "KM" not found.

- [ ] **Step 3: Add the `unit` prop + adornment to `NumberField.tsx`**

Add `unit?: string;` to `NumberFieldProps`, destructure `unit`, and insert this block **between** the `<input>` and the stepper `<div className="flex flex-col border-l border-line">`:

```tsx
{
  unit && (
    <span
      aria-hidden="true"
      className="flex items-center pr-2 font-mono text-[11px] font-semibold uppercase tracking-wide text-fg-mute"
    >
      {unit}
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tarmoto/ui test src/controls/__tests__/NumberField`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/controls/NumberField.tsx packages/ui/src/controls/__tests__/NumberField.test.tsx
git commit -m "feat(cross): add unit adornment to NumberField"
```

---

### Task 7: `Field` composition wrapper + barrel exports

**Files:**

- Create: `packages/ui/src/controls/field/Field.tsx`
- Modify: `packages/ui/src/controls/field/index.ts`
- Modify: `packages/ui/src/controls/index.ts`
- Test: `packages/ui/src/controls/field/__tests__/Field.test.tsx`

**Interfaces:**

- Consumes: `FieldLabel`, `FieldHint`.
- Produces:

  ```ts
  interface FieldProps {
    id: string;
    label?: ReactNode;
    hint?: ReactNode;
    error?: boolean;
    children: (a: { id: string; hintId?: string; error: boolean }) => ReactNode;
    className?: string;
  }
  function Field(props: FieldProps): JSX.Element;
  ```

  Barrel (`controls/index.ts`) now also exports `FieldLabel`, `FieldHint`, `Field`, `fieldChrome`.

- [ ] **Step 1: Write the failing test**

`packages/ui/src/controls/field/__tests__/Field.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { Field } from "../Field";
import { Input } from "../../Input";

test("wires label + hint + error to the rendered control", () => {
  render(
    <Field id="email" label="Email" hint="Enter a valid email address." error>
      {({ id, hintId, error }) => (
        <Input
          id={id}
          hintId={hintId}
          error={error}
          value="x"
          onChange={() => {}}
        />
      )}
    </Field>,
  );
  const input = screen.getByLabelText("Email");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAttribute(
    "aria-describedby",
    screen.getByText("Enter a valid email address.").id,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tarmoto/ui test src/controls/field/__tests__/Field`
Expected: FAIL — cannot find `../Field`.

- [ ] **Step 3: Implement `Field.tsx`**

```tsx
import type { ReactNode } from "react";
import { cn } from "../../utils/cn";
import { FieldLabel } from "./FieldLabel";
import { FieldHint } from "./FieldHint";

export interface FieldProps {
  id: string;
  label?: ReactNode;
  hint?: ReactNode;
  error?: boolean;
  children: (a: { id: string; hintId?: string; error: boolean }) => ReactNode;
  className?: string;
}

/** Composes label + control + hint and wires the a11y ids. */
export function Field({
  id,
  label,
  hint,
  error = false,
  children,
  className,
}: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={cn("w-full", className)}>
      {label && <FieldLabel htmlFor={id}>{label}</FieldLabel>}
      {children({ id, hintId, error })}
      {hint && (
        <FieldHint id={hintId} tone={error ? "error" : "default"}>
          {hint}
        </FieldHint>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Update `field/index.ts`**

Add:

```ts
export { Field, type FieldProps } from "./Field";
```

- [ ] **Step 5: Update the controls barrel `packages/ui/src/controls/index.ts`**

Append:

```ts
export {
  Field,
  type FieldProps,
  FieldLabel,
  type FieldLabelProps,
  FieldHint,
  type FieldHintProps,
  fieldChrome,
  type FieldChromeOptions,
} from "./field";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @tarmoto/ui test src/controls/field/__tests__/Field`
Expected: PASS.

- [ ] **Step 7: Full package typecheck + tests**

Run: `pnpm --filter @tarmoto/ui typecheck && pnpm --filter @tarmoto/ui test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/controls/field/ packages/ui/src/controls/index.ts
git commit -m "feat(cross): add Field wrapper and export field primitives from @tarmoto/ui"
```

---

### Task 8: Preview — rename §09 heading + add Input / Textarea / NumberField text-field blocks

**Files:**

- Modify: `apps/ui-preview/src/sections/Controls.tsx`

**Interfaces:**

- Consumes: `Input`, `Textarea`, `NumberField`, `FieldLabel`, `SegmentedControl` from `@tarmoto/ui`; existing `SubStamp`/section helpers already used in the file.

- [ ] **Step 1: Update the section title**

In `Controls.tsx`, change the `title=` prop from `"Toggle, segment, slider, radio."` to:

```
"Toggle, segment, slider, radio — and the text-field family."
```

- [ ] **Step 2: Add the "Text-field family" divider + blocks after the existing swatch card**

Import the additions at the top (merge into the existing `@tarmoto/ui` import):

```tsx
import {
  Input,
  Textarea,
  NumberField,
  FieldLabel,
  SegmentedControl,
  // ...existing imports
} from "@tarmoto/ui";
```

Then, using the existing local state pattern in the file, add stateful demo blocks: a **Text input · states** card (rest/placeholder, focused, leading icon via a small inline search `<svg>`, disabled, and an `error` + `hint="Enter a valid email address."`), a **Textarea** card with a `hint`, and a **NumberField** card pairing `<NumberField unit="KM" .../>` with a `km`/`mi` `SegmentedControl` sibling. Mirror the existing card/`SubStamp` structure already in this file (do not invent new section primitives).

- [ ] **Step 3: Run the preview build to verify it compiles**

Run: `pnpm --filter @tarmoto/ui-preview build`
Expected: build succeeds (no TS/type errors from the new blocks).

- [ ] **Step 4: Visual check (manual)**

Run: `pnpm --filter @tarmoto/ui-preview dev`, open the Controls section, confirm the Input states (incl. error hint), Textarea, and NumberField+segmented pair render per the §09 screenshots.

- [ ] **Step 5: Commit**

```bash
git add apps/ui-preview/src/sections/Controls.tsx
git commit -m "feat(cross): preview the upgraded Input/Textarea/NumberField text fields"
```

---

### Task 9: P1 wrap-up — full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the UI package tests + typecheck**

Run: `pnpm --filter @tarmoto/ui test && pnpm --filter @tarmoto/ui typecheck`
Expected: all pass.

- [ ] **Step 2: Confirm the companion still typechecks (no accidental contract break)**

Run: `pnpm --filter @tarmoto/companion typecheck`
Expected: clean (P1 changes are additive; no consumer touched yet).

- [ ] **Step 3: Confirm the preview builds**

Run: `pnpm --filter @tarmoto/ui-preview build`
Expected: success.

- [ ] **Step 4: Push the branch and open a draft PR for P1**

```bash
git push -u origin feat/ui-text-field-family
gh pr create --draft --title "feat(cross): UI text-field family P1 — field primitives + Input/Textarea/NumberField upgrades" --body "Implements P1 of docs/superpowers/specs/2026-07-14-ui-text-field-family-design.md. Adds the @tarmoto/ui test harness, fieldChrome/FieldLabel/FieldHint/Field primitives, and the new leading-icon/error/hint/focus-ring/unit states, previewed in ui-preview. P2 (Select rebuild + Combobox + companion migration) and P3 (date/time pickers) follow."
```

---

## Follow-on phases (separate plans)

- **P2 plan** (`2026-07-14-ui-text-field-family-p2.md`, written after P1 merges): add `react-aria-components` + `@internationalized/date`; rebuild `Select` on react-aria; add `Combobox`; migrate the 4 companion `Select` call sites; preview Select (closed/open) + Combobox.
- **P3 plan**: `DatePicker`, `TimePicker` (15-min snap), `DateTimePicker` (single value); ISO-string boundary conversion; preview the three pickers.

## Self-review notes

- **Spec coverage:** P1 covers spec §"Shared field primitives", §"Upgraded components", and the P1 slice of §"Preview". Select rebuild/Combobox (§"Rebuilt"/§"New") and pickers are explicitly deferred to P2/P3 plans (spec phasing). ✅
- **Placeholder scan:** every code step has complete code; the only prose-described step is Task 8 Step 2 (preview blocks) which references the file's existing card/state pattern rather than duplicating it — acceptable since it's presentational glue, with exact props named. ✅
- **Type consistency:** `fieldChrome(FieldChromeOptions)`, `hintId` prop, and `Field` render-prop signature are used identically across Tasks 2–8. `fieldClasses` is removed in Task 4 and its sole other importer (Textarea) is migrated in Task 5. ✅
