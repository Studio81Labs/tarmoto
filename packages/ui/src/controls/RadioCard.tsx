import { cn } from "../utils/cn";

/**
 * Radio · stacked-card variant. Spec: §09.
 * Use when each option benefits from a one-line help text.
 * Selected = ink border + cream fill.
 */
export interface RadioCardOption<T extends string> {
  value: T;
  label: string;
  help?: string;
}

export interface RadioCardGroupProps<T extends string> {
  name: string;
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<RadioCardOption<T>>;
  className?: string;
}

export function RadioCardGroup<T extends string>({
  name,
  value,
  onChange,
  options,
  className,
}: RadioCardGroupProps<T>) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)} role="radiogroup">
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <label
            key={opt.value}
            className={cn(
              "block cursor-pointer rounded-lg border px-3 py-2.5",
              "font-sans text-ink",
              "transition-colors duration-100",
              // The native input is sr-only, so the only way a keyboard
              // user knows which card has focus is the focus ring on
              // the wrapping label. `focus-within` picks it up from the
              // hidden input; `focus-visible` keeps it suppressed for
              // pointer interactions.
              "focus-within:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-cream",
              selected
                ? "border-ink bg-cream"
                : "border-line bg-transparent hover:bg-paper",
            )}
          >
            <div className="flex items-center gap-2.5">
              <input
                type="radio"
                name={name}
                value={opt.value}
                checked={selected}
                onChange={() => onChange(opt.value)}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className={cn(
                  "grid size-[14px] place-items-center rounded-full border-[1.5px]",
                  selected ? "border-ink" : "border-fg-mute",
                )}
              >
                {selected && <span className="size-1.5 rounded-full bg-ink" />}
              </span>
              <span className="text-[13px] font-semibold">{opt.label}</span>
            </div>
            {opt.help && (
              <div className="ml-6 mt-1 text-[11px] text-fg-mute">
                {opt.help}
              </div>
            )}
          </label>
        );
      })}
    </div>
  );
}
