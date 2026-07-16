"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../utils/cn";
import { fieldChrome } from "./field/fieldChrome";
import { ClearButton } from "./field/ClearButton";

export interface SearchComboboxItem {
  value: string;
  label: string;
}

export interface SearchComboboxProps {
  /** The live input text — the caller debounces/fetches off this. */
  query: string;
  onQueryChange: (next: string) => void;
  /** Results for the current query; the caller owns fetching + filtering. */
  items: SearchComboboxItem[];
  onSelect: (value: string) => void;
  /** Flip while the caller's lookup is in flight → "Searching…" row. */
  loading?: boolean;
  /** Menu only renders once the trimmed query reaches this length. */
  minChars?: number;
  placeholder?: string;
  loadingMessage?: string;
  emptyMessage?: string;
  leadingIcon?: ReactNode;
  /**
   * Inline adornment docked at the field's right edge, before the clear
   * button — e.g. a radius chip on a place filter. Reserves extra input
   * padding so text can't run underneath it.
   */
  trailing?: ReactNode;
  /** Renders the clear ✕ (when the query is non-empty) wired to this. */
  onClear?: () => void;
  /**
   * Overrides the clear button's default `query !== ""` visibility rule.
   * A filter field whose selection outlives the typed text (e.g. a place
   * filter after the rider erases the label) passes `true` here so the
   * active filter stays clearable.
   */
  clearVisible?: boolean;
  ariaLabel?: string;
  id?: string;
  tone?: "paper" | "cream";
  disabled?: boolean;
  className?: string;
}

/**
 * SearchCombobox · async lookup field (§09). Unlike `Combobox` (which
 * filters a static option list internally), the caller owns the data:
 * feed `items` from a fetch keyed on `query`, flip `loading` while it's
 * in flight. The control owns the shell — field chrome, leading icon,
 * trailing adornment + clear, and the results popover with
 * searching/empty states and listbox keyboard navigation
 * (↑/↓/Enter/Escape via aria-activedescendant).
 */
export function SearchCombobox({
  query,
  onQueryChange,
  items,
  onSelect,
  loading = false,
  minChars = 2,
  placeholder,
  loadingMessage = "Searching…",
  emptyMessage = "No matches",
  leadingIcon,
  trailing,
  onClear,
  clearVisible,
  ariaLabel,
  id,
  tone = "paper",
  disabled = false,
  className,
}: SearchComboboxProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  // A fresh result set invalidates the highlighted row.
  useEffect(() => {
    setActiveIndex(-1);
  }, [items]);

  // Close on outside click.
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const menuVisible = open && !disabled && query.trim().length >= minChars;

  const pick = (value: string) => {
    onSelect(value);
    setOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    // While loading, the popover shows only the "Searching…" row but the
    // caller may still be holding the previous query's `items` — keyboard
    // navigation must not walk (or Enter-select) options that aren't
    // currently displayed.
    if (!menuVisible || loading || items.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % items.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index <= 0 ? items.length - 1 : index - 1));
    } else if (event.key === "Enter") {
      const active = items[activeIndex];
      if (active) {
        event.preventDefault();
        pick(active.value);
      }
    }
  };

  const showClear = !!onClear && !disabled && (clearVisible ?? query !== "");

  return (
    <div ref={containerRef} className={cn("relative w-full", className)}>
      {leadingIcon && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-fg-mute"
        >
          {leadingIcon}
        </span>
      )}
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={menuVisible}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={
          menuVisible && activeIndex >= 0
            ? `${listboxId}-opt-${activeIndex}`
            : undefined
        }
        aria-label={ariaLabel}
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => {
          onQueryChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        className={cn(
          fieldChrome({
            tone,
            disabled,
            hasLeading: !!leadingIcon,
            hasTrailing: true,
          }),
          // The default trailing padding (pr-9) fits one small control;
          // an adornment + clear pair needs the wider gutter.
          trailing && "pr-[92px]",
        )}
      />
      <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
        {trailing}
        {showClear && (
          <ClearButton
            className="static right-auto top-auto translate-y-0"
            onClear={onClear}
          />
        )}
      </div>
      {menuVisible && (
        <div
          id={listboxId}
          role="listbox"
          className={cn(
            "absolute z-10 mt-1 w-full rounded-[10px] border border-line-strong bg-paper p-1",
            "shadow-[0_8px_24px_rgba(14,14,16,0.08)]",
          )}
        >
          {loading && (
            <div className="px-2.5 py-1.5 text-xs text-fg-dim">
              {loadingMessage}
            </div>
          )}
          {!loading && items.length === 0 && (
            <div className="px-2.5 py-1.5 text-xs text-fg-mute">
              {emptyMessage}
            </div>
          )}
          {!loading &&
            items.map((item, index) => (
              <button
                key={item.value}
                id={`${listboxId}-opt-${index}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                // preventDefault keeps focus in the input so the outside-
                // click closer and aria-activedescendant stay coherent.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(item.value)}
                onMouseEnter={() => setActiveIndex(index)}
                title={item.label}
                className={cn(
                  "block w-full truncate rounded-md px-2.5 py-1.5 text-left text-sm text-ink transition",
                  index === activeIndex && "bg-paper-2",
                )}
              >
                {item.label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
