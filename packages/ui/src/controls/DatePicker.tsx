"use client";

import { useId, useState, type ReactNode } from "react";
import {
  DialogTrigger,
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
  const labelId = useId();
  const valueId = useId();
  const errorId = useId();
  const [open, setOpen] = useState(false);

  return (
    <div className={cn("w-full", className)}>
      {label !== undefined && (
        <span id={labelId} className={FIELD_LABEL}>
          {label}
        </span>
      )}
      {error && (
        <span id={errorId} className="sr-only">
          Invalid date
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
          <span
            id={valueId}
            className={cn(
              "font-mono text-sm",
              value ? "text-ink" : "text-fg-mute",
            )}
          >
            {value ? value : "Select date"}
          </span>
        </Button>
        <Popover className={MENU}>
          <Dialog className="outline-none" aria-label={ariaLabel ?? "Date"}>
            <Calendar
              value={parseIsoDate(value)}
              onChange={(d) => {
                onChange(isoDate(d));
                // Single date: committing a day dismisses the popover (react-aria's
                // own DatePicker did this; the generic DialogTrigger does not).
                setOpen(false);
              }}
            >
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
      </DialogTrigger>
    </div>
  );
}
