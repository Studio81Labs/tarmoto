"use client";
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import { RotateCcw, Search } from "lucide-react";
import type { RidesQueryState } from "./useRidesQuery";
import { PlaceSearch, type PlaceValue } from "./PlaceSearch";
const RIDE_TYPES = ["free", "commute", "trip", "tracked"] as const;
interface Props {
  state: RidesQueryState;
  update: (patch: Partial<RidesQueryState>) => void;
  reset: () => void;
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
  const fieldClass =
    "bg-paper border border-line rounded-lg px-2 py-1.5 text-sm text-ink focus:outline-none focus:border-ink transition";
  return (
    <div className="rounded-2xl bg-cream border border-line p-[18px] mb-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <label className={`${labelClass} flex flex-col gap-1.5`}>
          {t("From ")}
          <input
            type="date"
            value={state.from ?? ""}
            onChange={(e) => update({ from: e.target.value || undefined })}
            className={fieldClass}
          />
        </label>
        <label className={`${labelClass} flex flex-col gap-1.5`}>
          {t("To ")}
          <input
            type="date"
            value={state.to ?? ""}
            onChange={(e) => update({ to: e.target.value || undefined })}
            className={fieldClass}
          />
        </label>
        <label className={`${labelClass} flex flex-col gap-1.5`}>
          {t("Min km ")}
          <input
            type="number"
            min={0}
            value={state.minDistance ?? ""}
            onChange={(e) =>
              update({
                minDistance:
                  e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
            className={fieldClass}
          />
        </label>
        <label className={`${labelClass} flex flex-col gap-1.5`}>
          {t("Max km ")}
          <input
            type="number"
            min={0}
            value={state.maxDistance ?? ""}
            onChange={(e) =>
              update({
                maxDistance:
                  e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
            className={fieldClass}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-3 mt-3">
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("Quality (min \u2192 max)")}</span>
          <div className="flex items-center gap-2">
            <select
              value={state.minQuality ?? ""}
              onChange={(e) =>
                update({
                  minQuality:
                    e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
              className={fieldClass}
            >
              <option value="">{t("Any")}</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className="text-fg-mute">–</span>
            <select
              value={state.maxQuality ?? ""}
              onChange={(e) =>
                update({
                  maxQuality:
                    e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
              className={fieldClass}
            >
              <option value="">{t("Any")}</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("Type")}</span>
          <div className="flex flex-wrap gap-1.5">
            <TypeChip
              label="All"
              active={!state.type}
              onClick={() => update({ type: undefined })}
            />
            {RIDE_TYPES.map((rideType) => (
              <TypeChip
                key={rideType}
                label={rideType}
                active={state.type === rideType}
                onClick={() => update({ type: rideType })}
              />
            ))}
          </div>
        </div>

        <label className="flex flex-col gap-1.5 flex-1 min-w-[180px]">
          <span className={labelClass}>{t("Search name")}</span>
          <div className="relative">
            <Search
              size={14}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-mute"
            />
            <input
              type="search"
              value={searchLocal}
              onChange={(e) => setSearchLocal(e.target.value)}
              placeholder={t("Sunday\u2026")}
              className="w-full bg-paper border border-line rounded-lg pl-7 pr-2 py-1.5 text-sm text-ink placeholder:text-fg-mute focus:outline-none focus:border-ink transition"
            />
          </div>
        </label>

        <PlaceSearch value={placeValue} onChange={handlePlaceChange} />

        {hasAny && (
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1.5 px-3 py-[5px] rounded-full border border-line-strong bg-cream text-ink text-[11px] font-bold uppercase tracking-[0.2px] hover:bg-paper transition"
          >
            <RotateCcw size={14} />
            {t("Reset ")}
          </button>
        )}
      </div>
    </div>
  );
}
function TypeChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg border text-sm font-semibold transition ${
        active
          ? "bg-ink border-ink text-cream"
          : "bg-paper border-line text-ink hover:bg-paper-2"
      }`}
    >
      {label}
    </button>
  );
}
