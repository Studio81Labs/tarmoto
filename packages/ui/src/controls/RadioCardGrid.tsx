import { cn } from "../utils/cn";
import { useRovingRadioGroup } from "../utils/useRovingRadioGroup";

/**
 * Radio · filled-card variant. Spec: §09.
 *
 * Distinct from {@link RadioCardGroup} (a vertical list with a radio dot +
 * cream-fill active): this is a set of *filled* selectable cards whose active
 * state inverts to ink/cream — used where a few options each carry a one-line
 * description and read better as a compact row/grid of tiles (e.g. settings
 * "Email digest", "Profile visibility").
 *
 * Layout is caller-owned: pass the wrapping grid/flex classes via `className`
 * (e.g. `"grid grid-cols-1 gap-2 sm:grid-cols-3"`). Keyboard follows the
 * WAI-ARIA radio-group pattern (arrow keys, Home/End, roving tabindex).
 */
export interface RadioCardGridOption<T extends string> {
  value: T;
  label: string;
  description?: string;
}

export interface RadioCardGridProps<T extends string> {
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<RadioCardGridOption<T>>;
  ariaLabel?: string;
  /** Layout classes for the radiogroup wrapper, e.g. `"grid grid-cols-3 gap-2"`. */
  className?: string;
}

export function RadioCardGrid<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: RadioCardGridProps<T>) {
  const { activeTabIndex, registerRef, handleKeyDown } = useRovingRadioGroup<
    RadioCardGridOption<T>,
    HTMLButtonElement
  >({
    value: options.find((o) => o.value === value) ?? options[0],
    options,
    onChange: (opt) => onChange(opt.value),
    isEqual: (a, b) => a.value === b.value,
  });

  return (
    <div role="radiogroup" aria-label={ariaLabel} className={className}>
      {options.map((opt, index) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={registerRef(index)}
            type="button"
            role="radio"
            aria-checked={selected}
            // Roving tabindex: only the active item is in the tab order; arrow
            // keys move within the group.
            tabIndex={index === activeTabIndex ? 0 : -1}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={cn(
              "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left",
              "transition-colors duration-100",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream",
              selected
                ? "border-ink bg-ink text-cream"
                : "border-line bg-paper text-ink hover:border-line-strong",
            )}
          >
            <span className="text-[14px] font-semibold">{opt.label}</span>
            {opt.description && (
              <span
                className={cn(
                  "text-[12px]",
                  selected ? "text-fg-on-dark-dim" : "text-fg-dim",
                )}
              >
                {opt.description}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
