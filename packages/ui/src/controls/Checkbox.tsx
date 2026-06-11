import type { ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * Checkbox · square multi-select control. Spec: §09.
 *
 * 18px rounded box: checked = accent fill + accent border + ink tick,
 * unchecked = muted border on transparent. The real `<input>` is `sr-only`
 * (peer) so keyboard / AT users still operate it; the focus ring rides the
 * visible box via `peer-focus-visible`. Mirrors the Toggle/RadioCard pattern.
 */
export interface CheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /**
   * Visible label beside the box. Omit for a standalone box — pass
   * `ariaLabel` so the control stays announced.
   */
  label?: ReactNode;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled = false,
  ariaLabel,
  className,
}: CheckboxProps) {
  return (
    <label
      className={cn(
        "inline-flex items-center gap-2.5 font-sans text-[13px] font-semibold text-ink",
        disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer",
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={cn(
          "flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border-2 transition-colors",
          checked
            ? "border-accent bg-accent text-ink"
            : "border-ink/40 bg-transparent text-transparent",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-cream",
        )}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={3.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
      {label != null && <span>{label}</span>}
    </label>
  );
}
