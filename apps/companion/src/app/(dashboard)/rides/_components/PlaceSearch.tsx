"use client";
import { t } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { MapPin, X } from "lucide-react";
import { api } from "@/lib/api";
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
const RADIUS_CHOICES: Array<{
  km: number;
  label: string;
}> = [
  { km: 10, label: "10 km" },
  { km: 25, label: "25 km" },
  { km: 50, label: "50 km" },
  { km: 100, label: "100 km" },
];
const DEFAULT_RADIUS_KM = 25;
const GEOCODE_DEBOUNCE_MS = 350;
const GEOCODE_MIN_CHARS = 2;
export function PlaceSearch({
  value,
  onChange,
  label = "Passes near place",
  placeholder = "Tatra Mountains…",
}: Props) {
  const [draft, setDraft] = useState(value?.label ?? "");
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    setDraft(value?.label ?? "");
  }, [value?.label]);
  // Close the dropdown on outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
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
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
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
    setOpen(false);
  }
  function clear() {
    onChange(null);
    setDraft("");
    setMatches([]);
  }
  return (
    <div className="flex flex-col gap-1.5 flex-1 min-w-[220px]">
      <span className="font-mono text-[10px] font-bold uppercase tracking-[1.5px] text-fg-dim">
        {label}
      </span>
      <div ref={containerRef} className="relative">
        <MapPin
          size={14}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-mute pointer-events-none"
        />
        <input
          type="search"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="w-full bg-paper border border-line rounded-lg pl-7 pr-8 py-1.5 text-sm text-ink placeholder:text-fg-mute focus:outline-none focus:border-ink transition"
        />
        {(draft || value) && (
          <button
            type="button"
            aria-label={t("Clear place filter")}
            onClick={clear}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-fg-mute hover:text-ink transition"
          >
            <X size={14} />
          </button>
        )}
        {open && draft.trim().length >= GEOCODE_MIN_CHARS && (
          <div className="absolute z-10 mt-1 w-full rounded-lg bg-cream border border-line shadow-[0_12px_32px_rgba(14,14,16,0.14)] overflow-hidden">
            {loading && (
              <div className="px-3 py-2 text-xs text-fg-dim">
                {t("Searching\u2026")}
              </div>
            )}
            {!loading && matches.length === 0 && (
              <div className="px-3 py-2 text-xs text-fg-mute">
                {t("No matches")}
              </div>
            )}
            {!loading &&
              matches.map((m, i) => (
                <button
                  // Composite key: lat/lng alone collides when Nominatim
                  // returns overlapping admin levels (a city and its
                  // county can share the centroid). Adding the label and
                  // index makes the key unique even for dual-tagged hits
                  // while staying stable across re-renders of the same
                  // result set.
                  key={`${m.lat},${m.lng}|${m.label}|${i}`}
                  type="button"
                  onClick={() => pick(m)}
                  className="block w-full text-left px-3 py-1.5 text-sm text-ink hover:bg-paper truncate transition"
                  title={m.label}
                >
                  {m.label}
                </button>
              ))}
          </div>
        )}
      </div>
      {value && (
        <div className="flex items-center gap-1 mt-0.5">
          {RADIUS_CHOICES.map((r) => (
            <button
              key={r.km}
              type="button"
              onClick={() =>
                onChange({
                  label: value.label,
                  lat: value.lat,
                  lng: value.lng,
                  km: r.km,
                })
              }
              className={`px-2 py-0.5 rounded-full text-[11px] font-semibold transition ${
                value.km === r.km
                  ? "bg-ink text-cream"
                  : "bg-paper text-fg-dim hover:bg-paper-2 hover:text-ink"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
