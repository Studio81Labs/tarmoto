import { cn } from "../utils/cn";

/**
 * NumberField · numeric field with ▲/▼ steppers. Spec: §09.
 *
 * Wraps a native number `<input>` (which keeps real step semantics for
 * keyboard / AT users) in the unified field chrome, plus a visible stepper
 * column. The steppers are decorative duplicates of that native behaviour —
 * `aria-hidden` + `tabIndex={-1}` so AT users and the tab order see one
 * control, not three.
 *
 * Edits and steps are clamped to `[min, max]` and rounded; a non-numeric
 * entry leaves the value untouched. `tone` matches the field surface to its
 * container — see `Input` for the rationale. Pass an external
 * `<label htmlFor>` + matching `id`, or `ariaLabel`.
 */
export interface NumberFieldProps {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  step?: number;
  tone?: "paper" | "cream";
  id?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  tone = "paper",
  id,
  disabled = false,
  ariaLabel,
  className,
}: NumberFieldProps) {
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));

  function commit(raw: string) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    onChange(clamp(parsed));
  }

  return (
    <div
      className={cn(
        "flex items-stretch overflow-hidden rounded-lg border border-line-strong transition focus-within:border-accent",
        tone === "cream" ? "bg-cream" : "bg-paper",
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => commit(event.target.value)}
        className="min-w-0 flex-1 bg-transparent px-3 py-2 font-sans text-sm text-ink outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <div className="flex flex-col border-l border-line">
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          disabled={disabled}
          onClick={() => onChange(clamp(value + step))}
          className="flex flex-1 items-center px-2.5 text-[8px] text-fg-mute transition hover:bg-ink/5 hover:text-ink"
        >
          ▲
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          disabled={disabled}
          onClick={() => onChange(clamp(value - step))}
          className="flex flex-1 items-center border-t border-line px-2.5 text-[8px] text-fg-mute transition hover:bg-ink/5 hover:text-ink"
        >
          ▼
        </button>
      </div>
    </div>
  );
}
