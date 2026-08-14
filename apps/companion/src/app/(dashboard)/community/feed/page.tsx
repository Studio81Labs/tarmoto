"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { getUserFacingErrorMessage, type EnglishMessageKey } from "@/i18n";
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
import { useFormat } from "@/format/FormatProvider";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
import { LocalizedStyledValue } from "@/i18n/LocalizedStyledValue";
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
  const t = useTranslation();
  const format = useFormat();
  const [sort, setSort] = useState<CommunityRideSort>("most_popular");
  const [rideType, setRideType] = useState<RideTypeFilter>("all");
  const [minQuality, setMinQuality] = useState("all");
  const [minPopularity, setMinPopularity] = useState("all");
  const [minCurviness, setMinCurviness] = useState("all");
  const [minDistanceKm, setMinDistanceKm] = useState("");
  const [maxDistanceKm, setMaxDistanceKm] = useState("");
  const [location, setLocation] = useState<PlaceValue | null>(null);
  const { enabled: qualityEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
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
  // Derived, never reset through an effect. An operator kill must stop the
  // quality dimension being ASKED FOR, not merely rendered — and a rider who
  // already had `highest_quality` selected when the switch flipped would
  // otherwise keep sending it. Deriving means no ordering or stale state can
  // put `min_quality` back on the wire.
  const effectiveSort: CommunityRideSort =
    !qualityEnabled && sort === "highest_quality" ? "most_popular" : sort;
  const effectiveMinQuality = qualityEnabled ? minQuality : "all";
  const query = useMemo(
    () =>
      buildCommunityRideQuery({
        sort: effectiveSort,
        rideType,
        minQuality: effectiveMinQuality,
        minPopularity,
        minCurviness,
        minDistanceKm,
        maxDistanceKm,
        location,
        limit: PAGE_SIZE,
        offset,
      }),
    [
      effectiveSort,
      rideType,
      effectiveMinQuality,
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
        setError(getUserFacingErrorMessage(err, t("Could not load rides.")));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t, query, authReady]);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  // Distinguish "pristine empty feed" (no filters, nothing in the
  // global community pool yet) from "filtered to zero" — the former
  // gets the spec's `Quiet on the feed` card, the latter keeps the
  // existing inline "no matching rides" copy + active filter Card so
  // the rider can clear or broaden the search.
  // The EFFECTIVE values, like the query and the sort control. Reading the raw
  // ones here makes a rider whose quality filter was just killed see "no rides
  // match your filters" over a feed that is in fact unfiltered — the third
  // reader of these two values in this file, so all of them now agree.
  const hasActiveFilter =
    effectiveSort !== "most_popular" ||
    rideType !== "all" ||
    effectiveMinQuality !== "all" ||
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
      feedBadge={
        loading ? null : (
          <Mono className="text-[11px]">{format.integer(total)}</Mono>
        )
      }
    >
      <Card
        padded={false}
        className="mb-6 grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3"
      >
        <Select
          label={t("Sort feed")}
          // The EFFECTIVE sort, not the raw one: with `highest_quality`
          // selected and then killed, its option is gone from the list, so a
          // raw `value` leaves the control showing a placeholder while the
          // request quietly uses the fallback. Display and query must agree.
          value={effectiveSort}
          onChange={(value) => {
            setSort(value as CommunityRideSort);
            setOffset(0);
          }}
          // "Nearest" needs a reference point — keep it visible but
          // unselectable until a place is picked below.
          options={SORT_OPTIONS.filter(
            (option) => qualityEnabled || option.value !== "highest_quality",
          ).map((option) => {
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

        {qualityEnabled ? (
          <Select
            label={t("Minimum quality")}
            value={minQuality}
            onChange={(value) => {
              setMinQuality(value);
              setOffset(0);
            }}
            options={[
              { value: "all", label: t("Any condition") },
              ...[3, 4].map((score) => ({
                value: String(score),
                label: t("{score} / {max}", {
                  score: t("{value}+", {
                    value: format.decimal(score, 1),
                  }),
                  max: format.integer(5),
                }),
              })),
            ]}
          />
        ) : null}

        <Select
          label={t("Minimum popularity")}
          value={minPopularity}
          onChange={(value) => {
            setMinPopularity(value);
            setOffset(0);
          }}
          options={[
            { value: "all", label: t("Any reach") },
            ...[100, 250, 500].map((count) => ({
              value: String(count),
              label: t("{count, plural, one {#+ view} other {#+ views}}", {
                count,
              }),
            })),
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
            ...[4, 6].map((value) => ({
              value: String(value),
              label: t("{value}+", { value: format.decimal(value, 1) }),
            })),
          ]}
        />

        <div>
          <FieldLabel htmlFor="min-distance-km">
            {t("Minimum distance")}
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
            {t("Maximum distance")}
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
            if (!next && effectiveSort === "nearest") {
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
          <LocalizedStyledValue
            t={t}
            messageKey="Filtering within {distance} of {location}."
            values={{ distance: format.distanceKm(location.km) }}
            valueName="location"
            formattedValue={location.label}
            className="font-semibold text-ink"
          />
        </p>
      )}

      {isPristineEmpty ? (
        // A pristine-empty feed has no ride list for the rail to sit beside,
        // so the card spans the full content width (matching the filter bar
        // above) instead of being pinned into the narrow `1fr` feed column.
        // The sidebar stays mounted below it — its "follow suggestions" and
        // challenge widgets are exactly the CTA the empty copy points to.
        <div className="flex flex-col gap-[18px]">
          <CommunityEmptyState
            icon={<Users size={18} strokeWidth={2} />}
            title={t("Quiet on the feed")}
            body={t(
              "Once you follow other riders or land in a busy region, their shared routes will appear here.",
            )}
          />
          <div className="lg:grid lg:grid-cols-[1fr_320px] lg:gap-[18px]">
            <div className="hidden lg:block" aria-hidden />
            <CommunitySidebar />
          </div>
        </div>
      ) : (
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
            ) : items.length === 0 ? (
              <Card padded={false} className="p-16 text-center">
                <Users size={48} className="mx-auto mb-4 text-fg-mute" />
                <p className="mb-2 text-lg font-semibold text-ink">
                  {t("No rides match these filters")}
                </p>
                <p className="text-sm text-fg-dim">
                  {t(
                    "Try broadening the feed or switching back to the most popular rides.",
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
      )}
    </CommunityScaffold>
  );
}
