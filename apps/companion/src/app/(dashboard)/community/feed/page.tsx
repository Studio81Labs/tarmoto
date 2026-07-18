"use client";
import { t, type EnglishMessageKey } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import { Route, Users } from "lucide-react";
import { RIDE_TYPES } from "@tarmoto/shared";
import {
  communityApi,
  type CommunityRide,
  type CommunityRideSort,
} from "@/lib/api";
import { CommunityRideCard } from "@/components/community/CommunityRideCard";
import { CommunitySidebar } from "@/components/community/CommunitySidebar";
import { Pagination } from "@/components/Pagination";
import {
  PlaceSearch,
  type PlaceValue,
} from "../../rides/_components/PlaceSearch";
import {
  buildCommunityRideQuery,
  type RideTypeFilter,
} from "@/lib/community-feed";
import { useAuthStore } from "@/stores/auth";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import {
  Card,
  FieldLabel,
  Input,
  Mono,
  Select,
  SkeletonList,
} from "@tarmoto/ui";
import { CommunityScaffold } from "../_CommunityScaffold";
import { CommunityEmptyState } from "../_CommunityEmptyState";
const PAGE_SIZE = 9;
const SORT_OPTIONS: Array<{
  value: CommunityRideSort;
  label: EnglishMessageKey;
}> = [
  { value: "most_popular", label: "Most popular" },
  { value: "newest", label: "Newest" },
  { value: "highest_quality", label: "Highest quality" },
  { value: "nearest", label: "Nearest" },
  { value: "curviest", label: "Curviest" },
  { value: "longest", label: "Longest" },
];
const RIDE_TYPE_LABEL = {
  free: "Free",
  commute: "Commute",
  trip: "Trip",
  tracked: "Tracked",
} satisfies Record<(typeof RIDE_TYPES)[number], EnglishMessageKey>;
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
  // Debounced: fast loads swap straight to content instead of flashing
  // the loader card for a frame or two.
  const showLoader = useDelayedLoading(loading);
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
        <Select
          label={t("Sort feed")}
          value={sort}
          onChange={(value) => {
            setSort(value as CommunityRideSort);
            setOffset(0);
          }}
          // "Nearest" needs a reference point — keep it visible but
          // unselectable until a place is picked below.
          options={SORT_OPTIONS.map((option) => {
            const translated = { ...option, label: t(option.label) };
            return option.value === "nearest" && !location
              ? { ...translated, disabled: true }
              : translated;
          })}
        />

        <Select
          label={t("Ride type")}
          value={rideType}
          onChange={(value) => {
            // Select emits a bare string; the options are exactly
            // "all" + RIDE_TYPES, so the value is always a RideTypeFilter.
            setRideType(value as RideTypeFilter);
            setOffset(0);
          }}
          options={[
            { value: "all", label: t("All rides") },
            ...RIDE_TYPES.map((type) => ({
              value: type,
              label: t(RIDE_TYPE_LABEL[type]),
            })),
          ]}
        />

        <Select
          label={t("Minimum quality")}
          value={minQuality}
          onChange={(value) => {
            setMinQuality(value);
            setOffset(0);
          }}
          options={[
            { value: "all", label: t("Any condition") },
            { value: "3", label: "3.0+/5" },
            { value: "4", label: "4.0+/5" },
          ]}
        />

        <Select
          label={t("Minimum popularity")}
          value={minPopularity}
          onChange={(value) => {
            setMinPopularity(value);
            setOffset(0);
          }}
          options={[
            { value: "all", label: t("Any reach") },
            { value: "100", label: t("100+ views") },
            { value: "250", label: t("250+ views") },
            { value: "500", label: t("500+ views") },
          ]}
        />

        <Select
          label={t("Minimum curviness")}
          value={minCurviness}
          onChange={(value) => {
            setMinCurviness(value);
            setOffset(0);
          }}
          options={[
            { value: "all", label: t("Any road") },
            { value: "4", label: "4.0+" },
            { value: "6", label: "6.0+" },
          ]}
        />

        <div>
          <FieldLabel htmlFor="min-distance-km">
            {t("Minimum distance ")}
          </FieldLabel>
          <Input
            id="min-distance-km"
            ariaLabel={t("Minimum distance")}
            value={minDistanceKm}
            onChange={(next) => {
              setMinDistanceKm(next.replace(/[^\d.]/g, ""));
              setOffset(0);
            }}
            placeholder={t("Any")}
            leadingIcon={<Route size={14} />}
          />
        </div>

        <div>
          <FieldLabel htmlFor="max-distance-km">
            {t("Maximum distance ")}
          </FieldLabel>
          <Input
            id="max-distance-km"
            ariaLabel={t("Maximum distance")}
            value={maxDistanceKm}
            onChange={(next) => {
              setMaxDistanceKm(next.replace(/[^\d.]/g, ""));
              setOffset(0);
            }}
            placeholder={t("Any")}
            leadingIcon={<Route size={14} />}
          />
        </div>

        <PlaceSearch
          value={location}
          onChange={(next) => {
            setLocation(next);
            if (!next && sort === "nearest") {
              setSort("most_popular");
            }
            setOffset(0);
          }}
          label={t("Region or place")}
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
            <div className="rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-4 text-sm text-red-700">
              {error}
            </div>
          ) : loading ? (
            showLoader && (
              <SkeletonList rows={4} label={t("Loading community rides…")} />
            )
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
                <Card padded={false} className="p-4">
                  <Pagination
                    currentPage={currentPage}
                    pageCount={pageCount}
                    onPrevious={() =>
                      setOffset((current) => Math.max(current - PAGE_SIZE, 0))
                    }
                    onNext={() =>
                      setOffset((current) =>
                        current + PAGE_SIZE >= total
                          ? current
                          : current + PAGE_SIZE,
                      )
                    }
                  />
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
