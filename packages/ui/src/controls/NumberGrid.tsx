import { cn } from "../utils/cn";

/**
 * NumberGrid · equal-flex chip row for finite numeric choices
 * (days, gears). Selected = ink fill, cream label. Spec: §09.
 *
 * Don't use this for time or units — those go in a Slider or input.
 */
export interface NumberGridProps {
  value: number;
  onChange: (next: number) => void;
  options: ReadonlyArray<number>;
  ariaLabel?: string;
  className?: string;
}

export function NumberGrid({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: NumberGridProps) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("flex gap-1", className)}
    >
      {options.map((n) => {
        const selected = n === value;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(n)}
            className={cn(
              "flex-1 rounded-md border py-2 text-center",
              "font-mono text-xs font-bold tabular-nums",
              "transition-colors duration-100 cursor-pointer",
              selected
                ? "bg-ink text-cream border-ink"
                : "bg-cream text-fg-dim border-line hover:border-line-strong",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            )}
          >
            {n}
          </button>
        );
      })}
    </div>
  );
}
