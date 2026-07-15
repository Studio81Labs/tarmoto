"use client";

import { useId, useState, type ReactNode } from "react";
import {
  DialogTrigger,
  Button,
  Popover,
  Dialog,
  ListBox,
  ListBoxItem,
} from "react-aria-components";
import { cn } from "../utils/cn";
import { fieldChrome } from "./field/fieldChrome";
import { parseIsoTime } from "./date/isoDate";

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

/** TimePicker · 24 h two-column scroll (§09). Value is an ISO time string "HH:MM". */
export function TimePicker({
  value,
  onChange,
  minuteStep: minuteStepProp = 15,
  label,
  ariaLabel,
  id,
  disabled = false,
  tone = "paper",
  error = false,
  className,
}: TimePickerProps) {
  // Guard the public prop: 0/negative/non-integer would hang the option loop
  // (m += 0) or break the 60/step math. Fall back to the documented default.
  const minuteStep =
    Number.isInteger(minuteStepProp) && minuteStepProp >= 1
      ? minuteStepProp
      : 15;
  const labelId = useId();
  const valueId = useId();
  const errorId = useId();
  // Route through @internationalized/date so out-of-range values (e.g. 25:30)
  // are rejected (→ null → defaults), consistent with the other pickers,
  // rather than carrying an invalid hour/minute into an emitted value.
  const [open, setOpen] = useState(false);
  const current = parseIsoTime(value);
  const hour = current?.hour ?? 0;
  const minute = current?.minute ?? 0;

  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes: number[] = [];
  for (let m = 0; m < 60; m += minuteStep) minutes.push(m);

  const commit = (h: number, m: number) => onChange(`${pad(h)}:${pad(m)}`);

  const minuteCount = Math.ceil(60 / minuteStep);
  const snapMinute = (m: number) =>
    Math.min(Math.round(m / minuteStep), minuteCount - 1) * minuteStep;

  function column(
    head: string,
    items: number[],
    selected: number,
    onPick: (n: number) => void,
  ) {
    return (
      <div className="flex flex-col">
        <div className="px-2 py-1 text-center font-mono text-[10px] uppercase tracking-wide text-fg-mute">
          {head}
        </div>
        <ListBox
          aria-label={head}
          selectionMode="single"
          selectedKeys={[String(selected)]}
          onSelectionChange={(keys) => {
            if (keys === "all") return;
            const k = [...keys][0];
            // Clicking the already-highlighted option toggles single-selection
            // to an empty set. Treat that as re-picking the highlighted value
            // so an off-step value (highlighted at its nearest step) can still
            // be normalized by clicking it.
            onPick(k != null ? Number(k) : selected);
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
  }

  return (
    <div className={cn("w-full", className)}>
      {label !== undefined && (
        <span
          id={labelId}
          onClick={() => !disabled && setOpen(true)}
          className={cn(FIELD_LABEL, !disabled && "cursor-pointer")}
        >
          {label}
        </span>
      )}
      {error && (
        <span id={errorId} className="sr-only">
          Invalid time
        </span>
      )}
      <DialogTrigger isOpen={open} onOpenChange={setOpen}>
        <Button
          {...(id !== undefined ? { id } : {})}
          {...(label !== undefined
            ? { "aria-labelledby": `${labelId} ${valueId}` }
            : ariaLabel !== undefined
              ? { "aria-label": value ? `${ariaLabel}, ${value}` : ariaLabel }
              : {})}
          isDisabled={disabled}
          {...(error ? { "aria-describedby": errorId } : {})}
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
            id={valueId}
            className={cn(
              "font-mono text-sm",
              value ? "text-ink" : "text-fg-mute",
            )}
          >
            {value || "Select time"}
          </span>
        </Button>
        <Popover placement="bottom left" className={MENU}>
          <Dialog
            className="flex gap-1 outline-none"
            aria-label={ariaLabel ?? "Time"}
          >
            {column("HR", hours, hour, (h) => commit(h, snapMinute(minute)))}
            {/* An off-step incoming minute (e.g. 08:10 with minuteStep=15)
                matches no option id, so highlight the nearest available step
                rather than leaving the column with nothing selected. */}
            {column("MIN", minutes, snapMinute(minute), (m) => commit(hour, m))}
          </Dialog>
        </Popover>
      </DialogTrigger>
    </div>
  );
}
