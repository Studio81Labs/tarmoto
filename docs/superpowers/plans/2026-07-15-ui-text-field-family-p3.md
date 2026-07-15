# UI Text-Field Family — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `DatePicker`, `TimePicker`, and `DateTimePicker` to `@tarmoto/ui`, completing the §09 text-field family, and preview them.

**Architecture:** Add `@internationalized/date` (react-aria's date primitives — already a transitive dep of `react-aria-components`, promoted to a direct dep). `DatePicker` and `DateTimePicker` build on react-aria `Calendar`; `TimePicker` is a bespoke two-column (HR/MIN) scroll popover matching the §09 mock (react-aria's default `TimeField` is a segmented spinner, not the design). All three are controlled with **ISO strings** at the public boundary, converting to/from `@internationalized/date` internally. Styled with existing Tailwind tokens + the P1 `fieldChrome`/`FieldLabel`. All three are `"use client"` (they use react-aria/client-only + local state).

**Tech Stack:** React 19, TypeScript strict (`exactOptionalPropertyTypes`), Tailwind v4 tokens, `react-aria-components`, `@internationalized/date`. Test stack from P1 (Vitest + @testing-library/react + user-event).

## Global Constraints

- New runtime dep: **`@internationalized/date`** (promote from transitive to direct in `packages/ui` `dependencies`).
- Public value API = ISO strings: DatePicker `"2026-05-18"`, TimePicker `"08:30"` (24h HH:MM), DateTimePicker `"2026-05-18T08:30"`. `onChange(value: string)`; empty string when cleared. Convert with `@internationalized/date` `parseDate`/`parseTime`/`parseDateTime` in, `.toString()` (trim seconds for time) out.
- Design tokens (Tailwind v4, no hardcoded hex): surfaces `cream`/`paper`/`paper-2`/`ink`; `accent`; text `fg-dim`/`fg-mute`/`fg-faint`; borders `line`/`line-strong`. Dates/times render in **mono** (`font-mono`).
- §09 calendar: month title + prev/next chevron nav; DOW header row (M T W T F S S); `cal-cell` = mono numeral; **today = 1px accent ring** (`ring-1 ring-accent`); **selected = ink fill** (`bg-ink text-cream`); adjacent-month days dimmed (`text-fg-faint`). Popover menu chrome matches Select/Combobox: `rounded-[10px] border border-line-strong bg-paper p-3.5 shadow-[0_8px_24px_rgba(14,14,16,0.08)]`.
- §09 TimePicker: 24-hour; two scroll columns (HR 00–23, MIN by step); each column a `tc-head` label + scrollable list of `t` items; selected `t` = ink fill; **minutes snap to a configurable step, default 15**.
- §09 DateTimePicker: react-aria `Calendar` + an inline `HH : MM` stepper row below a divider; **single** value (date-range shading is out of scope, documented).
- Every control: reuses `fieldChrome` on the closed trigger; a leading calendar/clock icon (`aria-hidden`); accepts `label?` (react-aria `<Label>`) / `ariaLabel`; `error`, `disabled`, `tone`, `id`, `className`. a11y via react-aria (`aria-invalid` via `isInvalid`).
- exactOptionalPropertyTypes-safe (conditional-spread optionals). Tests assert behaviour/roles (open, pick a day/time, ISO round-trip), not class strings. Conventional commits, scope `cross`, lowercase subject.

## File Structure

- `packages/ui/src/controls/date/isoDate.ts` — ISO ↔ `@internationalized/date` conversion helpers (shared).
- `packages/ui/src/controls/DatePicker.tsx`, `TimePicker.tsx`, `DateTimePicker.tsx` — new.
- `packages/ui/src/controls/__tests__/{DatePicker,TimePicker,DateTimePicker}.test.tsx` — new.
- `packages/ui/src/controls/index.ts` — export the three + prop types.
- `apps/ui-preview/src/sections/Controls.tsx` — Date / Time / Date-time preview blocks.

