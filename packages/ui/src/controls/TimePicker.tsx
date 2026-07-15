"use client";

import { useId, type ReactNode } from "react";
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

/** TimePicker · 24 h two-column scroll (§09). Value is an ISO time string "HH:MM". */
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
  const labelId = useId();
  const current = parse(value);
  const hour = current?.hour ?? 0;
  const minute = current?.minute ?? 0;

  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = Array.from(
    { length: Math.floor(60 / minuteStep) },
    (_, i) => i * minuteStep,
  );

  const commit = (h: number, m: number) => onChange(`${pad(h)}:${pad(m)}`);

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
  }

  return (
    <div className={cn("w-full", className)}>
      {label !== undefined && (
        <span id={labelId} className={FIELD_LABEL}>
          {label}
        </span>
      )}
      <DialogTrigger>
        <Button
          {...(id !== undefined ? { id } : {})}
          {...(label !== undefined
            ? { "aria-labelledby": labelId }
            : ariaLabel !== undefined
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
