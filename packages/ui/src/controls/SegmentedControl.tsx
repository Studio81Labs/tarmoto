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
  /**
   * Vertical size. `"sm"` (default) is the compact toolbar height; `"field"`
   * matches the shared form-control height (fieldChrome ≈ 38px) so the control
   * lines up with Inputs/Selects when placed as a labelled form field.
   */
  size?: "sm" | "field";
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
  disabled = false,
  size = "sm",
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
        // `field` lines the control up with the shared 38px form-control
        // height; the buttons stretch to fill (flex align-items: stretch).
        size === "field" && "h-[38px]",
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
              // Compact horizontal padding through the tablet range so a
              // 4-option group (e.g. the ride-history time window) isn't
              // cramped; roomier px at lg+ where there's space.
              "flex items-center justify-center rounded-[5px] px-2 py-1.5 lg:px-3",
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
