"use client";

import { t } from "@/i18n";
import { useEffect, type ReactNode } from "react";
import {
  AlertTriangle,
  Clock,
  Gauge,
  Loader2,
  Route,
  Star,
  Users,
  X,
} from "lucide-react";
import { SegmentTrendChart } from "@/components/SegmentTrendChart";
import { RoadReviewsPanel } from "@/components/RoadReviewsPanel";
import type { RoadSegmentDetailResponse } from "@/lib/api";
import type { HazardType } from "@/lib/types";
import {
  HAZARD_CONFIG,
  QUALITY_CONFIG,
  formatDistanceFromMeters,
  formatRelativeTime,
  scoreToTier,
} from "@/lib/utils";
import type { QualityPoint } from "@/lib/segment-trend";
import { usePreferencesStore } from "@/stores/preferences";

export type SegmentDetailPanelState =
  | { status: "idle" }
  | { status: "loading"; segmentId: string }
  | { status: "ready"; segment: RoadSegmentDetailResponse }
  | { status: "not-found"; segmentId: string }
  | { status: "error"; segmentId: string; message: string };

interface SegmentDetailSidebarProps {
  state: SegmentDetailPanelState;
  onClose: () => void;
}

export function SegmentDetailSidebar({
  state,
  onClose,
}: SegmentDetailSidebarProps) {
  if (state.status === "idle") return null;

  return (
    <aside
      role="dialog"
      aria-label={t("Road segment details")}
      className="absolute inset-x-0 bottom-0 z-20 max-h-[78%] overflow-y-auto border-t border-line bg-paper/95 shadow-2xl backdrop-blur md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[430px] md:border-l md:border-t-0"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-paper/95 px-4 py-3 backdrop-blur">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-fg-dim">
            {t("Road segment ")}
          </p>
          <h2 className="truncate text-base font-semibold text-ink">
            {state.status === "ready"
              ? segmentTitle(state.segment)
              : t("Segment details")}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("Close segment details")}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line text-fg-dim transition hover:border-line-strong hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      {state.status === "loading" && (
        <StatusBlock
          icon={<Loader2 size={18} className="animate-spin" />}
          title={t("Loading road details")}
          body={t("Fetching the latest segment quality and community data. ")}
        />
      )}

      {state.status === "not-found" && (
        <StatusBlock
          icon={<AlertTriangle size={18} />}
          title={t("Road segment not found")}
          body={t(
            "This segment may have been merged, removed, or not synced from the tile source yet. ",
          )}
        />
      )}

      {state.status === "error" && (
        <StatusBlock
          icon={<AlertTriangle size={18} />}
          title={t("Could not load road details")}
          body={state.message}
        />
      )}

      {state.status === "ready" && (
        <SegmentDetailContent segment={state.segment} />
      )}
    </aside>
  );
}

