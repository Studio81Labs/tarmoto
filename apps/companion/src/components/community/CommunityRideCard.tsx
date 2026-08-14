"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Heart, Plus } from "lucide-react";
import { Button, QualityBars } from "@tarmoto/ui";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
import { communityApi, type CommunityRide } from "@/lib/api";
import { UserAvatar } from "@/components/UserAvatar";
import { buildRoutePreview } from "@/lib/ride-detail";
import { rideTypeLabel, scoreToQualityTier } from "@/lib/utils";
import { useFormat } from "@/format/FormatProvider";

/**
 * v2 community feed card: route mini-map on the left, ride title + quality
 * bars, author, optional caption, and a stats footer (km / hearts / clones)
 * with a clone-to-trips action. Hearts and clones hit the new community
 * engagement endpoints; `viewer_has_liked` drives the initial heart state.
 */
export function CommunityRideCard({ ride }: { ride: CommunityRide }) {
  const t = useTranslation();
  const router = useRouter();
  const format = useFormat();
  const preview = buildRoutePreview(ride.route_geometry, 200, 8);
  // Gated at the DERIVATION, not at the JSX below: `tier` feeds the bars and
  // anything added later reads the same value, so one gate covers the surface
  // instead of each render site needing to remember.
  const { enabled: qualityEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  const tier = qualityEnabled
    ? scoreToQualityTier(ride.avg_road_quality)
    : null;
  const title = ride.name?.trim() || format.shortDate(ride.started_at);
  // Value and unit come from the same split call so the footer honors the
  // rider's unit preference instead of pairing a converted value with a
  // hardcoded "KM" translation key.
  const distanceLabel =
    ride.distance_km != null ? format.distanceKm(ride.distance_km) : null;
  // Open the ride detail under the community route so the Community nav item
  // stays active and the back link returns to the feed. It renders the same
  // detail view as ride history; `GET /rides/:id` serves publicly-shared rides
  // to non-owners, so this works for every community ride, not just your own.
  const rideHref = `/community/rides/${encodeURIComponent(ride.id)}`;

  const [liked, setLiked] = useState(ride.viewer_has_liked);
  const [likeCount, setLikeCount] = useState(ride.like_count);
  const [cloneCount, setCloneCount] = useState(ride.clone_count);
  const [cloning, setCloning] = useState(false);
  // The global feed still returns stats-only rides with no track; the backend
  // rejects cloning those (400), so the action is disabled for them.
  // Cloning MINTS a draft trip, so it is a trip-creation path like the planner
  // and Duplicate — a third one, reached from the community feed rather than
  // from /trips, which is why it survived the earlier gates.
  const { enabled: tripPlanningEnabled } =
    useFeatureKillSwitch("trip_planning");
  const tripPlanningEnabledRef = useRef(tripPlanningEnabled);
  tripPlanningEnabledRef.current = tripPlanningEnabled;
  const canClone =
    (ride.route_geometry?.length ?? 0) >= 2 && tripPlanningEnabled;

  const toggleLike = async () => {
    // Optimistic flip; revert on failure.
    const next = !liked;
    setLiked(next);
    setLikeCount((c) => c + (next ? 1 : -1));
    try {
      const { data } = next
        ? await communityApi.like(ride.id)
        : await communityApi.unlike(ride.id);
      setLiked(data.viewer_has_liked);
      setLikeCount(data.like_count);
    } catch {
      setLiked(!next);
      setLikeCount((c) => c + (next ? -1 : 1));
    }
  };

  const clone = async () => {
    // Through the ref: re-read at the moment of the mutation, since a handler
    // captured before the flip carries an equally stale value.
    if (cloning || !canClone || !tripPlanningEnabledRef.current) return;
    setCloning(true);
    try {
      const { data } = await communityApi.clone(ride.id);
      setCloneCount(data.clone_count);
      router.push(`/trips/${data.trip_id}`);
    } catch {
      setCloning(false);
    }
  };

  return (
    <article className="grid grid-cols-1 gap-[18px] rounded-[14px] border border-line bg-cream p-4 md:grid-cols-[200px_1fr]">
      <Link
        href={rideHref}
        className="block h-[150px] overflow-hidden rounded-[10px] bg-paper"
        aria-label={t("{title} route preview", { title })}
      >
        {preview ? (
          <svg
            viewBox={preview.viewBox}
            className="h-full w-full"
            role="img"
            aria-hidden="true"
          >
            <path
              d={preview.path}
              fill="none"
              stroke="var(--color-accent)"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="4"
            />
          </svg>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-fg-dim">
            {t("No preview")}
          </div>
        )}
      </Link>

      <div className="flex min-w-0 flex-col">
        <div className="flex items-start justify-between gap-3">
          <Link
            href={rideHref}
            className="truncate text-[18px] font-extrabold tracking-[-0.2px] text-ink transition hover:text-accent"
          >
            {title}
          </Link>
          {tier != null && (
            <span className="shrink-0 pt-1">
              <QualityBars q={tier} size={5} />
            </span>
          )}
        </div>

        <Link
          href={`/community/${encodeURIComponent(ride.rider_id)}`}
          className="mt-1.5 flex items-center gap-2 text-xs text-fg-dim transition hover:text-ink"
        >
          <UserAvatar name={ride.rider_name} size={22} fontSize={11} />
          <span className="font-semibold text-ink">{ride.rider_name}</span>
          <span className="text-fg-mute">·</span>
          <span>{t(rideTypeLabel(ride.ride_type))}</span>
        </Link>

        {ride.description && (
          <p className="mt-2.5 line-clamp-2 flex-1 text-[13px] leading-[1.5] text-fg-dim">
            {ride.description}
          </p>
        )}

        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3.5 font-mono text-[11px] text-fg-dim">
            <span>
              <span className="font-bold text-ink">{distanceLabel ?? "—"}</span>
            </span>
            <button
              type="button"
              onClick={toggleLike}
              aria-pressed={liked}
              aria-label={liked ? t("Unlike") : t("Like")}
              className="inline-flex items-center gap-1 transition hover:text-ink"
            >
              <Heart
                size={12}
                className={liked ? "fill-accent text-accent" : ""}
              />
              {format.integer(likeCount)}
            </button>
            <span className="inline-flex items-center gap-1">
              <Plus size={12} />
              {format.integer(cloneCount)}
            </span>
          </div>

          {tripPlanningEnabled && (
            <Button
              variant="accent"
              size="sm"
              className="shrink-0"
              onClick={clone}
              disabled={cloning || !canClone}
              title={
                canClone ? undefined : t("This route has no track to clone")
              }
            >
              {cloning ? t("Adding…") : t("Add to trips →")}
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}
