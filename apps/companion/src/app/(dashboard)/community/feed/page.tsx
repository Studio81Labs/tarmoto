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
import { CommunitySidebar } from "@/components/community/CommunitySidebar";
import {
  PlaceSearch,
  type PlaceValue,
} from "../../rides/_components/PlaceSearch";
import {
  buildCommunityRideQuery,
  type RideTypeFilter,
} from "@/lib/community-feed";
import { useAuthStore } from "@/stores/auth";
import { Card, Mono } from "@tarmoto/ui";
import { CommunityScaffold } from "../_CommunityScaffold";
import { CommunityEmptyState } from "../_CommunityEmptyState";
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
  const [rideType, setRideType] = useState<RideTypeFilter>("all");
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
  // Wait for `AuthSync` to hydrate the token before fetching — otherwise the
  // first request races it and goes out anonymously, which the backend now
  // filters down to public-profile owners only (the feed is optional-auth).
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
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
    if (!authReady) return;
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
  }, [query, authReady]);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  // Distinguish "pristine empty feed" (no filters, nothing in the
  // global community pool yet) from "filtered to zero" — the former
  // gets the spec's `Quiet on the feed` card, the latter keeps the
  // existing inline "no matching rides" copy + active filter Card so
  // the rider can clear or broaden the search.
  const hasActiveFilter =
    sort !== "most_popular" ||
    rideType !== "all" ||
    minQuality !== "all" ||
    minPopularity !== "all" ||
    minCurviness !== "all" ||
    minDistanceKm !== "" ||
    maxDistanceKm !== "" ||
    location !== null ||
    offset > 0;
  const isPristineEmpty =
    !loading && !error && items.length === 0 && !hasActiveFilter;
  return (
    <CommunityScaffold
      feedBadge={loading ? null : <Mono className="text-[11px]">{total}</Mono>}
    >
      <Card
        padded={false}
        className="mb-6 grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3"
      >
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
            // FilterSelect emits a bare string; the options are exactly
            // "all" + RIDE_TYPES, so the value is always a RideTypeFilter.
            setRideType(value as RideTypeFilter);
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
          <span className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[1.5px] text-fg-dim">
            {t("Minimum distance ")}
          </span>
          <div className="relative">
            <Route
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-mute"
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
              className="w-full rounded-lg border border-line bg-paper py-2 pl-8 pr-3 text-sm text-ink placeholder:text-fg-mute transition focus:border-ink focus:outline-none"
            />
          </div>
        </label>

        <label className="block">
          <span className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[1.5px] text-fg-dim">
            {t("Maximum distance ")}
          </span>
          <div className="relative">
            <Route
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-mute"
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
              className="w-full rounded-lg border border-line bg-paper py-2 pl-8 pr-3 text-sm text-ink placeholder:text-fg-mute transition focus:border-ink focus:outline-none"
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
      </Card>

      {location && (
        <p className="mb-6 text-sm text-fg-dim">
          {t("Filtering within {distance} km of", {
            distance: location.km,
          })}{" "}
          <span className="font-semibold text-ink">{location.label}</span>.
        </p>
      )}

      <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-[1fr_320px]">
        <div className="flex min-w-0 flex-col gap-[14px]">
          {error ? (
            <div className="rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-4 text-sm text-red-400">
              {error}
            </div>
          ) : loading ? (
            <div className="flex items-center gap-2 rounded-xl border border-line bg-cream p-4 text-sm text-fg-dim">
              <Loader2 size={16} className="animate-spin" />
              {t("Loading community rides\u2026 ")}
            </div>
          ) : isPristineEmpty ? (
            <CommunityEmptyState
              icon={<Users size={18} strokeWidth={2} />}
              title={t("Quiet on the feed")}
              body={t(
                "Once you follow other riders or land in a busy region, their shared routes will appear here.",
              )}
            />
          ) : items.length === 0 ? (
            <Card padded={false} className="p-16 text-center">
              <Users size={48} className="mx-auto mb-4 text-fg-mute" />
              <p className="mb-2 text-lg font-semibold text-ink">
                {t("No rides match these filters ")}
              </p>
              <p className="text-sm text-fg-dim">
                {t(
                  "Try broadening the feed or switching back to the most popular rides. ",
                )}
              </p>
            </Card>
          ) : (
            <>
              {items.map((ride) => (
                <CommunityRideCard key={ride.id} ride={ride} />
              ))}

              {pageCount > 1 && (
                <Card
                  padded={false}
                  className="flex items-center justify-between gap-3 p-4"
                >
                  <p className="font-mono text-sm text-fg-dim tabular-nums">
                    {t("Page {currentPage} of {pageCount}", {
                      currentPage,
                      pageCount,
                    })}
                  </p>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setOffset((current) => Math.max(current - PAGE_SIZE, 0))
                      }
                      disabled={offset === 0}
                      className="inline-flex items-center gap-1.5 px-3 py-[5px] rounded-full border border-line-strong bg-cream text-ink text-[11px] font-bold uppercase tracking-[0.2px] hover:bg-paper transition disabled:cursor-not-allowed disabled:opacity-50"
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
                      className="inline-flex items-center gap-1.5 px-3 py-[5px] rounded-full border border-line-strong bg-cream text-ink text-[11px] font-bold uppercase tracking-[0.2px] hover:bg-paper transition disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t("Next ")}
                    </button>
                  </div>
                </Card>
              )}
            </>
          )}
        </div>

        {!error && <CommunitySidebar />}
      </div>
    </CommunityScaffold>
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
      <label
        htmlFor={id}
        className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[1.5px] text-fg-dim"
      >
        {label}
      </label>
      <select
        id={id}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink transition focus:border-ink focus:outline-none"
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
