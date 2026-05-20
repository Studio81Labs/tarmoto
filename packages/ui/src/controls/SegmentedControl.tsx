import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { cn } from "../utils/cn";

/**
 * Segmented control · 2–4 mutually-exclusive options. Spec: §09 / §16.
 * Track is paper-tinted; active item inverts to ink/cream.
 *
 * Implements the WAI-ARIA radio-group keyboard pattern:
 *  - Only the selected option sits in the tab order (`tabIndex=0`)
 *  - Arrow Left / Up moves selection to the previous option
 *  - Arrow Right / Down moves selection to the next option
 *  - Home / End jump to the first / last
 *  - Selection wraps at both ends
 *
 * Arrow keys select + focus per the radio pattern (matches how native
 * `<input type="radio">` siblings behave inside a `radiogroup`).
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
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Track whether the next selection change should also move DOM focus.
  // We only want to steal focus when the user navigated via keyboard,
  // not on the initial render or when the selection changes via
  // controlled prop updates.
  const moveFocusOnNextChange = useRef(false);

  const selectedIndex = options.findIndex((o) => o.value === value);
  // Fall back to the first option if the controlled value doesn't match
  // any option — keeps a sensible tab target instead of trapping focus.
  const tabIndex = selectedIndex >= 0 ? selectedIndex : 0;

  useEffect(() => {
    if (moveFocusOnNextChange.current) {
      buttonRefs.current[tabIndex]?.focus();
      moveFocusOnNextChange.current = false;
    }
  }, [tabIndex]);

  const selectAt = useCallback(
    (nextIndex: number) => {
      const wrapped = (nextIndex + options.length) % options.length;
      moveFocusOnNextChange.current = true;
      onChange(options[wrapped].value);
    },
    [onChange, options],
  );

  const handleKeyDown = (
    e: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        selectAt(index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        selectAt(index - 1);
        break;
      case "Home":
        e.preventDefault();
        selectAt(0);
        break;
      case "End":
        e.preventDefault();
        selectAt(options.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex gap-1 rounded-[7px] bg-paper p-[3px]",
        className,
      )}
    >
      {options.map((opt, index) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              buttonRefs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            // Roving tabindex: only the active item participates in the
            // tab order; arrow keys handle intra-group movement.
            tabIndex={index === tabIndex ? 0 : -1}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => handleKeyDown(e, index)}
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
