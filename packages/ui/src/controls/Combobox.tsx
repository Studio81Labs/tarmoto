"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ComboBox as AriaComboBox,
  Input,
  Button,
  Label,
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
  label?: ReactNode;
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

/**
 * Highlights the matched substring with an accent wash. On the selected row
 * (ink fill + cream text) the light accent-on-ink wash is invisible and the
 * forced ink text is dark-on-dark, so switch to a cream wash that keeps the
 * cream text readable.
 */
function highlight(text: string, query: string, selected: boolean): ReactNode {
  if (!query) return text;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <span
        className={cn(
          "rounded-[3px]",
          selected ? "bg-cream/25 text-cream" : "bg-accent/[0.14] text-ink",
        )}
      >
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
  label,
  id,
  disabled = false,
  tone = "paper",
  error = false,
  ariaLabel,
  placeholder,
  className,
}: ComboboxProps) {
  const selected = options.find((o) => o.value === value);
  const selectedLabel = labelText(selected?.label ?? "", "");
  const [query, setQuery] = useState(selectedLabel);

  // Resync the input to the selected option's label whenever that label
  // changes — the selection moving, options arriving after mount (the selected
  // key becomes resolvable), or a locale-driven label refresh. Keyed on the
  // label STRING, not the options array identity, so a caller passing an inline
  // options array (new identity each render) doesn't reset the query while the
  // user is typing (typing changes `query`, not `selectedLabel`).
  useEffect(() => {
    setQuery(selectedLabel);
  }, [selectedLabel]);

  // The input shows the selected option's label at rest. Treat that as "not a
  // search" so opening the menu with a value still shows every option (browse
  // like a select); only text the user actually edits in becomes a filter.
  const activeFilter = query === selectedLabel ? "" : query.trim();

  const matches = useMemo(() => {
    const q = activeFilter.toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      labelText(o.label, o.value).toLowerCase().includes(q),
    );
  }, [options, activeFilter]);

  return (
    <AriaComboBox
      {...(id !== undefined ? { id } : {})}
      {...(ariaLabel !== undefined && label === undefined
        ? { "aria-label": ariaLabel }
        : {})}
      isInvalid={error}
      isDisabled={disabled}
      // Preserve `""` as a real key when it matches an option (the "Any"/"All"
      // sentinel used by filters); only a value with no matching option is a
      // truly-empty selection (`null`). `value || null` would drop the `""`
      // selection so react-aria never marks/announces that option.
      selectedKey={selected ? value : null}
      inputValue={query}
      onInputChange={setQuery}
      onSelectionChange={(key) => {
        if (key != null) onChange(String(key));
      }}
      items={matches}
      className={cn("relative w-full", className)}
      allowsEmptyCollection
      // Open the list on focus/click, not only when the user starts typing —
      // a click should browse like a select.
      menuTrigger="focus"
    >
      {label !== undefined && (
        <Label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.6px] text-fg-dim">
          {label}
        </Label>
      )}
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
          "w-[var(--trigger-width)] rounded-[10px] border border-line-strong bg-paper p-1",
          "shadow-[0_8px_24px_rgba(14,14,16,0.08)]",
        )}
      >
        <div className="px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-fg-mute">
          {matches.length} {matches.length === 1 ? "match" : "matches"}
        </div>
        <ListBox<SelectOption> className="max-h-64 overflow-auto outline-none">
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
                    {highlight(
                      labelText(opt.label, opt.value),
                      activeFilter,
                      isSelected,
                    )}
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
