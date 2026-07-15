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
        <Button
          className={cn(
            "flex-1 text-left font-mono text-sm outline-none",
            value ? "text-ink" : "text-fg-mute",
          )}
        >
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
