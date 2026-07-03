"use client";
import { t } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { MapPin, Search } from "lucide-react";
import { plannerApi } from "@/lib/planner/api";
import type { GeoResult } from "@/lib/planner/types";

/**
 * Typed geocoded search for the BUILD route spine (addendum §2): forward-
 * geocodes the query (debounced) and offers a dropdown of matches; picking
 * one hands the coordinates + display name to the caller.
 */
interface GeocodeSearchFieldProps {
  placeholder: string;
  ariaLabel: string;
  onSelect: (result: GeoResult) => void;
  /** Clear the input after a pick (add-via mode) instead of showing it. */
  clearOnSelect?: boolean;
}

const DEBOUNCE_MS = 200;

export function GeocodeSearchField({
  placeholder,
  ariaLabel,
  onSelect,
  clearOnSelect = false,
}: GeocodeSearchFieldProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeoResult[]>([]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      plannerApi
        .geocode(query)
        .then((matches) => {
          if (cancelled) return;
          setResults(matches);
          setOpen(matches.length > 0);
        })
        .catch(() => {
          if (!cancelled) setOpen(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query]);

  // Close the dropdown on outside clicks.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div ref={containerRef} className="relative min-w-0 flex-1">
      <div className="flex items-center gap-1.5">
        <Search size={11} className="shrink-0 text-fg-mute" />
        <input
          type="text"
          value={query}
          aria-label={ariaLabel}
          placeholder={placeholder}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => setOpen(results.length > 0)}
          className="w-full min-w-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-fg-mute"
        />
      </div>
      {open ? (
        <ul
          role="listbox"
          aria-label={`${ariaLabel} results`}
          className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-[10px] border border-line-strong bg-cream shadow-[0_8px_24px_rgba(14,14,16,0.16)]"
        >
          {results.map((result) => (
            <li key={`${result.name}:${result.lat}`} role="none">
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => {
                  onSelect(result);
                  setOpen(false);
                  setResults([]);
                  setQuery(clearOnSelect ? "" : result.name);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-ink transition hover:bg-paper"
              >
                <MapPin size={11} className="shrink-0 text-fg-mute" />
                {result.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <span className="sr-only">{t("Search places to route through ")}</span>
    </div>
  );
}
