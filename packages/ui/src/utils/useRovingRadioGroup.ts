import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

/**
 * Implements the WAI-ARIA radio-group keyboard pattern for components
 * that render a custom group of `role="radio"` items: roving
 * `tabIndex`, arrow/Home/End navigation with wrapping, and DOM focus
 * restoration on keyboard-driven selection (per the radio pattern,
 * arrow navigation is selection).
 *
 * Shared by SegmentedControl, NumberGrid, and SwatchPicker — anywhere
 * a small group of mutually-exclusive options exposes radio semantics.
 *
 * Controlled prop changes do *not* steal focus; only key-driven
 * `selectAt` calls do.
 */
export interface UseRovingRadioGroupOptions<T> {
  value: T;
  options: ReadonlyArray<T>;
  onChange: (next: T) => void;
  /** Compares an option to the current `value`. Defaults to ===. */
  isEqual?: (a: T, b: T) => boolean;
}

export interface UseRovingRadioGroupResult<E extends HTMLElement> {
  /** Index that should hold `tabIndex={0}` — the selected option, or 0 as fallback. */
  activeTabIndex: number;
  /** ref callback factory for each option button. */
  registerRef: (index: number) => (el: E | null) => void;
  /** Attach to each option's `onKeyDown`. */
  handleKeyDown: (e: ReactKeyboardEvent<E>, index: number) => void;
}

export function useRovingRadioGroup<
  T,
  E extends HTMLElement = HTMLButtonElement,
>({
  value,
  options,
  onChange,
  isEqual,
}: UseRovingRadioGroupOptions<T>): UseRovingRadioGroupResult<E> {
  const refs = useRef<Array<E | null>>([]);
  // Only move DOM focus when the user navigated via keyboard, not on
  // initial render or when the selection changes via controlled props.
  const moveFocusOnNextChange = useRef(false);

  const eq = isEqual ?? ((a: T, b: T) => Object.is(a, b));
  const selectedIndex = options.findIndex((o) => eq(o, value));
  // Fall back to the first option if the controlled value doesn't match
  // — keeps a sensible tab target instead of trapping focus.
  const activeTabIndex = selectedIndex >= 0 ? selectedIndex : 0;

  useEffect(() => {
    if (moveFocusOnNextChange.current) {
      refs.current[activeTabIndex]?.focus();
      moveFocusOnNextChange.current = false;
    }
  }, [activeTabIndex]);

  const selectAt = useCallback(
    (nextIndex: number) => {
      if (options.length === 0) return;
      const wrapped = (nextIndex + options.length) % options.length;
      moveFocusOnNextChange.current = true;
      onChange(options[wrapped]);
    },
    [onChange, options],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<E>, index: number) => {
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
    },
    [options.length, selectAt],
  );

  const registerRef = useCallback(
    (index: number) => (el: E | null) => {
      refs.current[index] = el;
    },
    [],
  );

  return { activeTabIndex, registerRef, handleKeyDown };
}
