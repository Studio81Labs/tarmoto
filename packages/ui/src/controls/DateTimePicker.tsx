"use client";

import { useId, useState, type ReactNode } from "react";
import {
  DialogTrigger,
  Button,
  Popover,
  Dialog,
  Calendar,
  CalendarGrid,
  CalendarGridHeader,
  CalendarHeaderCell,
  CalendarGridBody,
  CalendarCell,
  Heading,
} from "react-aria-components";
import {
  CalendarDate,
  CalendarDateTime,
  today,
  getLocalTimeZone,
} from "@internationalized/date";
import { cn } from "../utils/cn";
import { fieldChrome } from "./field/fieldChrome";
import { parseIsoDateTime, isoDateTime } from "./date/isoDate";
import {
  displayIsoDateTime,
  type DisplayFormatProps,
} from "./date/displayFormat";

export interface DateTimePickerProps extends DisplayFormatProps {
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
  "rounded-[10px] border border-line-strong bg-paper p-3.5 shadow-[0_8px_24px_rgba(14,14,16,0.08)]";
const CELL = cn(
  "flex size-8 items-center justify-center rounded-md font-mono text-[12px] text-ink outline-none",
  "data-[outside-month]:text-fg-faint",
  "data-[hovered]:bg-paper-2 data-[focus-visible]:bg-paper-2",
  "data-[today]:ring-1 data-[today]:ring-accent",
  "data-[selected]:bg-ink data-[selected]:text-cream data-[selected]:ring-0",
);

const pad = (n: number) => String(n).padStart(2, "0");

/** DateTimePicker · calendar + inline HH:MM steppers (§09). Value is "YYYY-MM-DDTHH:MM" or "". */
export function DateTimePicker({
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
  locale,
  formatOptions,
  formatValue,
}: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const display = displayIsoDateTime(value, {
    locale,
    formatOptions,
    formatValue,
  });
  // Guard the public prop: 0/negative/non-integer would break the 60/step math.
  // Fall back to the documented default.
  const minuteStep =
    Number.isInteger(minuteStepProp) && minuteStepProp >= 1
      ? minuteStepProp
      : 15;
  const labelId = useId();
  const valueId = useId();
  const errorId = useId();
  const dt = parseIsoDateTime(value);

  const calendarValue = dt ? new CalendarDate(dt.year, dt.month, dt.day) : null;

  const hour = dt?.hour ?? 0;
  const minute = dt?.minute ?? 0;

  function handleDateChange(newDate: CalendarDate) {
    const merged = new CalendarDateTime(
      newDate.year,
      newDate.month,
      newDate.day,
      hour,
      snapMinute(minute),
    );
    onChange(isoDateTime(merged));
  }

  function baseDateTime(): CalendarDateTime {
    if (dt) return dt;
    const t = today(getLocalTimeZone());
    return new CalendarDateTime(t.year, t.month, t.day, 0, 0);
  }

  const minuteCount = Math.ceil(60 / minuteStep);
  const snapMinute = (m: number) =>
    Math.min(Math.round(m / minuteStep), minuteCount - 1) * minuteStep;

  function handleHourChange(delta: number) {
    const base = baseDateTime();
    const newHour = (((hour + delta) % 24) + 24) % 24;
    onChange(
      isoDateTime(
        new CalendarDateTime(
          base.year,
          base.month,
          base.day,
          newHour,
          snapMinute(minute),
        ),
      ),
    );
  }

  function handleMinuteChange(delta: number) {
    const base = baseDateTime();
    // Step to the adjacent AVAILABLE option relative to the current minute, so
    // an off-step value (e.g. 08:20 with step 15) moves to the nearest option in
    // the requested direction (down → 08:15, up → 08:30) rather than flooring
    // to a wrong step. Wraps at the ends.
    const options: number[] = [];
    for (let m = 0; m < 60; m += minuteStep) options.push(m);
    const newMinute =
      delta > 0
        ? (options.find((o) => o > minute) ?? options[0]!)
        : ([...options].reverse().find((o) => o < minute) ??
          options[options.length - 1]!);
    onChange(
      isoDateTime(
        new CalendarDateTime(base.year, base.month, base.day, hour, newMinute),
      ),
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
          Invalid date-time
        </span>
      )}
      <DialogTrigger isOpen={open} onOpenChange={setOpen}>
        <Button
          {...(id !== undefined ? { id } : {})}
          {...(label !== undefined
            ? { "aria-labelledby": `${labelId} ${valueId}` }
            : ariaLabel !== undefined
              ? { "aria-label": value ? `${ariaLabel}, ${display}` : ariaLabel }
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
            {display || "Select date & time"}
          </span>
        </Button>
        <Popover placement="bottom left" className={MENU}>
          <Dialog
            className="flex flex-col gap-3 outline-none"
            aria-label={ariaLabel ?? "Date and time"}
          >
            <Calendar
              firstDayOfWeek="mon"
              value={calendarValue}
              onChange={handleDateChange}
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
                <CalendarGridHeader>
                  {(day) => (
                    <CalendarHeaderCell className="pb-1 font-mono text-[10px] font-normal text-fg-mute">
                      {day}
                    </CalendarHeaderCell>
                  )}
                </CalendarGridHeader>
                <CalendarGridBody>
                  {(date) => <CalendarCell date={date} className={CELL} />}
                </CalendarGridBody>
              </CalendarGrid>
            </Calendar>
            {/* Divider */}
            <div className="border-t border-line" />
            {/* Inline HH : MM time steppers */}
            <div className="flex items-center justify-center gap-2">
              <div className="flex flex-col items-center">
                <button
                  type="button"
                  aria-label="Increase hour"
                  onClick={() => handleHourChange(1)}
                  className="grid size-6 place-items-center rounded text-fg-mute outline-none hover:bg-paper-2"
                >
                  ▲
                </button>
                <span className="w-8 text-center font-mono text-sm text-ink">
                  {pad(hour)}
                </span>
                <button
                  type="button"
                  aria-label="Decrease hour"
                  onClick={() => handleHourChange(-1)}
                  className="grid size-6 place-items-center rounded text-fg-mute outline-none hover:bg-paper-2"
                >
                  ▼
                </button>
              </div>
              <span className="font-mono text-sm text-ink">:</span>
              <div className="flex flex-col items-center">
                <button
                  type="button"
                  aria-label="Increase minute"
                  onClick={() => handleMinuteChange(1)}
                  className="grid size-6 place-items-center rounded text-fg-mute outline-none hover:bg-paper-2"
                >
                  ▲
                </button>
                <span className="w-8 text-center font-mono text-sm text-ink">
                  {pad(minute)}
                </span>
                <button
                  type="button"
                  aria-label="Decrease minute"
                  onClick={() => handleMinuteChange(-1)}
                  className="grid size-6 place-items-center rounded text-fg-mute outline-none hover:bg-paper-2"
                >
                  ▼
                </button>
              </div>
            </div>
          </Dialog>
        </Popover>
      </DialogTrigger>
    </div>
  );
}
