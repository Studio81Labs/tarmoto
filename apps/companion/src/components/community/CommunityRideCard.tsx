"use client";
import { t } from "@/i18n";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Heart, Plus } from "lucide-react";
import { QualityBars } from "@tarmoto/ui";
import { communityApi, type CommunityRide } from "@/lib/api";
import { buildRoutePreview } from "@/lib/ride-detail";
import {
  formatKmValue,
  formatRideType,
  formatShortDate,
  scoreToQualityTier,
} from "@/lib/utils";

/**
 * v2 community feed card: route mini-map on the left, ride title + quality
 * bars, author, optional caption, and a stats footer (km / hearts / clones)
 * with a clone-to-trips action. Hearts and clones hit the new community
 * engagement endpoints; `viewer_has_liked` drives the initial heart state.
 */
export function CommunityRideCard({ ride }: { ride: CommunityRide }) {
  const router = useRouter();
  const preview = buildRoutePreview(ride.route_geometry, 200, 8);
  const tier = scoreToQualityTier(ride.avg_road_quality);
  const riderInitial = ride.rider_name.trim().charAt(0).toUpperCase() || "R";
  const title = ride.name?.trim() || formatShortDate(ride.started_at);

  const [liked, setLiked] = useState(ride.viewer_has_liked);
  const [likeCount, setLikeCount] = useState(ride.like_count);
  const [cloneCount, setCloneCount] = useState(ride.clone_count);
  const [cloning, setCloning] = useState(false);

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
    if (cloning) return;
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
        href={`/rides/shared/${encodeURIComponent(ride.share_token)}`}
        className="block h-[150px] overflow-hidden rounded-[10px] bg-paper"
        aria-label={`${title} route preview`}
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
            href={`/rides/shared/${encodeURIComponent(ride.share_token)}`}
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
          <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-[#E05A3C] text-[11px] font-extrabold text-ink">
            {riderInitial}
          </span>
          <span className="font-semibold text-ink">{ride.rider_name}</span>
          <span className="text-fg-mute">·</span>
          <span>{formatRideType(ride.ride_type)}</span>
        </Link>

        {ride.description && (
          <p className="mt-2.5 line-clamp-2 flex-1 text-[13px] leading-[1.5] text-fg-dim">
            {ride.description}
          </p>
        )}

        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3.5 font-mono text-[11px] text-fg-dim">
            <span>
              <span className="font-bold text-ink">
                {formatKmValue(ride.distance_km)}
              </span>{" "}
              {t("KM")}
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
              {likeCount}
            </button>
            <span className="inline-flex items-center gap-1">
              <Plus size={12} />
              {cloneCount}
            </span>
          </div>

          <button
            type="button"
            onClick={clone}
            disabled={cloning}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-[11px] font-bold text-ink transition hover:brightness-95 disabled:opacity-60"
          >
            {cloning ? t("Adding…") : t("Add to trips →")}
          </button>
        </div>
      </div>
    </article>
  );
}
