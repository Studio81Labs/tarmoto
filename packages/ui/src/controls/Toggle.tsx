import { cn } from "../utils/cn";

/**
 * Toggle · binary switch. Spec: §09.
 * Track 34 × 20 · thumb 16 · ease left 0.15s.
 * Active = ink track + accent thumb.
 */
export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function Toggle({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  className,
}: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-[34px] shrink-0 rounded-full border-0 p-0",
        "transition-colors duration-150",
        checked ? "bg-ink" : "bg-ink/12",
        disabled && "opacity-40 cursor-not-allowed",
        !disabled && "cursor-pointer",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-0.5 size-4 rounded-full transition-all duration-150",
          checked ? "left-4 bg-accent" : "left-0.5 bg-cream",
        )}
      />
    </button>
  );
}
