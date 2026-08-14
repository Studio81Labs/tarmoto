"use client";

import { useTranslation } from "@/i18n/I18nProvider";

import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Stamp } from "@tarmoto/ui";
import { roadsApi, type RoadSegmentDetailResponse } from "@/lib/api";
import type { MaybeQualityRiddenSegment } from "@/lib/road-map-layer";
import { QUALITY_CONFIG, scoreToTier } from "@/lib/utils";
import { useFormat } from "@/format/FormatProvider";

/**
 * Cream "Road segment" detail popover anchored to the road-map corner. Opened
 * by clicking a ridden segment. The personal stats (quality / rides / last
 * ridden) come from the already-loaded {@link RiddenSegment}; the road name +
 * length are fetched lazily from the segment-detail endpoint so the all-
 * segments road-map payload stays lean.
 */
export function RoadSegmentPopover({
  segment,
  onClose,
}: {
  /** May arrive without `last_quality_score` when the operator has killed
   *  the overlay; the score below is already absence-tolerant. */
  segment: MaybeQualityRiddenSegment;
  onClose: () => void;
}) {
  const t = useTranslation();
  const format = useFormat();
  // The fetched detail, tagged with the segment id it belongs to. Tagging (vs a
  // plain `detail` + a separate reset effect) means a result from a previously-
  // selected segment can never render under the current one during the first
  // paint after a quick A→B switch — the reset would otherwise run post-paint.
  // `data: null` = settled but unavailable (failed / aborted enrichment).
  const [result, setResult] = useState<{
    id: string;
    data: RoadSegmentDetailResponse | null;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    roadsApi
      .getSegmentDetail(segment.id, { signal: controller.signal })
      .then(({ data }) => {
        if (!cancelled) setResult({ id: segment.id, data });
      })
      .catch(() => {
        // Best-effort enrichment — the popover still shows the personal stats.
        if (!cancelled) setResult({ id: segment.id, data: null });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [segment.id]);

  // Only use a result that matches the currently-selected segment. While a new
  // segment's fetch is in flight this is `false`, so name/distance show the
  // loading placeholder rather than the previous segment's values.
  const settled = result?.id === segment.id;
  const detail = settled ? result.data : null;

  const score = segment.last_quality_score;
  const tier = score != null ? scoreToTier(score) : null;
  const tierInfo = tier ? QUALITY_CONFIG[tier] : null;

  const name = detail
    ? (detail.road_name ?? detail.road_number ?? t("Road segment"))
    : settled
      ? t("Road segment")
      : t("Loading…");
  // Per-segment length (not the aggregated logical-road `length_m`) — this tile
  // sits with the per-`RiddenSegment` ride stats, so it must describe the
  // selected ~100 m segment, not the whole OSM way (#809).
  const distance =
    detail?.segment_length_m != null
      ? format.distanceM(detail.segment_length_m)
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
            {score == null ? "N/A" : format.decimal(score, 1)}
          </div>
          <div className="min-w-0">
            <div className="truncate font-sans text-[16px] font-extrabold leading-[1.15] tracking-[-0.3px] text-ink">
              {name}
            </div>
            <div className="mt-0.5 text-[12px] text-fg-dim">
              {tierInfo
                ? t("{label} surface", { label: t(tierInfo.label) })
                : t("Surface unrated")}
            </div>
          </div>
        </div>

        <div className="mt-3.5 grid grid-cols-3 gap-2">
          <Tile label={t("Rides")} value={format.integer(segment.ride_count)} />
          <Tile label={t("Distance")} value={distance} />
          <Tile
            label={t("Last ridden")}
            value={format.shortDate(segment.last_ridden_at)}
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
