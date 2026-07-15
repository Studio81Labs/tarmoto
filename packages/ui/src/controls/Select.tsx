"use client";

import type { ReactNode } from "react";
import {
  Select as AriaSelect,
  Button,
  Label,
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
  label?: ReactNode;
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
 *
 * Chevron open-state: `Button` in react-aria@1.19.0 does NOT expose
 * `data-open`, so we use the AriaSelect render-prop `{({ isOpen }) => ...}`
 * to toggle `rotate-180` on the chevron reliably.
 */
export function Select({
  value,
  onChange,
  options,
  label,
  id,
  disabled = false,
  tone = "paper",
  error = false,
  ariaLabel,
  className,
}: SelectProps) {
  return (
    <AriaSelect
      {...(id !== undefined ? { id } : {})}
      {...(ariaLabel !== undefined && label === undefined
        ? { "aria-label": ariaLabel }
        : {})}
      isInvalid={error}
      isDisabled={disabled}
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key))}
      className={cn("relative w-full", className)}
    >
      {({ isOpen }) => (
        <>
          {label !== undefined && (
            <Label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.6px] text-fg-dim">
              {label}
            </Label>
          )}
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
              className={cn(
                "pointer-events-none size-3 text-fg-mute transition-transform",
                isOpen && "rotate-180",
              )}
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
              "w-[var(--trigger-width)] rounded-[10px] border border-line-strong bg-paper p-1",
              "shadow-[0_8px_24px_rgba(14,14,16,0.08)]",
            )}
          >
            <ListBox className="outline-none">
              {options.map((opt) => (
                <ListBoxItem
                  key={opt.value}
                  id={opt.value}
                  textValue={
                    typeof opt.label === "string" ? opt.label : opt.value
                  }
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
        </>
      )}
    </AriaSelect>
  );
}
