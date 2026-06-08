import { cn } from "../utils/cn";
import { useRovingRadioGroup } from "../utils/useRovingRadioGroup";

/**
 * Segmented control · 2–4 mutually-exclusive options. Spec: §09 / §16.
 * Track is paper-tinted; active item inverts to ink/cream.
 *
 * Keyboard contract is the WAI-ARIA radio-group pattern (arrow keys,
 * Home/End, roving tabindex, wrapping). See `useRovingRadioGroup`.
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
  /**
   * Fully disables the control: every option gets the native `disabled`
   * attribute (so it leaves the tab order and ignores pointer *and* keyboard
   * activation), the group is `aria-disabled`, and `onChange` is gated. Use
   * while a selection-driven request is in flight.
   */
  disabled?: boolean;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
  disabled = false,
}: SegmentedControlProps<T>) {
  const { activeTabIndex, registerRef, handleKeyDown } = useRovingRadioGroup<
    SegmentedOption<T>,
    HTMLButtonElement
  >({
    value: options.find((o) => o.value === value) ?? options[0],
    options,
    onChange: (opt) => onChange(opt.value),
    isEqual: (a, b) => a.value === b.value,
  });

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cn(
        "inline-flex gap-1 rounded-[7px] bg-paper p-[3px]",
        disabled && "opacity-50",
        className,
      )}
    >
      {options.map((opt, index) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={registerRef(index)}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            // Roving tabindex: only the active item participates in the
            // tab order; arrow keys handle intra-group movement.
            tabIndex={index === activeTabIndex ? 0 : -1}
            onClick={() => !disabled && onChange(opt.value)}
            onKeyDown={(e) => !disabled && handleKeyDown(e, index)}
            className={cn(
              "rounded-[5px] px-3 py-1.5",
              "font-sans text-[11px] font-bold tracking-[0.4px] capitalize",
              "transition-colors duration-100 cursor-pointer border-0",
              "disabled:cursor-not-allowed",
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