function SegmentDetailContent({
  segment,
}: {
  segment: RoadSegmentDetailResponse;
}) {
  const unitSystem = usePreferencesStore((s) => s.unitSystem);
  const hydratePreferences = usePreferencesStore((s) => s.hydrate);
  const score = segment.quality_score ?? 0;
  const tier = score > 0 ? QUALITY_CONFIG[scoreToTier(score)] : null;
  const qualityHistory = trendPoints(segment.quality_history);
  const regionalHistory = trendPoints(segment.regional_quality_history);
  const hasTrend = qualityHistory.length > 1;

  useEffect(() => {
    hydratePreferences();
  }, [hydratePreferences]);

  return (
    <div className="space-y-5 px-4 py-4 text-sm text-ink">
      <section className="rounded-lg border border-line bg-cream p-4">
        <div className="flex items-start gap-3">
          <div
            className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-lg text-lg font-extrabold text-ink ${
              tier?.bg ?? "bg-paper"
            }`}
          >
            {segment.quality_score == null ? "N/A" : score.toFixed(1)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-semibold text-ink">
              {segmentTitle(segment)}
            </p>
            <p className="text-xs text-fg-dim">
              {segment.road_number ? `${segment.road_number} · ` : ""}
              {formatDistanceFromMeters(segment.length_m, unitSystem)}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <Pill>{tier?.label ?? t("Unknown quality")}</Pill>
              <Pill>{formatSurface(segment.surface_type)}</Pill>
            </div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-2">
        <Metric
          icon={<Gauge size={14} />}
          label={t("Confidence")}
          value={`${segment.confidence}%`}
        />
        <Metric
          icon={<Route size={14} />}
          label={t("Rider passes")}
          value={`${segment.reading_count} ${
            segment.reading_count === 1 ? "pass" : "passes"
          }`}
        />
        <Metric
          icon={<Users size={14} />}
          label={t("Recent riders")}
          value={`${segment.riders_per_month}/month`}
        />
        <Metric
          icon={<Clock size={14} />}
          label={t("Last updated")}
          value={formatRelativeTime(segment.last_updated)}
        />
      </section>

      <section className="rounded-lg border border-line bg-cream p-4">
        <p className="mb-3 text-[11px] uppercase tracking-wider text-fg-dim">
          {t("Quality mix ")}
        </p>
        <div className="space-y-2">
          {QUALITY_BREAKDOWN_ROWS.map((row) => (
            <div key={row.key}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-fg-dim">{row.label}</span>
                <span className="tabular-nums text-ink">
                  {segment.quality_breakdown[row.key]}%
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-paper">
                <div
                  className={`h-1.5 rounded-full ${row.bg}`}
                  style={{ width: `${segment.quality_breakdown[row.key]}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      {hasTrend && (
        <section className="rounded-lg border border-line bg-cream p-4">
          <p className="mb-3 text-[11px] uppercase tracking-wider text-fg-dim">
            {t("Quality trend ")}
          </p>
          <SegmentTrendChart
            segmentId={segment.id}
            history={qualityHistory}
            regionalHistory={regionalHistory}
          />
        </section>
      )}

      <section className="rounded-lg border border-line bg-cream p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-[11px] uppercase tracking-wider text-fg-dim">
            {t("Active hazards ")}
          </p>
          <span className="text-xs text-fg-dim">
            {segment.active_hazard_count}
          </span>
        </div>
        {segment.active_hazards.length === 0 ? (
          <p className="text-xs text-fg-dim">
            {t("No active hazards on this segment. ")}
          </p>
        ) : (
          <ul className="space-y-3">
            {segment.active_hazards.map((hazard) => {
              const config =
                HAZARD_CONFIG[hazard.hazard_type as HazardType] ??
                HAZARD_CONFIG.other;
              return (
                <li key={hazard.id} className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm"
                    style={{ backgroundColor: config.hex }}
                  >
                    {config.emoji}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-ink">
                      {config.label}
                      <span className="ml-2 text-[10px] uppercase tracking-wider text-fg-dim">
                        {hazard.severity}
                      </span>
                    </p>
                    {hazard.note && (
                      <p className="mt-0.5 text-xs text-fg-dim">
                        {hazard.note}
                      </p>
                    )}
                    <p className="mt-1 text-[11px] text-fg-dim">
                      {(hazard.reporter ?? "Unknown rider") +
                        " · " +
                        formatRelativeTime(hazard.created_at) +
                        " · " +
                        hazard.confirmations +
                        " confirmations"}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-line bg-cream p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-fg-dim">
              {t("Reviews and photos ")}
            </p>
            <p className="text-xs text-fg-dim">
              {segment.review_count === 1
                ? "1 public review"
                : `${segment.review_count} public reviews`}
            </p>
          </div>
          {segment.avg_review_rating != null && (
            <span className="inline-flex items-center gap-1 text-sm font-medium text-amber-300">
              <Star size={14} />
              {segment.avg_review_rating.toFixed(1)}
            </span>
          )}
        </div>
        <RoadReviewsPanel segmentId={segment.id} />
      </section>
    </div>
  );
}

const QUALITY_BREAKDOWN_ROWS = [
  { key: "excellent", label: "Excellent", bg: QUALITY_CONFIG.excellent.bg },
  { key: "good", label: "Good", bg: QUALITY_CONFIG.good.bg },
  { key: "fair", label: "Fair", bg: QUALITY_CONFIG.fair.bg },
  { key: "poor", label: "Poor", bg: QUALITY_CONFIG.poor.bg },
  {
    key: "very_poor",
    label: "Very poor",
    bg: QUALITY_CONFIG["very-poor"].bg,
  },
] as const;

function StatusBlock({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-6 text-sm text-ink">
      <div className="mt-0.5 text-accent">{icon}</div>
      <div>
        <p className="font-medium text-ink">{title}</p>
        <p className="mt-1 text-fg-dim">{body}</p>
      </div>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-cream p-3">
      <div className="mb-2 flex items-center gap-1.5 text-fg-dim">
        {icon}
        <p className="text-[10px] uppercase tracking-wider">{label}</p>
      </div>
      <p className="text-sm font-medium text-ink">{value}</p>
    </div>
  );
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-line-strong px-2 py-1 text-ink">
      {children}
    </span>
  );
}

function segmentTitle(segment: RoadSegmentDetailResponse): string {
  return segment.road_name ?? segment.road_number ?? `Segment ${segment.id}`;
}

function formatSurface(surface: string): string {
  return surface
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function trendPoints(points: RoadSegmentDetailResponse["quality_history"]) {
  return points.map(
    (point): QualityPoint => ({
      date: point.month,
      score: Number(point.score),
    }),
  );
}
