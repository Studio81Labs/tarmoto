import { useMemo, useState, type ReactNode } from "react";
import {
  ComboBox as AriaComboBox,
  Input,
  Button,
  Popover,
  ListBox,
  ListBoxItem,
} from "react-aria-components";
import { cn } from "../utils/cn";
import { fieldChrome } from "./field/fieldChrome";
import type { SelectOption } from "./Select";

export interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  id?: string;
  disabled?: boolean;
  tone?: "paper" | "cream";
  error?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
}

function labelText(label: ReactNode, fallback: string): string {
  return typeof label === "string" ? label : fallback;
}

/** Highlights the matched substring with an accent wash. */
function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <span className="rounded-[3px] bg-accent/[0.14] text-ink">
        {text.slice(i, i + query.length)}
      </span>
      {text.slice(i + query.length)}
    </>
  );
}

/**
 * Combobox · searchable select (§09). Use for >8 options. Type filters the
 * list; the matched substring gets an accent-wash highlight; an "N matches"
 * header sits above the options; the selected option carries an accent check.
 */
export function Combobox({
  value,
  onChange,
  options,
  id,
  disabled = false,
  tone = "paper",
  error = false,
  ariaLabel,
  placeholder,
  className,
}: ComboboxProps) {
  const selected = options.find((o) => o.value === value);
  const [query, setQuery] = useState(labelText(selected?.label ?? "", ""));

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      labelText(o.label, o.value).toLowerCase().includes(q),
    );
  }, [options, query]);

  return (
    <AriaComboBox
      {...(id !== undefined ? { id } : {})}
      {...(ariaLabel !== undefined ? { "aria-label": ariaLabel } : {})}
      isInvalid={error}
      isDisabled={disabled}
      selectedKey={value || null}
      inputValue={query}
      onInputChange={setQuery}
      onSelectionChange={(key) => {
        if (key != null) onChange(String(key));
      }}
      items={matches}
      className={cn("relative w-full", className)}
      allowsEmptyCollection
    >
      <div className="relative">
        <Input
          {...(placeholder !== undefined ? { placeholder } : {})}
          className={fieldChrome({ tone, disabled, error, hasTrailing: true })}
        />
        <Button
          aria-hidden="true"
          excludeFromTabOrder
          className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-mute"
        >
          <svg className="size-3" viewBox="0 0 12 8" fill="none">
            <path
              d="M1 1l5 5 5-5"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          </svg>
        </Button>
      </div>
      <Popover
        className={cn(
          "w-[--trigger-width] rounded-[10px] border border-line-strong bg-paper p-1",
          "shadow-[0_8px_24px_rgba(14,14,16,0.08)]",
        )}
      >
        <div className="px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-fg-mute">
          {matches.length} {matches.length === 1 ? "match" : "matches"}
        </div>
        <ListBox<SelectOption> className="outline-none">
          {(opt) => (
            <ListBoxItem
              id={opt.value}
              textValue={labelText(opt.label, opt.value)}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm text-ink outline-none",
                "data-[hovered]:bg-paper-2 data-[focused]:bg-paper-2",
                "data-[selected]:bg-ink data-[selected]:text-cream",
              )}
            >
              {({ isSelected }) => (
                <>
                  <span className="truncate">
                    {highlight(labelText(opt.label, opt.value), query)}
                  </span>
                  {isSelected && (
                    <svg
                      aria-hidden="true"
                      className="size-3.5 text-accent"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.4}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaComboBox>
  );
}
