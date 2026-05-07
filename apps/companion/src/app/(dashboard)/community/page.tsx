"use client";
import { t } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import { Loader2, Route, Users } from "lucide-react";
import { RIDE_TYPES } from "@tarmoto/shared";
import {
  communityApi,
  type CommunityRide,
  type CommunityRideSort,
} from "@/lib/api";
import { CommunityRideCard } from "@/components/community/CommunityRideCard";
import { PlaceSearch, type PlaceValue } from "../rides/_components/PlaceSearch";
import { buildCommunityRideQuery } from "@/lib/community-feed";
const PAGE_SIZE = 9;
const SORT_OPTIONS: Array<{
  value: CommunityRideSort;
  label: string;
}> = [
  { value: "most_popular", label: "Most popular" },
  { value: "newest", label: "Newest" },
  { value: "highest_quality", label: "Highest quality" },
  { value: "nearest", label: "Nearest" },
  { value: "curviest", label: "Curviest" },
  { value: "longest", label: "Longest" },
];
export default function CommunityFeedPage() {
  const [sort, setSort] = useState<CommunityRideSort>("most_popular");
  const [rideType, setRideType] = useState("all");
  const [minQuality, setMinQuality] = useState("all");
  const [minPopularity, setMinPopularity] = useState("all");
  const [minCurviness, setMinCurviness] = useState("all");
  const [minDistanceKm, setMinDistanceKm] = useState("");
  const [maxDistanceKm, setMaxDistanceKm] = useState("");
  const [location, setLocation] = useState<PlaceValue | null>(null);
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<CommunityRide[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const query = useMemo(
    () =>
      buildCommunityRideQuery({
        sort,
        rideType,
        minQuality,
        minPopularity,
        minCurviness,
        minDistanceKm,
        maxDistanceKm,
        location,
        limit: PAGE_SIZE,
        offset,
      }),
    [
      sort,
      rideType,
      minQuality,
      minPopularity,
      minCurviness,
      minDistanceKm,
      maxDistanceKm,
      location,
      offset,
    ],
  );
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    communityApi
      .list(query)
      .then(({ data }) => {
        if (cancelled) return;
        setItems(data.items);
        setTotal(data.total);
      })
      .catch((err) => {
        if (cancelled) return;
        setItems([]);
        setTotal(0);
        setError(err instanceof Error ? err.message : "Could not load rides.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  return (
    <div className="mx-auto max-w-7xl animate-fade-in p-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t("Community")}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {total === 1
              ? "1 ride found"
              : `${total.toLocaleString()} rides found`}
          </p>
        </div>

        <p className="text-sm text-slate-500">
          {t(
            "Explore popular shared rides and discover routes worth repeating. ",
          )}
        </p>
      </div>

      <div className="mb-6 grid gap-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-4 md:grid-cols-2 xl:grid-cols-3">
        <FilterSelect
          id="sort-feed"
          label="Sort feed"
          value={sort}
          onChange={(value) => {
            setSort(value as CommunityRideSort);
            setOffset(0);
          }}
          options={SORT_OPTIONS}
          disabledOptions={location ? [] : ["nearest"]}
        />

        <FilterSelect
          id="ride-type"
          label="Ride type"
          value={rideType}
          onChange={(value) => {
            setRideType(value);
            setOffset(0);
          }}
          options={[
            { value: "all", label: "All rides" },
            ...RIDE_TYPES.map((type) => ({
              value: type,
              label: type.charAt(0).toUpperCase() + type.slice(1),
            })),
          ]}
        />

        <FilterSelect
          id="min-quality"
          label="Minimum quality"
          value={minQuality}
          onChange={(value) => {
            setMinQuality(value);
            setOffset(0);
          }}
          options={[
            { value: "all", label: "Any condition" },
            { value: "3", label: "3.0+/5" },
            { value: "4", label: "4.0+/5" },
          ]}
        />

        <FilterSelect
          id="min-popularity"
          label="Minimum popularity"
          value={minPopularity}
          onChange={(value) => {
            setMinPopularity(value);
            setOffset(0);
          }}
          options={[
            { value: "all", label: "Any reach" },
            { value: "100", label: "100+ views" },
            { value: "250", label: "250+ views" },
            { value: "500", label: "500+ views" },
          ]}
        />

        <FilterSelect
          id="min-curviness"
          label="Minimum curviness"
          value={minCurviness}
          onChange={(value) => {
            setMinCurviness(value);
            setOffset(0);
          }}
          options={[
            { value: "all", label: "Any road" },
            { value: "4", label: "4.0+" },
            { value: "6", label: "6.0+" },
          ]}
        />

        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">
            {t("Minimum distance ")}
          </span>
          <div className="relative">
            <Route
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
            />
            <input
              aria-label={t("Minimum distance")}
              type="number"
              min={0}
              step={10}
              value={minDistanceKm}
              onChange={(event) => {
                setMinDistanceKm(event.target.value);
                setOffset(0);
              }}
              placeholder={t("Any")}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 py-2 pl-8 pr-3 text-sm text-white transition focus:border-tarmoto-cyan focus:outline-none"
            />
          </div>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">
            {t("Maximum distance ")}
          </span>
          <div className="relative">
            <Route
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
            />
            <input
              aria-label={t("Maximum distance")}
              type="number"
              min={0}
              step={10}
              value={maxDistanceKm}
              onChange={(event) => {
                setMaxDistanceKm(event.target.value);
                setOffset(0);
              }}
              placeholder={t("Any")}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 py-2 pl-8 pr-3 text-sm text-white transition focus:border-tarmoto-cyan focus:outline-none"
            />
          </div>
        </label>

        <PlaceSearch
          value={location}
          onChange={(next) => {
            setLocation(next);
            if (!next && sort === "nearest") {
              setSort("most_popular");
            }
            setOffset(0);
          }}
          label="Region or place"
          placeholder={t("Brno, Tyrol, Tatra Mountains\u2026")}
        />
      </div>

      {location && (
        <p className="mb-6 text-sm text-slate-400">
          {t("Filtering within ")}
          {location.km}
          {t("km of")} <span className="text-slate-200">{location.label}</span>.
        </p>
      )}

      {error ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-300">
          {error}
        </div>
      ) : loading ? (
        <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">
          <Loader2 size={16} className="animate-spin" />
          {t("Loading community rides\u2026 ")}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-16 text-center">
          <Users size={48} className="mx-auto mb-4 text-slate-600" />
          <p className="mb-2 text-lg text-slate-300">
            {t("No rides match these filters ")}
          </p>
          <p className="text-sm text-slate-500">
            {t(
              "Try broadening the feed or switching back to the most popular rides. ",
            )}
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {items.map((ride) => (
              <CommunityRideCard key={ride.id} ride={ride} />
            ))}
          </div>

          <div className="mt-6 flex items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
            <p className="text-sm text-slate-400">
              {t("Page ")}
              {currentPage}
              {t("of ")}
              {pageCount}
            </p>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  setOffset((current) => Math.max(current - PAGE_SIZE, 0))
                }
                disabled={offset === 0}
                className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("Previous ")}
              </button>
              <button
                type="button"
                onClick={() =>
                  setOffset((current) =>
                    current + PAGE_SIZE >= total
                      ? current
                      : current + PAGE_SIZE,
                  )
                }
                disabled={offset + PAGE_SIZE >= total}
                className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("Next ")}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
  disabledOptions = [],
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{
    value: string;
    label: string;
  }>;
  disabledOptions?: string[];
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs text-slate-500">
        {label}
      </label>
      <select
        id={id}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white transition focus:border-tarmoto-cyan focus:outline-none"
      >
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={disabledOptions.includes(option.value)}
          >
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
