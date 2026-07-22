"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { MapPin } from "lucide-react";
import { SearchCombobox, SegmentedControl } from "@tarmoto/ui";
import { api } from "@/lib/api";
import { useFormat } from "@/format/FormatProvider";

// Lazy: maplibre-gl only loads when the radius popover actually opens —
// keeps the filter bars light and keeps jsdom tests away from WebGL.
const RadiusPreviewMap = dynamic(
  () =>
    import("@/components/map/RadiusPreviewMap").then(
      (mod) => mod.RadiusPreviewMap,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="h-[150px] w-full animate-pulse rounded-[10px] border border-line bg-paper" />
    ),
  },
);
export interface PlaceValue {
  label: string;
  lat: number;
  lng: number;
  km: number;
}
interface Props {
  value: PlaceValue | null;
  onChange: (next: PlaceValue | null) => void;
  label?: string;
  placeholder?: string;
}
interface Match {
  label: string;
  lat: number;
  lng: number;
}
const RADIUS_CHOICES = [10, 25, 50, 100] as const;
const DEFAULT_RADIUS_KM = 25;
const GEOCODE_DEBOUNCE_MS = 350;
const GEOCODE_MIN_CHARS = 2;

// Composite key: lat/lng alone collides when Nominatim returns overlapping
// admin levels (a city and its county can share the centroid). Adding the
// label and index makes the key unique even for dual-tagged hits while
// staying stable across re-renders of the same result set.
const matchKey = (m: Match, i: number) => `${m.lat},${m.lng}|${m.label}|${i}`;

export function PlaceSearch({ value, onChange, label, placeholder }: Props) {
  const t = useTranslation();
  const format = useFormat();
  const resolvedLabel = label ?? t("Passes near place");
  const resolvedPlaceholder = placeholder ?? t("Tatra Mountains…");
  const [draft, setDraft] = useState(value?.label ?? "");
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(false);
  // The radius picker popover, anchored under the field. Replaces the old
  // always-visible segmented row that used to push the layout down the
  // moment a place was picked.
  const [radiusOpen, setRadiusOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    setDraft(value?.label ?? "");
  }, [value?.label]);
  // Close the radius popover on outside click (the search dropdown has its
  // own closer inside SearchCombobox).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node))
        setRadiusOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);
  // Debounced geocode.
  //
  // Depend on primitives (draft + current place label) rather than the
  // `value` object. RidesFilters builds `value` fresh on every render,
  // so taking an object-identity dep here would reset the debounce
  // timer on every unrelated parent re-render — e.g. when the rides
  // list/tracks fetches resolve — and delay (or starve) the geocode
  // fetch while the rider is still typing.
  const selectedLabel = value?.label;
  useEffect(() => {
    // If the input still matches the currently-selected place, suppress
    // the fetch: the dropdown would just re-offer the same match the
    // user already picked.
    if (selectedLabel != null && draft === selectedLabel) {
      setMatches([]);
      // Reset loading too — an earlier keystroke may have set it true
      // before being aborted, and leaving it stuck would render a
      // "Searching…" row under a place we've already matched.
      setLoading(false);
      return;
    }
    const q = draft.trim();
    if (q.length < GEOCODE_MIN_CHARS) {
      setMatches([]);
      setLoading(false);
      return;
    }
    // Flag the lookup as loading for the whole debounce window, not just
    // once the request fires: `matches` still holds the PREVIOUS query's
    // results here, and the combobox suppresses items (display and
    // keyboard selection) while loading — otherwise a fast typist could
    // arrow-Enter a stale result that belongs to a different draft.
    setLoading(true);
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      api
        .GET("/api/v1/geocode", {
          params: { query: { q } as never },
          signal: ctrl.signal,
        })
        .then(({ data, error }) => {
          if (ctrl.signal.aborted) return;
          setLoading(false);
          if (error) {
            setMatches([]);
            return;
          }
          const d = data as unknown as {
            results: Match[];
          };
          setMatches(d.results ?? []);
        })
        .catch((err: Error) => {
          if (ctrl.signal.aborted) return;
          setLoading(false);
          if (err.name !== "AbortError") setMatches([]);
        });
    }, GEOCODE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      // Cancel any in-flight request so a late resolution can't overwrite
      // state after the draft has moved on (or the component unmounted).
      abortRef.current?.abort();
    };
  }, [draft, selectedLabel]);
  function pick(match: Match) {
    onChange({
      label: match.label,
      lat: match.lat,
      lng: match.lng,
      km: value?.km ?? DEFAULT_RADIUS_KM,
    });
    setDraft(match.label);
  }
  function clear() {
    onChange(null);
    setDraft("");
    setMatches([]);
    setRadiusOpen(false);
  }
  return (
    <div className="flex flex-col gap-1.5 flex-1 min-w-[220px]">
      <span className="font-mono text-[10px] font-bold uppercase tracking-[1.5px] text-fg-dim">
        {resolvedLabel}
      </span>
      <div
        ref={containerRef}
        className="relative"
        // Mirror the combobox menu: the radius popover also closes when
        // focus leaves the control (Tab past the radios/attribution to the
        // next filter) or on Escape, so it can't sit stale over the
        // following fields with the chip still reporting aria-expanded.
        onBlur={(event) => {
          if (!containerRef.current?.contains(event.relatedTarget as Node)) {
            setRadiusOpen(false);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setRadiusOpen(false);
        }}
      >
        <SearchCombobox
          ariaLabel={resolvedLabel}
          query={draft}
          onQueryChange={(next) => {
            setDraft(next);
            setRadiusOpen(false);
          }}
          items={matches.map((m, i) => ({
            value: matchKey(m, i),
            label: m.label,
          }))}
          onSelect={(key) => {
            const match = matches.find((m, i) => matchKey(m, i) === key);
            if (match) pick(match);
          }}
          loading={loading}
          minChars={GEOCODE_MIN_CHARS}
          placeholder={resolvedPlaceholder}
          loadingMessage={t("Searching…")}
          emptyMessage={t("No matches")}
          leadingIcon={<MapPin size={14} />}
          onClear={clear}
          // The near-filter can outlive the typed text (rider erases the
          // label while the place is still applied) — keep it clearable.
          clearVisible={draft !== "" || value !== null}
          trailing={
            value ? (
              <button
                type="button"
                onClick={() => setRadiusOpen((open) => !open)}
                aria-expanded={radiusOpen}
                aria-label={t("Search radius: {distance}", {
                  distance: format.distanceKm(value.km),
                })}
                className="whitespace-nowrap rounded-md border border-line-strong bg-cream px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.4px] text-fg-dim transition hover:border-ink hover:text-ink"
              >
                {format.distanceKm(value.km)}
              </button>
            ) : undefined
          }
        />
        {radiusOpen && value && (
          <div className="absolute right-0 z-20 mt-1 w-full min-w-[280px] rounded-[10px] border border-line-strong bg-paper p-3 shadow-[0_8px_24px_rgba(14,14,16,0.08)]">
            <span className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[1.5px] text-fg-dim">
              {t("Search radius")}
            </span>
            <SegmentedControl
              ariaLabel={t("Search radius")}
              value={String(value.km)}
              onChange={(km) =>
                onChange({
                  label: value.label,
                  lat: value.lat,
                  lng: value.lng,
                  km: Number(km),
                })
              }
              options={RADIUS_CHOICES.map((km) => ({
                value: String(km),
                label: format.distanceKm(km),
              }))}
            />
            <div className="mt-2.5">
              <RadiusPreviewMap lat={value.lat} lng={value.lng} km={value.km} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
