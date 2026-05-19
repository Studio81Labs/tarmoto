import { cn } from "../utils/cn";

/**
 * Segmented control · 2–4 mutually-exclusive options. Spec: §09 / §16.
 * Track is paper-tinted; active item inverts to ink/cream.
 */
export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  ariaLabel?: string;
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex gap-1 rounded-[7px] bg-paper p-[3px]",
        className,
      )}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-pressed={selected}
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded-[5px] px-3 py-1.5",
              "font-sans text-[11px] font-bold tracking-[0.4px] capitalize",
              "transition-colors duration-100 cursor-pointer border-0",
              selected
                ? "bg-ink text-cream"
                : "bg-transparent text-fg-dim hover:text-ink",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