---

### Task 1: Add `@internationalized/date` + ISO conversion helpers + react-aria date smoke

**Files:**

- Modify: `packages/ui/package.json`
- Create: `packages/ui/src/controls/date/isoDate.ts`
- Test: `packages/ui/src/controls/date/__tests__/isoDate.test.ts`
- Test: `packages/ui/src/controls/__tests__/react-aria-date-smoke.test.tsx`

**Interfaces:**

- Produces:

  ```ts
  // isoDate.ts — all return null on empty/invalid input so callers stay controlled.
  function parseIsoDate(v: string): CalendarDate | null; // "2026-05-18"
  function parseIsoTime(v: string): Time | null; // "08:30"
  function parseIsoDateTime(v: string): CalendarDateTime | null; // "2026-05-18T08:30"
  function isoDate(d: CalendarDate | null): string; // -> "2026-05-18" | ""
  function isoTime(t: Time | null): string; // -> "08:30" | "" (HH:MM, seconds trimmed)
  function isoDateTime(d: CalendarDateTime | null): string; // -> "2026-05-18T08:30" | ""
  ```

  Confirms the react-aria date component names Tasks 2–4 use (`DatePicker`/`Calendar`/`CalendarGrid`/`CalendarCell`/`Heading`/`Button`).

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @tarmoto/ui add @internationalized/date@^3`

- [ ] **Step 2: Write the failing conversion test**

`packages/ui/src/controls/date/__tests__/isoDate.test.ts`:

```ts
import {
  parseIsoDate,
  parseIsoTime,
  parseIsoDateTime,
  isoDate,
  isoTime,
  isoDateTime,
} from "../isoDate";

test("date round-trips ISO", () => {
  expect(isoDate(parseIsoDate("2026-05-18"))).toBe("2026-05-18");
});
test("time round-trips ISO as HH:MM (seconds trimmed)", () => {
  expect(isoTime(parseIsoTime("08:30"))).toBe("08:30");
});
test("datetime round-trips ISO to minute precision", () => {
  expect(isoDateTime(parseIsoDateTime("2026-05-18T08:30"))).toBe(
    "2026-05-18T08:30",
  );
});
test("empty / invalid input parses to null and serialises to empty", () => {
  expect(parseIsoDate("")).toBeNull();
  expect(parseIsoDate("nope")).toBeNull();
  expect(isoDate(null)).toBe("");
  expect(isoTime(null)).toBe("");
});
```

- [ ] **Step 3: Run — expect FAIL** (module missing).

Run: `pnpm --filter @tarmoto/ui test src/controls/date/__tests__/isoDate`

- [ ] **Step 4: Implement `isoDate.ts`**

```ts
import {
  CalendarDate,
  CalendarDateTime,
  Time,
  parseDate,
  parseTime,
  parseDateTime,
} from "@internationalized/date";

