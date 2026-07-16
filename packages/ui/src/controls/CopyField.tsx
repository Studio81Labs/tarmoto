"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "../utils/cn";
import { fieldChrome } from "./field/fieldChrome";

export interface CopyFieldProps {
  value: string;
  /** Accessible name for the read-only field (e.g. "Shareable invite URL"). */
  ariaLabel: string;
  /** Accessible name for the copy button. */
  copyLabel?: string;
  tone?: "paper" | "cream";
  id?: string;
  className?: string;
  /** Notified after a successful clipboard write (toasts, analytics). */
  onCopied?: (() => void) | undefined;
}

/**
 * CopyField · read-only value with a built-in copy affordance (§09 field
 * chrome). For share links, invite URLs, tokens — anywhere the rider takes
 * a value out rather than typing one in. Focusing the field selects the
 * whole value; the trailing button writes it to the clipboard and flashes
 * a check. When the Clipboard API is unavailable the button falls back to
 * selecting the text so a manual ⌘C still works.
 */
export function CopyField({
  value,
  ariaLabel,
  copyLabel = "Copy",
  tone = "paper",
  id,
  className,
  onCopied,
}: CopyFieldProps) {
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      onCopied?.();
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API blocked (permissions, insecure context): select the
      // value so the rider can copy manually.
      inputRef.current?.select();
    }
  };

  return (
    <div className={cn("relative w-full", className)}>
      <input
        ref={inputRef}
        id={id}
        readOnly
        value={value}
        aria-label={ariaLabel}
        onFocus={(event) => event.currentTarget.select()}
        className={cn(
          fieldChrome({ tone, hasTrailing: true }),
          "font-mono text-xs text-fg-dim",
        )}
      />
      <button
        type="button"
        aria-label={copyLabel}
        onClick={() => void copy()}
        className="absolute right-3 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-fg-mute transition-colors hover:text-ink"
      >
        {copied ? (
          /* check — flashes for 2 s after a successful copy */
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-4 text-quality-q5"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          /* copy */
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-4"
          >
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </svg>
        )}
      </button>
      {/* Announce the transient success state to AT — the visual is icon-only. */}
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </div>
  );
}
