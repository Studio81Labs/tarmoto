import { cn } from "../../utils/cn";

export interface ClearButtonProps {
  onClear: () => void;
  label?: string;
  className?: string;
}

/**
 * Small ✕ affordance overlaid on the right edge of a field trigger. Rendered as
 * a sibling of the trigger (not nested inside it — react-aria triggers are
 * `<button>`s and can't contain another button), positioned absolutely, so a
 * click clears without also activating the trigger. The trigger reserves
 * `hasTrailing` padding so its text doesn't run under this control.
 */
export function ClearButton({
  onClear,
  label = "Clear",
  className,
}: ClearButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClear}
      className={cn(
        "absolute right-3 top-1/2 z-10 grid size-4 -translate-y-1/2 place-items-center",
        "rounded text-fg-mute transition-colors hover:text-ink",
        className,
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-3"
      >
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    </button>
  );
}