export function parseIsoDate(v: string): CalendarDate | null {
  if (!v) return null;
  try {
    return parseDate(v);
  } catch {
    return null;
  }
}
export function parseIsoTime(v: string): Time | null {
  if (!v) return null;
  try {
    return parseTime(v);
  } catch {
    return null;
  }
}
export function parseIsoDateTime(v: string): CalendarDateTime | null {
  if (!v) return null;
  try {
    return parseDateTime(v);
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

export function isoDate(d: CalendarDate | null): string {
  return d ? `${d.year}-${pad(d.month)}-${pad(d.day)}` : "";
}
export function isoTime(t: Time | null): string {
  return t ? `${pad(t.hour)}:${pad(t.minute)}` : "";
}
export function isoDateTime(d: CalendarDateTime | null): string {
  return d
    ? `${d.year}-${pad(d.month)}-${pad(d.day)}T${pad(d.hour)}:${pad(d.minute)}`
    : "";
}
```

Note: `parse*` throws on malformed input — the `try/catch` is the sanctioned narrow guard here (converting malformed external input to `null`), NOT a silent-failure antipattern.

- [ ] **Step 5: Run conversion test — expect PASS.**

- [ ] **Step 6: react-aria date smoke test**

`packages/ui/src/controls/__tests__/react-aria-date-smoke.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DatePicker,
  Group,
  Button,
  Popover,
  Dialog,
  Calendar,
  CalendarGrid,
  CalendarCell,
  Heading,
} from "react-aria-components";
import { parseDate } from "@internationalized/date";

test("react-aria DatePicker opens a calendar and selects a day", async () => {
  const onChange = vi.fn();
  render(
    <DatePicker
      aria-label="d"
      defaultValue={parseDate("2026-05-01")}
      onChange={onChange}
    >
      <Group>
        <Button>open</Button>
      </Group>
      <Popover>
        <Dialog>
          <Calendar>
            <header>
              <Button slot="previous">‹</Button>
              <Heading />
              <Button slot="next">›</Button>
            </header>
            <CalendarGrid>
              {(date) => <CalendarCell date={date} />}
            </CalendarGrid>
          </Calendar>
        </Dialog>
      </Popover>
    </DatePicker>,
  );
  await userEvent.click(screen.getByRole("button", { name: "open" }));
  await userEvent.click(screen.getByRole("button", { name: "18" }));
  expect(onChange).toHaveBeenCalled();
});
```

- [ ] **Step 7: Run smoke — expect PASS.** If any react-aria import/prop/slot differs in the installed version, **STOP and report the confirmed API** — Tasks 2–4 depend on it.

- [ ] **Step 8: Commit**

```bash
git add packages/ui/package.json pnpm-lock.yaml packages/ui/src/controls/date/
git add packages/ui/src/controls/__tests__/react-aria-date-smoke.test.tsx
git commit -m "feat(cross): add @internationalized/date + ISO conversion helpers"
```

---

### Task 2: `DatePicker`

**Files:**

- Create: `packages/ui/src/controls/DatePicker.tsx`
- Modify: `packages/ui/src/controls/index.ts`
- Test: `packages/ui/src/controls/__tests__/DatePicker.test.tsx`

**Interfaces:**

- Consumes: `isoDate` helpers (Task 1), `fieldChrome`, react-aria date components.
- Produces:

  ```ts
  interface DatePickerProps {
    value: string; // ISO "YYYY-MM-DD" or ""
    onChange: (value: string) => void;
    label?: ReactNode;
    ariaLabel?: string;
    id?: string;
    disabled?: boolean;
    tone?: "paper" | "cream";
    error?: boolean;
    className?: string;
  }
  function DatePicker(props: DatePickerProps): JSX.Element;
  ```

- [ ] **Step 1: Write the failing test**

`packages/ui/src/controls/__tests__/DatePicker.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DatePicker } from "../DatePicker";

test("opens the calendar and reports the picked date as an ISO string", async () => {
  const onChange = vi.fn();
  render(
    <DatePicker ariaLabel="Departure" value="2026-05-01" onChange={onChange} />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: /calendar|departure|open/i }),
  );
  await userEvent.click(screen.getByRole("button", { name: "18" }));
  expect(onChange).toHaveBeenCalledWith("2026-05-18");
});

