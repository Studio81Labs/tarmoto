"use client";

import { useId, useMemo } from "react";
import { AlertTriangle, ChevronDown, Images } from "lucide-react";
import type { RoutePreviewSegment } from "@/lib/types";
import {
  QUALITY_CONFIG,
  formatDistance,
  formatRelativeTime,
} from "@/lib/utils";
import {
  buildSparklinePath,
  curvinessLabel,
  formatElevationRange,
  segmentHazardSeverity,
} from "@/lib/segment-preview";
import { HAZARD_CONFIG } from "@/lib/utils";
import { SegmentTrendChart } from "@/components/SegmentTrendChart";
import { RoadReviewsPanel } from "@/components/RoadReviewsPanel";

const SEVERITY_COLOR: Record<"none" | "low" | "medium" | "high", string> = {
  none: "text-slate-500",
  low: "text-yellow-400",
  medium: "text-orange-400",
  high: "text-red-400",
};

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
          ? "border-tarmoto-cyan bg-tarmoto-cyan/5"
          : isHovered
            ? "border-slate-600 bg-slate-900"
            : "border-slate-800 bg-slate-900"
      }`}
    >
      <button
        type="button"
        onClick={onFocus}
        aria-pressed={isFocused}
        aria-label={`Focus segment ${segment.name ?? segment.id} on the map`}
        className="w-full text-left p-3"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                title={`Quality score ${segment.qualityScore.toFixed(1)}`}
                className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold text-slate-950 ${tier.bg}`}
              >
                {segment.qualityScore.toFixed(1)}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white truncate">
                  {segment.name ?? `Segment ${segment.orderInDay + 1}`}
                </p>
                <p className="text-xs text-slate-500">
                  Day {segment.dayNumber} · {formatDistance(segment.distanceKm)}
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {segment.photos.length > 0 && (
              <span
                className="flex items-center gap-1 text-xs text-slate-400"
                title={`${segment.photos.length} photo(s)`}
              >
                <Images size={12} />
                {segment.photos.length}
              </span>
            )}
            <span
              className={`flex items-center gap-1 text-xs ${SEVERITY_COLOR[severity]}`}
              title={severityLabel}
            >
              <AlertTriangle size={12} />
              {segment.activeHazards.length}
            </span>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
          <span>{curvinessLabel(segment.curvinessScore)}</span>
          <span className="tabular-nums">
            {formatElevationRange(segment.elevationProfile)}
          </span>
        </div>

        <svg
          viewBox="0 0 240 40"
          preserveAspectRatio="none"
          aria-hidden="true"
          className="mt-2 w-full h-10 text-tarmoto-cyan/70"
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

        {segment.photos.length > 0 && (
          <div className="mt-3 grid grid-cols-3 gap-1.5">
            {segment.photos.slice(0, 3).map((photo) => (
              <div
                key={photo.id}
                className="aspect-[4/3] rounded-md bg-slate-800 border border-slate-700 overflow-hidden text-[10px] text-slate-500 flex items-center justify-center"
                title={`${photo.riderName} · ${formatRelativeTime(photo.createdAt)}`}
              >
                {photo.riderName}
              </div>
            ))}
          </div>
        )}
      </button>

      <div className="flex items-center justify-end border-t border-slate-800 px-3 py-1.5">
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={isExpanded}
          aria-controls={detailId}
          className="flex items-center gap-1 text-xs text-slate-400 hover:text-white transition"
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
          className="border-t border-slate-800 px-3 py-3 space-y-4 text-xs text-slate-300"
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Stat
              label="Quality tier"
              value={tier.label}
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
            <Stat label="Distance" value={formatDistance(segment.distanceKm)} />
          </div>

          {segment.qualityHistory && segment.qualityHistory.length > 1 && (
            <div>
              <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
                Quality trend
              </p>
              <SegmentTrendChart
                segmentId={segment.id}
                history={segment.qualityHistory}
                regionalHistory={segment.regionalQualityHistory}
              />
            </div>
          )}

          <div>
            <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">
              Active hazards
            </p>
            {segment.activeHazards.length === 0 ? (
              <p className="text-slate-500">
                No active hazards on this segment.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {segment.activeHazards.map((hazard) => {
                  const cfg = HAZARD_CONFIG[hazard.type];
                  return (
                    <li key={hazard.id} className="flex items-start gap-2">
                      <span aria-hidden="true">{cfg.emoji}</span>
                      <div className="flex-1">
                        <p className="text-slate-200">
                          {cfg.label}
                          <span
                            className={`ml-2 text-[10px] uppercase tracking-wider ${SEVERITY_COLOR[hazard.severity]}`}
                          >
                            {hazard.severity}
                          </span>
                        </p>
                        {hazard.note && (
                          <p className="text-slate-400">{hazard.note}</p>
                        )}
                        <p className="text-slate-500 text-[10px] mt-0.5">
                          {hazard.reporterName} ·{" "}
                          {formatRelativeTime(hazard.createdAt)} ·{" "}
                          {hazard.confirmations} confirmations
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
              <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">
                Rider photos
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                {segment.photos.map((photo) => (
                  <div
                    key={photo.id}
                    className="aspect-[4/3] rounded-md bg-slate-800 border border-slate-700 overflow-hidden text-[10px] text-slate-500 flex items-center justify-center p-1 text-center"
                    title={`${photo.riderName} · ${formatRelativeTime(photo.createdAt)}`}
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
      <p className="text-[11px] uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p className={`text-sm font-medium ${valueClass ?? "text-white"}`}>
        {value}
      </p>
    </div>
  );
}
