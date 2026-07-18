"use client";
import { t } from "@/i18n";
import { useId, useMemo } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import type { RoutePreviewSegment } from "@/lib/types";
import { QUALITY_CONFIG } from "@/lib/utils";
import {
  buildSparklinePath,
  curvinessLabel,
  formatElevationRange,
  segmentHazardSeverity,
} from "@/lib/segment-preview";
import { HAZARD_CONFIG } from "@/lib/utils";
import { SegmentTrendChart } from "@/components/SegmentTrendChart";
import { RoadReviewsPanel } from "@/components/RoadReviewsPanel";
import { useFormat } from "@/format/FormatProvider";
import { MiniRouteSvg, QualityBars } from "@tarmoto/ui";
const SEVERITY_COLOR: Record<"none" | "low" | "medium" | "high", string> = {
  none: "text-fg-mute",
  low: "text-yellow-600",
  medium: "text-orange-500",
  high: "text-red-500",
};
/** Clamp a fractional 0–5 quality score to the 1–5 tier QualityBars takes. */
function tierOf(score: number): 1 | 2 | 3 | 4 | 5 {
  return Math.min(5, Math.max(1, Math.round(score))) as 1 | 2 | 3 | 4 | 5;
}
/** Stable per-card seed so two MiniRouteSvg thumbnails don't render identically. */
function seedOf(segment: RoutePreviewSegment): number {
  return segment.dayNumber * 31 + segment.orderInDay * 7 + 5;
}
interface RoadPreviewCardProps {
  segment: RoutePreviewSegment;
  isFocused: boolean;
  isHovered: boolean;
  isExpanded: boolean;
  onFocus: () => void;
  onHoverStart: () => void;
  onHoverEnd: () => void;
  onToggleExpand: () => void;
}
export function RoadPreviewCard({
  segment,
  isFocused,
  isHovered,
  isExpanded,
  onFocus,
  onHoverStart,
  onHoverEnd,
  onToggleExpand,
}: RoadPreviewCardProps) {
  const format = useFormat();
  const tier = QUALITY_CONFIG[segment.qualityTier];
  const severity = segmentHazardSeverity(segment);
  const elevationPath = useMemo(
    () => buildSparklinePath(segment.elevationProfile, 240, 40),
    [segment.elevationProfile],
  );
  const detailId = useId();
  const severityLabel = severity === "none" ? "No hazards" : `${severity} risk`;
  return (
    <div
      data-testid={`road-preview-card-${segment.id}`}
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      onFocus={onHoverStart}
      onBlur={onHoverEnd}
      className={`group rounded-xl border transition ${
        isFocused
          ? "border-accent bg-accent/5"
          : isHovered
            ? "border-line-strong bg-cream/60"
            : "border-line bg-cream/60"
      }`}
    >
      <button
        type="button"
        onClick={onFocus}
        aria-pressed={isFocused}
        aria-label={t("Focus segment {name} on the map", {
          name: segment.name ?? segment.id,
        })}
        className="flex w-full items-center gap-3 p-3 text-left"
      >
        <span className="w-[18px] shrink-0 text-center font-mono text-xs font-extrabold text-fg-mute">
          {String(segment.orderInDay + 1).padStart(2, "0")}
        </span>
        <span className="h-[46px] w-[68px] shrink-0 overflow-hidden rounded-lg border border-line">
          <MiniRouteSvg
            q={tierOf(segment.qualityScore)}
            seed={seedOf(segment)}
            className="h-full w-full"
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-bold text-ink">
            {segment.name ?? `Segment ${segment.orderInDay + 1}`}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[10px] uppercase tracking-[0.3px] text-fg-mute">
            {format.distanceKm(segment.distanceKm)} · {segment.surfaceType} ·{" "}
            {curvinessLabel(segment.curvinessScore)}
          </span>
        </span>
        {segment.activeHazards.length > 0 && (
          <span
            className={`flex shrink-0 items-center gap-1 text-xs ${SEVERITY_COLOR[severity]}`}
            title={severityLabel}
          >
            <AlertTriangle size={12} />
            {segment.activeHazards.length}
          </span>
        )}
        <QualityBars
          q={tierOf(segment.qualityScore)}
          size={4}
          className="shrink-0"
          ariaLabel={t("Quality score {score} of 5", {
            score: format.decimal(segment.qualityScore, 1),
          })}
        />
      </button>

      <div className="flex items-center justify-end border-t border-line px-3 py-1.5">
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={isExpanded}
          aria-controls={detailId}
          className="flex items-center gap-1 text-xs text-fg-dim transition hover:text-ink"
        >
          {isExpanded ? "Hide details" : "Show details"}
          <ChevronDown
            size={12}
            className={`transition-transform ${isExpanded ? "rotate-180" : ""}`}
          />
        </button>
      </div>

      {isExpanded && (
        <div
          id={detailId}
          className="space-y-4 border-t border-line px-3 py-3 text-xs text-fg-dim"
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Stat
              label="Quality score"
              value={`${format.decimal(segment.qualityScore, 1)} · ${tier.label}`}
              valueClass={tier.color}
            />
            <Stat
              label="Surface"
              value={segment.surfaceType.replace(/\b\w/g, (c) =>
                c.toUpperCase(),
              )}
            />
            <Stat
              label="Curviness"
              value={`${segment.curvinessScore} · ${curvinessLabel(segment.curvinessScore)}`}
            />
            <Stat
              label="Distance"
              value={format.distanceKm(segment.distanceKm)}
            />
          </div>

          <div>
            <p className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wider text-fg-mute">
              <span>{t("Elevation ")}</span>
              <span className="tabular-nums normal-case">
                {formatElevationRange(segment.elevationProfile)}
              </span>
            </p>
            <svg
              viewBox="0 0 240 40"
              preserveAspectRatio="none"
              aria-hidden="true"
              className="h-10 w-full text-accent/70"
            >
              <path
                d={elevationPath}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>

          {segment.qualityHistory && segment.qualityHistory.length > 1 && (
            <div>
              <p className="mb-2 text-[11px] uppercase tracking-wider text-fg-mute">
                {t("Quality trend ")}
              </p>
              <SegmentTrendChart
                segmentId={segment.id}
                history={segment.qualityHistory}
                regionalHistory={segment.regionalQualityHistory}
              />
            </div>
          )}

          <div>
            <p className="mb-1 text-[11px] uppercase tracking-wider text-fg-mute">
              {t("Active hazards ")}
            </p>
            {segment.activeHazards.length === 0 ? (
              <p className="text-fg-mute">
                {t("No active hazards on this segment. ")}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {segment.activeHazards.map((hazard) => {
                  const cfg = HAZARD_CONFIG[hazard.type];
                  return (
                    <li key={hazard.id} className="flex items-start gap-2">
                      <span aria-hidden="true">{cfg.emoji}</span>
                      <div className="flex-1">
                        <p className="text-ink">
                          {cfg.label}
                          <span
                            className={`ml-2 text-[10px] uppercase tracking-wider ${SEVERITY_COLOR[hazard.severity]}`}
                          >
                            {hazard.severity}
                          </span>
                        </p>
                        {hazard.note && (
                          <p className="text-fg-dim">{hazard.note}</p>
                        )}
                        <p className="mt-0.5 text-[10px] text-fg-mute">
                          {hazard.reporterName} ·{" "}
                          {format.relativeTime(hazard.createdAt)} ·{" "}
                          {hazard.confirmations}
                          {t("confirmations ")}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <RoadReviewsPanel segmentId={segment.id} />

          {segment.photos.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] uppercase tracking-wider text-fg-mute">
                {t("Rider photos ")}
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                {segment.photos.map((photo) => (
                  <div
                    key={photo.id}
                    className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-md border border-line bg-paper p-1 text-center text-[10px] text-fg-mute"
                    title={`${photo.riderName} · ${format.relativeTime(photo.createdAt)}`}
                  >
                    {photo.riderName}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
function Stat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-fg-mute">
        {label}
      </p>
      <p className={`text-sm font-medium ${valueClass ?? "text-ink"}`}>
        {value}
      </p>
    </div>
  );
}