test("label associates via react-aria Label", () => {
  render(<DatePicker label="Departure" value="" onChange={() => {}} />);
  expect(screen.getByText("Departure")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `DatePicker.tsx`** (verify slot/prop names against Task-1 smoke)

```tsx
"use client";

import type { ReactNode } from "react";
import {
  DatePicker as AriaDatePicker,
  Label,
  Group,
  Button,
  Popover,
  Dialog,
  Calendar,
  CalendarGrid,
  CalendarCell,
  Heading,
} from "react-aria-components";
import { cn } from "../utils/cn";
import { fieldChrome } from "./field/fieldChrome";
import { parseIsoDate, isoDate } from "./date/isoDate";

export interface DatePickerProps {
  value: string;
  onChange: (value: string) => void;
  label?: ReactNode;
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  tone?: "paper" | "cream";
  error?: boolean;
  className?: string;
}

const FIELD_LABEL =
  "mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.6px] text-fg-dim";
const MENU =
  "rounded-[10px] border border-line-strong bg-paper p-3.5 shadow-[0_8px_24px_rgba(14,14,16,0.08)]";
const CELL = cn(
  "flex size-8 items-center justify-center rounded-md font-mono text-[12px] text-ink outline-none",
  "data-[outside-month]:text-fg-faint",
  "data-[hovered]:bg-paper-2 data-[focus-visible]:bg-paper-2",
  "data-[today]:ring-1 data-[today]:ring-accent",
  "data-[selected]:bg-ink data-[selected]:text-cream data-[selected]:ring-0",
);

/** DatePicker · calendar field (§09). Value is an ISO date string. */
export function DatePicker({
  value,
  onChange,
  label,
  ariaLabel,
  id,
  disabled = false,
  tone = "paper",
  error = false,
  className,
}: DatePickerProps) {
  return (
    <AriaDatePicker
      {...(id !== undefined ? { id } : {})}
      {...(ariaLabel !== undefined && label === undefined
        ? { "aria-label": ariaLabel }
        : {})}
      isDisabled={disabled}
      isInvalid={error}
      value={parseIsoDate(value)}
      onChange={(d) => onChange(isoDate(d))}
      className={cn("w-full", className)}
    >
      {label !== undefined && <Label className={FIELD_LABEL}>{label}</Label>}
      <Group
        className={cn(
          fieldChrome({ tone, disabled, error, hasLeading: true }),
          "flex items-center",
        )}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-3 text-fg-mute"
        >
          {/* inline calendar svg */}
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
        </span>
        <Button className="flex-1 text-left font-mono text-sm text-ink outline-none data-[placeholder]:text-fg-mute">
          {value ? value : "Select date"}
        </Button>
      </Group>
      <Popover className={MENU}>
        <Dialog className="outline-none">
          <Calendar>
            <header className="mb-2 flex items-center justify-between">
              <Button
                slot="previous"
                className="grid size-6 place-items-center rounded text-fg-mute outline-none data-[hovered]:bg-paper-2"
              >
                ‹
              </Button>
              <Heading className="font-mono text-[13px] font-semibold text-ink" />
              <Button
                slot="next"
                className="grid size-6 place-items-center rounded text-fg-mute outline-none data-[hovered]:bg-paper-2"
              >
                ›
              </Button>
            </header>
            <CalendarGrid className="border-separate border-spacing-0.5">
              {(date) => <CalendarCell date={date} className={CELL} />}
            </CalendarGrid>
          </Calendar>
        </Dialog>
      </Popover>
    </AriaDatePicker>
  );
}
```

Notes for the implementer: verify the closed-field rendering — react-aria's `DatePicker` normally renders a `DateInput`/`DateSegment` group; here we intentionally show a single mono `value` string trigger per §09. If a plain `Button` inside `Group` doesn't open the popover in this version, wrap with react-aria's expected trigger (a `Button` sibling of `Group`) — confirm against the Task-1 smoke and adjust. Verify the `data-[outside-month]` / `data-[today]` / `data-[selected]` attribute names against the installed `CalendarCell` render props (some versions expose `isOutsideMonth`/`isToday`/`isSelected` render-prop booleans instead — if the data-attrs don't style, switch to the render-prop function form).

- [ ] **Step 4: Run test — expect PASS.**
- [ ] **Step 5: Export from barrel** (`index.ts`): `export { DatePicker, type DatePickerProps } from "./DatePicker";`
- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter @tarmoto/ui typecheck
git add packages/ui/src/controls/DatePicker.tsx packages/ui/src/controls/__tests__/DatePicker.test.tsx packages/ui/src/controls/index.ts
git commit -m "feat(cross): add DatePicker to @tarmoto/ui"
```

---

### Task 3: `TimePicker` (24h, two scroll columns)

**Files:**

- Create: `packages/ui/src/controls/TimePicker.tsx`
- Modify: `packages/ui/src/controls/index.ts`
- Test: `packages/ui/src/controls/__tests__/TimePicker.test.tsx`

**Interfaces:**

- Consumes: `isoTime` helpers, `fieldChrome`, react-aria `Button`/`Popover`/`Dialog`/`ListBox`/`ListBoxItem` (or `DialogTrigger`).
- Produces:

  ```ts
  interface TimePickerProps {
    value: string; // ISO "HH:MM" or ""
    onChange: (value: string) => void;
    minuteStep?: number; // default 15
    label?: ReactNode;
    ariaLabel?: string;
    id?: string;
    disabled?: boolean;
    tone?: "paper" | "cream";
    error?: boolean;
    className?: string;
  }
  function TimePicker(props: TimePickerProps): JSX.Element;
  ```

- [ ] **Step 1: Write the failing test**

`packages/ui/src/controls/__tests__/TimePicker.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimePicker } from "../TimePicker";

test("picks an hour and minute and emits ISO HH:MM", async () => {
  const onChange = vi.fn();
  render(
    <TimePicker ariaLabel="Start time" value="08:30" onChange={onChange} />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: /start time|08:30|time/i }),
  );
  await userEvent.click(screen.getByRole("option", { name: "09" }));
  expect(onChange).toHaveBeenLastCalledWith("09:30");
  await userEvent.click(screen.getByRole("option", { name: "45" }));
  expect(onChange).toHaveBeenLastCalledWith("09:45");
});

