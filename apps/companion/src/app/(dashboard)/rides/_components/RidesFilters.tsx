"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
import { type EnglishMessageKey } from "@/i18n";
import { useEffect, useState } from "react";
import { FilterX, Search } from "lucide-react";
import {
  Button,
  DatePicker,
  Input,
  SegmentedControl,
  Select,
  type SelectOption,
} from "@tarmoto/ui";
import type { RidesQueryState } from "./useRidesQuery";
import { PlaceSearch, type PlaceValue } from "./PlaceSearch";
import { useFormat } from "@/format/FormatProvider";

// Ride-type segmented control. "all" is a UI sentinel that clears the `type`
// filter; the rest map 1:1 to the backend ride_type values.
// "any" is a UI sentinel that clears the corresponding quality bound.
const QUALITY_VALUES = [1, 2, 3, 4, 5] as const;

const TYPE_OPTIONS: { value: string; label: EnglishMessageKey }[] = [
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
 * Keep digits and the first decimal separator — "12.5" stays "12.5"; a
 * second "." is dropped rather than producing an unparseable draft. Bare
 * digit-stripping would silently rewrite "12.5" into 125 and apply a far
 * stricter filter than the rider typed.
 */
function sanitizeKmDraft(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const dot = cleaned.indexOf(".");
  return dot === -1
    ? cleaned
    : cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replaceAll(".", "");
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
      // A trailing "." is a decimal mid-entry ("12." on the way to "12.5");
      // committing now would round-trip the URL and reset the draft to "12",
      // eating the separator under the rider's cursor. Wait for more input.
      if (draft.endsWith(".")) return;
      const next = draft === "" ? undefined : Number(draft);
      if (next !== undefined && !Number.isFinite(next)) return;
      if (next !== committed) commit(next);
    }, 300);
    return () => clearTimeout(debounceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
  return [draft, setDraft];
}

export function RidesFilters({ state, update, reset }: Props) {
  const t = useTranslation();
  const { enabled: qualityEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  const format = useFormat();
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
  const handleReset = () => {
    // Clear the local drafts alongside the URL state. Reset only rewrites
    // the URL, so an uncommitted draft (its debounce still pending) would
    // survive the sync-from-committed effect and re-apply its filter
    // moments after the rider cleared everything.
    setSearchLocal("");
    setMinKmLocal("");
    setMaxKmLocal("");
    reset();
  };
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
  const qualityOptions: SelectOption[] = [
    { value: "any", label: t("Any") },
    ...QUALITY_VALUES.map((value) => ({
      value: String(value),
      label: format.integer(value),
    })),
  ];
  const typeOptions = TYPE_OPTIONS.map((opt) => ({
    ...opt,
    label: t(opt.label),
  }));
  return (
    <div className="rounded-2xl bg-cream border border-line p-[18px] mb-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        {/* Label chrome lives on the inner span, never the wrapper — the mono
            bold/uppercase/tracking styles inherit into the field text
            otherwise (letter-spacing and text-transform cascade). */}
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("From")}</span>
          <DatePicker
            ariaLabel={t("From date")}
            value={state.from ?? ""}
            onChange={(next) => update({ from: next || undefined })}
            clearable
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("To")}</span>
          <DatePicker
            ariaLabel={t("To date")}
            value={state.to ?? ""}
            onChange={(next) => update({ to: next || undefined })}
            clearable
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("Min km")}</span>
          <Input
            ariaLabel={t("Min km")}
            value={minKmLocal}
            onChange={(next) => setMinKmLocal(sanitizeKmDraft(next))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("Max km")}</span>
          <Input
            ariaLabel={t("Max km")}
            value={maxKmLocal}
            onChange={(next) => setMaxKmLocal(sanitizeKmDraft(next))}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 mt-3">
        {/* The control pair goes with the dimension: its only axis is the
            killed one, and `useRidesQuery` already refuses `minQ`/`maxQ`, so
            leaving it would offer a filter that does nothing. */}
        {qualityEnabled ? (
          <div className="flex flex-col gap-1.5">
            <span className={labelClass}>{t("Quality (min → max)")}</span>
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
                options={qualityOptions}
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
                options={qualityOptions}
                className="w-24"
              />
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("Type")}</span>
          {/* size="field" so the segmented control lines up with the
              38px Inputs/Selects it sits among in this filter grid. */}
          <SegmentedControl
            size="field"
            ariaLabel={t("Ride type filter")}
            value={state.type ?? "all"}
            onChange={(next) =>
              update({ type: next === "all" ? undefined : next })
            }
            options={typeOptions}
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
            onClick={handleReset}
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
