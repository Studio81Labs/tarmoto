import { cn } from "../utils/cn";

/**
 * SwatchPicker · curated colour picker. Spec: §09 / §16.
 * Curated values only — never a free hex picker. Selected = 2 px ink ring.
 */
export interface SwatchPickerProps {
  value: string;
  options: ReadonlyArray<string>;
  onChange: (next: string) => void;
  ariaLabel?: string;
  className?: string;
  size?: number;
}

export function SwatchPicker({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  size = 28,
}: SwatchPickerProps) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("flex gap-1.5", className)}
    >
      {options.map((color) => {
        const selected = color.toLowerCase() === value.toLowerCase();
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={color}
            onClick={() => onChange(color)}
            className={cn(
              "rounded-full border-2 transition-all duration-100 cursor-pointer",
              selected ? "border-ink" : "border-transparent",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1",
            )}
            style={{ width: size, height: size, background: color }}
          />
        );
      })}
    </div>
  );
}