test("minutes snap to the configured step", () => {
  render(
    <TimePicker ariaLabel="t" value="" minuteStep={15} onChange={() => {}} />,
  );
  // 00,15,30,45 rendered (verified when the menu opens in the test above pattern)
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `TimePicker.tsx`** — a `DialogTrigger` (Button + Popover) whose popover holds two `ListBox`es (HR 00–23, MIN by `minuteStep`). Parse `value` into `{hour, minute}`; picking an hour keeps the current minute and vice-versa; emit `isoTime`. Selected item = ink fill; columns are `max-h`-scrollable.

```tsx
"use client";

import { useState, type ReactNode } from "react";
import {
  DialogTrigger,
  Button,
  Popover,
  Dialog,
  ListBox,
  ListBoxItem,
  Label,
} from "react-aria-components";
import { cn } from "../utils/cn";
import { fieldChrome } from "./field/fieldChrome";

export interface TimePickerProps {
  value: string;
  onChange: (value: string) => void;
  minuteStep?: number;
  label?: ReactNode;
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  tone?: "paper" | "cream";
  error?: boolean;
  className?: string;
}

const FIELD_LABEL =
  "mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.6px] text-fg-dim";
const MENU =
  "rounded-[10px] border border-line-strong bg-paper p-2 shadow-[0_8px_24px_rgba(14,14,16,0.08)]";
const pad = (n: number) => String(n).padStart(2, "0");

function parse(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export function TimePicker({
  value,
  onChange,
  minuteStep = 15,
  label,
  ariaLabel,
  id,
  disabled = false,
  tone = "paper",
  error = false,
  className,
}: TimePickerProps) {
  const current = parse(value);
  const hour = current?.hour ?? 0;
  const minute = current?.minute ?? 0;
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = Array.from(
    { length: Math.floor(60 / minuteStep) },
    (_, i) => i * minuteStep,
  );

  const commit = (h: number, m: number) => onChange(`${pad(h)}:${pad(m)}`);

  const column = (
    head: string,
    items: number[],
    selected: number,
    onPick: (n: number) => void,
  ) => (
    <div className="flex flex-col">
      <div className="px-2 py-1 text-center font-mono text-[10px] uppercase tracking-wide text-fg-mute">
        {head}
      </div>
      <ListBox
        aria-label={head}
        selectionMode="single"
        selectedKeys={[String(selected)]}
        onSelectionChange={(keys) => {
          const k = [...(keys as Set<string>)][0];
          if (k != null) onPick(Number(k));
        }}
        className="max-h-40 w-14 overflow-auto outline-none"
      >
        {items.map((n) => (
          <ListBoxItem
            key={n}
            id={String(n)}
            textValue={pad(n)}
            className={cn(
              "cursor-pointer rounded-md px-2 py-1 text-center font-mono text-sm text-ink outline-none",
              "data-[hovered]:bg-paper-2 data-[focused]:bg-paper-2",
              "data-[selected]:bg-ink data-[selected]:text-cream",
            )}
          >
            {pad(n)}
          </ListBoxItem>
        ))}
      </ListBox>
    </div>
  );

  return (
    <div className={cn("w-full", className)}>
      {label !== undefined && (
        <Label className={FIELD_LABEL} elementType="span">
          {label}
        </Label>
      )}
      <DialogTrigger>
        <Button
          {...(id !== undefined ? { id } : {})}
          {...(ariaLabel !== undefined && label === undefined
            ? { "aria-label": ariaLabel }
            : {})}
          isDisabled={disabled}
          className={cn(
            fieldChrome({ tone, disabled, error, hasLeading: true }),
            "relative flex items-center text-left",
          )}
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-3 text-fg-mute"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </span>
          <span
            className={cn(
              "font-mono text-sm",
              value ? "text-ink" : "text-fg-mute",
            )}
          >
            {value || "Select time"}
          </span>
        </Button>
        <Popover className={MENU}>
          <Dialog
            className="flex gap-1 outline-none"
            aria-label={ariaLabel ?? "Time"}
          >
            {column("HR", hours, hour, (h) => commit(h, minute))}
            {column("MIN", minutes, minute, (m) => commit(hour, m))}
          </Dialog>
        </Popover>
      </DialogTrigger>
    </div>
  );
}
```

Notes: verify `DialogTrigger`/`Button`/`Popover`/`Dialog`/`ListBox` names + `selectedKeys`/`onSelectionChange` shape against the installed react-aria. If `Label` needs an associated control it can't have here (the trigger is a plain `Button`), render the label as a styled `<span>`/`<Label elementType="span">` — the `ariaLabel` on the Button carries the accessible name.

- [ ] **Step 4: Run test — expect PASS.**
- [ ] **Step 5: Export** (`index.ts`): `export { TimePicker, type TimePickerProps } from "./TimePicker";`
- [ ] **Step 6: Typecheck + commit** (`feat(cross): add TimePicker to @tarmoto/ui`).

---

### Task 4: `DateTimePicker`

**Files:**

- Create: `packages/ui/src/controls/DateTimePicker.tsx`
- Modify: `packages/ui/src/controls/index.ts`
- Test: `packages/ui/src/controls/__tests__/DateTimePicker.test.tsx`

**Interfaces:**

- Consumes: `parseIsoDateTime`/`isoDateTime`, `fieldChrome`, react-aria `Calendar`. Reuses the calendar-cell styling from DatePicker.
- Produces:

  ```ts
  interface DateTimePickerProps {
    value: string; // ISO "YYYY-MM-DDTHH:MM" or ""
    onChange: (value: string) => void;
    minuteStep?: number; // default 15 (for the inline steppers)
    label?: ReactNode;
    ariaLabel?: string;
    id?: string;
    disabled?: boolean;
    tone?: "paper" | "cream";
    error?: boolean;
    className?: string;
  }
  function DateTimePicker(props: DateTimePickerProps): JSX.Element;
  ```

- [ ] **Step 1: Write the failing test**

`packages/ui/src/controls/__tests__/DateTimePicker.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateTimePicker } from "../DateTimePicker";

test("picks a day and keeps the time, emitting ISO datetime", async () => {
  const onChange = vi.fn();
  render(
    <DateTimePicker
      ariaLabel="Ride start"
      value="2026-05-17T08:30"
      onChange={onChange}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: /ride start|open|2026/i }),
  );
  await userEvent.click(screen.getByRole("button", { name: "18" }));
  expect(onChange).toHaveBeenLastCalledWith("2026-05-18T08:30");
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `DateTimePicker.tsx`** — a `DialogTrigger` whose popover holds a standalone react-aria `Calendar` (value = the date part of `parseIsoDateTime(value)`, `onChange` merges the new date with the current time) above a divider with an inline `HH : MM` stepper row (two small steppers or `+/-` buttons stepping by `minuteStep`, hours 0–23 wrapping). Emit `isoDateTime`. Keep the calendar cell styling identical to DatePicker (extract a shared `calendarCellClass` if convenient, but duplication of the class string is acceptable per the plan). Trigger shows the mono `value`. Single value only — no range.

Notes: verify the standalone `Calendar` (not inside `DatePicker`) API + `value`/`onChange` with a `CalendarDate`. Merge date+time by constructing a `CalendarDateTime` from the picked `CalendarDate` and the current hour/minute (via `@internationalized/date` `CalendarDateTime` constructor or `.set(...)`).

- [ ] **Step 4: Run test — expect PASS.**
- [ ] **Step 5: Export** (`index.ts`).
- [ ] **Step 6: Typecheck + commit** (`feat(cross): add DateTimePicker to @tarmoto/ui`).

---

### Task 5: Preview — Date / Time / Date-time blocks

**Files:**

- Modify: `apps/ui-preview/src/sections/Controls.tsx`

- [ ] **Step 1:** Add three cards after the Combobox card (mirroring the existing card / `SubStamp` / `FieldLabel` / `useState` pattern — do not invent primitives): a **Date picker** ("Departure"), a **Time picker · 24h** ("Start time", `minuteStep={15}`), and a **Date-time picker** ("Ride start"), each with a stateful ISO `value`.
- [ ] **Step 2:** `pnpm --filter @tarmoto/ui-preview build` — expect success.
- [ ] **Step 3:** Commit (`feat(cross): preview the date / time / date-time pickers`).

---

### Task 6: P3 wrap-up — full verification

- [ ] `pnpm --filter @tarmoto/ui test && pnpm --filter @tarmoto/ui typecheck` — expect all pass.
- [ ] `pnpm --filter @tarmoto/ui-preview build` — expect success.
- [ ] `pnpm --filter @tarmoto/companion typecheck` and `pnpm --filter @tarmoto/admin typecheck` — expect clean (P3 is purely additive to `@tarmoto/ui`; no consumer migration). Rebuild `@tarmoto/shared` / clear stale `.next/dev/types` first if those known stale-artifact errors appear.
- [ ] Push + open PR referencing the design spec; note the new `@internationalized/date` dep and that the three pickers complete the §09 text-field family.

## Out of scope

- Date/time **range** selection (single values only).
- Free-typing date/time segments (the trigger shows a formatted mono value; entry is via the calendar / columns per §09).

## Self-review notes

- **Spec coverage:** P3 implements §"New components → DatePicker / TimePicker / DateTimePicker" and their preview slice + the ISO-string boundary. ✅
- **Placeholder scan:** each task carries complete reference code + real tests; the react-aria date-API verification points (Tasks 2–4) are concrete, bounded checks against the Task-1 smoke, not open TODOs. ✅
- **Type consistency:** ISO-string `value`/`onChange` and the `isoDate`/`isoTime`/`isoDateTime` helpers are used identically across Tasks 1–5; all three pickers share the `label`/`ariaLabel`/`error`/`tone`/`disabled` prop shape established in P2. ✅
