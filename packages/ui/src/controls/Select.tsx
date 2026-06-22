import type { ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * Select · single-choice dropdown field. Spec: §09.
 *
 * A styled wrapper around a native `<select>`: `appearance-none` strips the
 * platform arrow so every field reads the same (unified border, radius,
 * focus ring) with a custom chevron drawn on the right. The native element
 * is preserved so keyboard / AT users and `getByLabelText` keep working —
 * pass an external `<label htmlFor>` and the matching `id`, or `ariaLabel`.
 *
 * `tone` matches the field surface to its container: `paper` (default) for a
 * field on the cream page, `cream` for a field inside a paper card — `cn` is
 * plain clsx, so a `className` background can't override the default, hence a
 * prop. Pass `<option>`s as children to keep full control of the option list.
 */
export interface SelectProps {
  value: string | number;
  /** Receives the raw `<option>` value — convert (e.g. `Number(v)`) at the call site. */
  onChange: (value: string) => void;
  children: ReactNode;
  id?: string;
  disabled?: boolean;
  tone?: "paper" | "cream";
  ariaLabel?: string;
  className?: string;
}

export function Select({
  value,
  onChange,
  children,
  id,
  disabled = false,
  tone = "paper",
  ariaLabel,
  className,
}: SelectProps) {
  return (
    <div className={cn("relative", className)}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "w-full appearance-none rounded-lg border border-line-strong py-2 pl-3 pr-9 font-sans text-sm text-ink transition",
          tone === "cream" ? "bg-cream" : "bg-paper",
          "focus:border-accent focus:outline-none",
          disabled
            ? "cursor-not-allowed opacity-60"
            : "cursor-pointer hover:border-ink/40",
        )}
      >
        {children}
      </select>
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-fg-mute"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </div>
  );
}
