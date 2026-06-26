"use client";

import { t } from "@/i18n";
import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Stamp } from "@tarmoto/ui";
import { roadsApi, type RoadSegmentDetailResponse } from "@/lib/api";
import type { RiddenSegment } from "@/lib/road-map-layer";
import {
  QUALITY_CONFIG,
  formatDistanceFromMeters,
  formatShortDate,
  scoreToTier,
} from "@/lib/utils";
import type { UnitSystem } from "@tarmoto/shared";

/**
 * Cream "Road segment" detail popover anchored to the road-map corner. Opened
 * by clicking a ridden segment. The personal stats (quality / rides / last
 * ridden) come from the already-loaded {@link RiddenSegment}; the road name +
 * length are fetched lazily from the segment-detail endpoint so the all-
 * segments road-map payload stays lean.
 */
export function RoadSegmentPopover({
  segment,
  unitSystem,
  onClose,
}: {
  segment: RiddenSegment;
  unitSystem: UnitSystem;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<RoadSegmentDetailResponse | null>(null);
  // Whether the detail fetch has settled (resolved or failed). Distinguishes
  // "still loading" from "loaded but unavailable" so the name/distance fall
  // back to a real label instead of a stuck "Loading…".
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    // Reset while the new segment's detail loads so we never show a stale name.
    setDetail(null);
    setSettled(false);
    const controller = new AbortController();
    let cancelled = false;
    roadsApi
      .getSegmentDetail(segment.id, { signal: controller.signal })
      .then(({ data }) => {
        if (!cancelled) {
          setDetail(data);
          setSettled(true);
        }
      })
      .catch(() => {
        // Best-effort enrichment — the popover still shows the personal stats.
        if (!cancelled) setSettled(true);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [segment.id]);

  const score = segment.last_quality_score;
  const tier = score != null ? scoreToTier(score) : null;
  const tierInfo = tier ? QUALITY_CONFIG[tier] : null;

  const name = detail
    ? (detail.road_name ?? detail.road_number ?? t("Road segment"))
    : settled
      ? t("Road segment")
      : t("Loading…");
  const distance =
    detail?.length_m != null
      ? formatDistanceFromMeters(detail.length_m, unitSystem)
      : settled
        ? "—"
        : "…";

  return (
    <div className="absolute bottom-4 left-4 z-20 w-[300px] max-w-[calc(100%-2rem)] overflow-hidden rounded-[14px] border border-line bg-cream shadow-xl">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 pb-2.5 pt-3">
        <Stamp>{t("Road segment")}</Stamp>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("Close road segment")}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-line-strong text-fg-dim transition hover:border-ink hover:text-ink"
        >
          <X size={13} />
        </button>
      </div>

      <div className="p-4">
        <div className="flex items-center gap-3">
          <div
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-[18px] font-extrabold tracking-[-0.4px] text-ink ${
              tierInfo?.bg ?? "bg-paper"
            }`}
          >
            {score == null ? "N/A" : score.toFixed(1)}
          </div>
          <div className="min-w-0">
            <div className="truncate font-sans text-[16px] font-extrabold leading-[1.15] tracking-[-0.3px] text-ink">
              {name}
            </div>
            <div className="mt-0.5 text-[12px] text-fg-dim">
              {tierInfo
                ? t("{label} surface", { label: tierInfo.label })
                : t("Surface unrated")}
            </div>
          </div>
        </div>

        <div className="mt-3.5 grid grid-cols-3 gap-2">
          <Tile label={t("Rides")} value={String(segment.ride_count)} />
          <Tile label={t("Distance")} value={distance} />
          <Tile
            label={t("Last ridden")}
            value={formatShortDate(segment.last_ridden_at)}
          />
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-paper px-3 py-2.5">
      <Stamp className="block text-[10px] text-fg-mute">{label}</Stamp>
      <div className="mt-1.5 text-[13px] font-extrabold leading-tight text-ink">
        {value}
      </div>
    </div>
  );
}
