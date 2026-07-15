"use client";
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import { FilterX, Search } from "lucide-react";
import {
  Button,
  DatePicker,
  Input,
  SegmentedControl,
  Select,
  type SegmentedOption,
  type SelectOption,
} from "@tarmoto/ui";
import type { RidesQueryState } from "./useRidesQuery";
import { PlaceSearch, type PlaceValue } from "./PlaceSearch";

// Ride-type segmented control. "all" is a UI sentinel that clears the `type`
// filter; the rest map 1:1 to the backend ride_type values.
// "any" is a UI sentinel that clears the corresponding quality bound.
const QUALITY_OPTIONS: SelectOption[] = [
  { value: "any", label: "Any" },
  ...[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) })),
];

const TYPE_OPTIONS: SegmentedOption<string>[] = [
  { value: "all", label: "All" },
  { value: "free", label: "Free" },
  { value: "commute", label: "Commute" },
  { value: "trip", label: "Trip" },
  { value: "tracked", label: "Tracked" },
];
interface Props {
  state: RidesQueryState;
  update: (patch: Partial<RidesQueryState>) => void;
  reset: () => void;
}

/**
 * Local draft for a numeric filter, debounced before committing to the URL.
 * Same treatment as the search box below: the URL round-trip
 * (`router.replace` → `useSearchParams`) lags keystrokes, so an input
 * controlled directly by `state` snaps back to the stale value mid-word and
 * loses digits typed in quick succession.
 */
function useDebouncedNumberDraft(
  committed: number | undefined,
  commit: (next: number | undefined) => void,
): [string, (next: string) => void] {
  const [draft, setDraft] = useState(
    committed != null ? String(committed) : "",
  );
  useEffect(() => {
    setDraft(committed != null ? String(committed) : "");
  }, [committed]);
  useEffect(() => {
    const debounceId = setTimeout(() => {
      const next = draft === "" ? undefined : Number(draft);
      if (next !== committed) commit(next);
    }, 300);
    return () => clearTimeout(debounceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
  return [draft, setDraft];
}

export function RidesFilters({ state, update, reset }: Props) {
  // Local state for the search box — debounced before writing to URL.
  const [searchLocal, setSearchLocal] = useState(state.q ?? "");
  useEffect(() => {
    setSearchLocal(state.q ?? "");
  }, [state.q]);
  useEffect(() => {
    const debounceId = setTimeout(() => {
      if ((state.q ?? "") !== searchLocal) {
        update({ q: searchLocal || undefined });
      }
    }, 300);
    return () => clearTimeout(debounceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchLocal]);
  const [minKmLocal, setMinKmLocal] = useDebouncedNumberDraft(
    state.minDistance,
    (minDistance) => update({ minDistance }),
  );
  const [maxKmLocal, setMaxKmLocal] = useDebouncedNumberDraft(
    state.maxDistance,
    (maxDistance) => update({ maxDistance }),
  );
  const hasAny = Boolean(
    state.from ||
    state.to ||
    state.minDistance != null ||
    state.maxDistance != null ||
    state.minQuality != null ||
    state.maxQuality != null ||
    state.q ||
    state.type ||
    state.nearLat != null,
  );
  const placeValue: PlaceValue | null =
    state.nearLat != null && state.nearLng != null && state.nearKm != null
      ? {
          label: state.nearPlace ?? "",
          lat: state.nearLat,
          lng: state.nearLng,
          km: state.nearKm,
        }
      : null;
  const handlePlaceChange = (next: PlaceValue | null) => {
    if (next) {
      update({
        nearLat: next.lat,
        nearLng: next.lng,
        nearKm: next.km,
        nearPlace: next.label || undefined,
      });
    } else {
      update({
        nearLat: undefined,
        nearLng: undefined,
        nearKm: undefined,
        nearPlace: undefined,
      });
    }
  };
  const labelClass =
    "font-mono text-[10px] font-bold uppercase tracking-[1.5px] text-fg-dim";
  return (
    <div className="rounded-2xl bg-cream border border-line p-[18px] mb-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        {/* Label chrome lives on the inner span, never the wrapper — the mono
            bold/uppercase/tracking styles inherit into the field text
            otherwise (letter-spacing and text-transform cascade). */}
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("From ")}</span>
          <DatePicker
            ariaLabel={t("From date")}
            value={state.from ?? ""}
            onChange={(next) => update({ from: next || undefined })}
            clearable
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("To ")}</span>
          <DatePicker
            ariaLabel={t("To date")}
            value={state.to ?? ""}
            onChange={(next) => update({ to: next || undefined })}
            clearable
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("Min km ")}</span>
          <Input
            ariaLabel={t("Min km")}
            value={minKmLocal}
            onChange={(next) => setMinKmLocal(next.replace(/\D/g, ""))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("Max km ")}</span>
          <Input
            ariaLabel={t("Max km")}
            value={maxKmLocal}
            onChange={(next) => setMaxKmLocal(next.replace(/\D/g, ""))}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 mt-3">
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("Quality (min \u2192 max)")}</span>
          <div className="flex items-center gap-2">
            <Select
              ariaLabel={t("Min quality")}
              value={
                state.minQuality != null ? String(state.minQuality) : "any"
              }
              onChange={(next) =>
                update({
                  minQuality: next === "any" ? undefined : Number(next),
                })
              }
              options={QUALITY_OPTIONS}
              className="w-24"
            />
            <span className="text-fg-mute">–</span>
            <Select
              ariaLabel={t("Max quality")}
              value={
                state.maxQuality != null ? String(state.maxQuality) : "any"
              }
              onChange={(next) =>
                update({
                  maxQuality: next === "any" ? undefined : Number(next),
                })
              }
              options={QUALITY_OPTIONS}
              className="w-24"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("Type")}</span>
          <SegmentedControl
            ariaLabel={t("Ride type filter")}
            value={state.type ?? "all"}
            onChange={(next) =>
              update({ type: next === "all" ? undefined : next })
            }
            options={TYPE_OPTIONS}
          />
        </div>

        <div className="flex flex-col gap-1.5 flex-1 min-w-[180px]">
          <span className={labelClass}>{t("Search name")}</span>
          <Input
            type="search"
            ariaLabel={t("Search name")}
            value={searchLocal}
            onChange={setSearchLocal}
            placeholder={t("Sunday\u2026")}
            leadingIcon={<Search size={14} />}
          />
        </div>

        <PlaceSearch value={placeValue} onChange={handlePlaceChange} />

        {hasAny && (
          <Button
            iconOnly
            variant="secondary"
            size="sm"
            onClick={reset}
            aria-label={t("Reset filters")}
            title={t("Reset filters")}
          >
            <FilterX size={16} />
          </Button>
        )}
      </div>
    </div>
  );
}
