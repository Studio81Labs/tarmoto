"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
import type { Translate } from "@/i18n";

import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  Clock,
  Gauge,
  Loader2,
  Users,
  X,
} from "lucide-react";
import { Mono, Stamp } from "@tarmoto/ui";
import { SegmentTrendChart } from "@/components/SegmentTrendChart";
import { RoadReviewsPanel } from "@/components/RoadReviewsPanel";
import type { RoadSegmentDetailResponse } from "@/lib/api";
import type { HazardType, QualityTier } from "@/lib/types";
import type { QualityPoint } from "@/lib/segment-trend";
import {
  HAZARD_CONFIG,
  QUALITY_CONFIG,
  qualityProvenanceLabel,
  scoreToTier,
  surfaceTypeLabel,
} from "@/lib/utils";
import { useFormat } from "@/format/FormatProvider";
import { usePreferencesStore } from "@/stores/preferences";
import {
  HAZARD_SEVERITY_LABELS,
  translateKnownLabel,
} from "@/i18n/domainLabels";
import { formatRelativeTimeLabel } from "@tarmoto/shared";
import { LocalizedStyledValue } from "@/i18n/LocalizedStyledValue";

export type SegmentDetailPanelState =
  | { status: "idle" }
  | { status: "loading"; segmentId: string }
  | { status: "ready"; segment: RoadSegmentDetailResponse }
  | { status: "not-found"; segmentId: string }
  | { status: "error"; segmentId: string; message: string };

interface SegmentDetailSidebarProps {
  state: SegmentDetailPanelState;
  onClose: () => void;
  /**
   * Where the panel anchors:
   *  - "container" (default): `absolute`, filling the nearest positioned
   *    ancestor — right for /explore, whose map is the full-bleed container.
   *  - "viewport": `fixed` to the browser's right edge at full window height —
   *    for the planner, whose map is only the centre column, so an absolute
   *    panel would stop at the side panel instead of the window edge.
   */
  anchor?: "container" | "viewport";
}

export function HazardSeverityLabel({
  hazard,
  severity,
  t,
}: {
  hazard: string;
  severity: string;
  t: Translate;
}) {
  return (
    <LocalizedStyledValue
      t={t}
      messageKey="{hazard} {severity}"
      values={{ hazard }}
      valueName="severity"
      formattedValue={severity}
      className="text-[10px] uppercase tracking-wider text-fg-dim"
    />
  );
}

export function SegmentDetailSidebar({
  state,
  onClose,
  anchor = "container",
}: SegmentDetailSidebarProps) {
  const t = useTranslation();
  const open = state.status !== "idle";
  // Slide in on open and back out on close (up/down from the bottom on mobile,
  // in/out from the right on desktop). `entered` drives the transform; rAF so
  // the off-screen transform paints before the transition starts. `snapshot`
  // freezes the last non-idle state so the drawer keeps rendering its content
  // while it animates out, after `state` has already returned to idle; it stays
  // mounted until the slide-out transition ends.
  const [entered, setEntered] = useState(false);
  const [mounted, setMounted] = useState(open);
  const [snapshot, setSnapshot] = useState<SegmentDetailPanelState>(state);
  useEffect(() => {
    if (open) {
      setSnapshot(state);
      setMounted(true);
    }
  }, [state, open]);
  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  if (!mounted || snapshot.status === "idle") return null;

  return (
    <aside
      role="dialog"
      aria-label={t("Road segment details")}
      onTransitionEnd={(e) => {
        // Unmount only once the slide-out (the transform) has finished, and
        // ignore transitions bubbling up from children (e.g. hover states).
        if (
          !open &&
          e.target === e.currentTarget &&
          e.propertyName === "transform"
        ) {
          setMounted(false);
        }
      }}
      className={`${
        anchor === "viewport" ? "fixed z-50" : "absolute z-20"
      } inset-x-0 bottom-0 flex max-h-[85%] flex-col border-t border-line bg-cream shadow-2xl transition-transform duration-200 ease-out md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[430px] md:border-l md:border-t-0 ${
        entered
          ? "translate-y-0 md:translate-x-0"
          : "translate-y-full md:translate-y-0 md:translate-x-full"
      }`}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 pb-3.5 pt-[18px]">
        <Stamp>{t("Road segment")}</Stamp>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("Close segment details")}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line-strong text-fg-dim transition hover:border-ink hover:text-ink"
        >
          <X size={15} />
        </button>
      </div>

      {snapshot.status === "loading" && (
        <StatusBlock
          icon={<Loader2 size={18} className="animate-spin" />}
          title={t("Loading road details")}
          body={t("Fetching the latest segment quality and community data.")}
        />
      )}

      {snapshot.status === "not-found" && (
        <StatusBlock
          icon={<AlertTriangle size={18} />}
          title={t("Road segment not found")}
          body={t(
            "This segment may have been merged, removed, or not synced from the tile source yet.",
          )}
        />
      )}

      {snapshot.status === "error" && (
        <StatusBlock
          icon={<AlertTriangle size={18} />}
          title={t("Could not load road details")}
          body={snapshot.message}
        />
      )}

      {snapshot.status === "ready" && (
        // Key by id so the per-segment local state (e.g. the live review count)
        // re-initialises when the viewer switches to a different segment.
        <SegmentDetailContent
          key={snapshot.segment.id}
          segment={snapshot.segment}
        />
      )}
    </aside>
  );
}

function SegmentDetailContent({
  segment,
}: {
  segment: RoadSegmentDetailResponse;
}) {
  const t = useTranslation();
  const format = useFormat();
  const { enabled: hazardAlertsEnabled } =
    useFeatureKillSwitch("hazard_alerts");
  const hydratePreferences = usePreferencesStore((s) => s.hydrate);
  const score = segment.quality_score ?? 0;
  const currentTier: QualityTier | null = score > 0 ? scoreToTier(score) : null;
  const tier = currentTier ? QUALITY_CONFIG[currentTier] : null;
  // Non-null only while quality is still purely OSM-seeded (no rider reports yet);
  // coheres with the backend `quality_score` shown alongside it.
  const provenance = qualityProvenanceLabel(
    segment.quality_source ?? null,
    segment.reading_count ?? 0,
  );
  const passLabel = t("{count, plural, one {pass} other {passes}}", {
    count: segment.reading_count ?? 0,
  });
  const qualityHistory = trendPoints(segment.quality_history);
  const regionalHistory = trendPoints(segment.regional_quality_history);
  const hasTrend = qualityHistory.length > 1;
  // Track the count locally so it reflects the viewer's own create/delete,
  // which RoadReviewsPanel applies to its own state below.
  const [reviewCount, setReviewCount] = useState(segment.review_count);
  const confidence = clampPercent(segment.confidence);

  useEffect(() => {
    hydratePreferences();
  }, [hydratePreferences]);

  return (
    <div className="flex flex-col gap-[18px] overflow-y-auto p-5 text-sm text-ink">
      {/* Identity */}
      <div className="flex items-center gap-3.5">
        <div
          className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-xl text-[22px] font-extrabold tracking-[-0.5px] text-ink ${
            tier?.bg ?? "bg-paper"
          }`}
        >
          {segment.quality_score == null ? "N/A" : format.decimal(score, 1)}
        </div>
        <div className="min-w-0">
          <div className="truncate font-sans text-[20px] font-extrabold leading-[1.1] tracking-[-0.5px] text-ink">
            {segmentTitle(segment, t)}
          </div>
          <Mono className="mt-1 block text-[11px] text-fg-mute">
            {segment.road_number ? `${segment.road_number} · ` : ""}
            {format.distanceM(segment.length_m)}
          </Mono>
          <div className="mt-[9px] flex flex-wrap gap-1.5">
            <Pill>{tier ? t(tier.label) : t("Unrated")}</Pill>
            <Pill>{t(surfaceTypeLabel(segment.surface_type))}</Pill>
          </div>
          {provenance ? (
            <div className="mt-2 text-[11px] italic text-fg-mute">
              {t(provenance)}
            </div>
          ) : null}
        </div>
      </div>

      {/* Metric grid */}
      <div className="grid grid-cols-2 gap-2.5">
        <Metric
          icon={<Gauge size={14} />}
          label={t("Confidence")}
          value={format.percent(confidence / 100)}
          caption={confidenceCaption(confidence, t)}
        />
        <Metric
          icon={<Activity size={14} />}
          label={t("Rider passes")}
          value={format.integer(segment.reading_count)}
          caption={passLabel}
        />
        <Metric
          icon={<Users size={14} />}
          label={t("Recent riders")}
          value={format.integer(segment.riders_per_month)}
          caption={t("per month")}
        />
        <Metric
          icon={<Clock size={14} />}
          label={t("Last updated")}
          value={format.date(segment.last_updated)}
        />
      </div>

      {/* Confidence bar */}
      <div>
        <div className="mb-[7px] flex items-baseline justify-between gap-3">
          <Stamp>{t("Confidence")}</Stamp>
          <Mono className="text-[11px] text-fg-dim">
            {format.percent(confidence / 100)} ·{" "}
            {format.integer(segment.reading_count)} {passLabel}
          </Mono>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-paper-2">
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${confidence}%` }}
          />
        </div>
      </div>

      <Divider />

      {/* Quality mix */}
      <div>
        <Stamp className="mb-3 block">{t("Quality mix")}</Stamp>
        <div className="flex flex-col gap-2.5">
          {QUALITY_BREAKDOWN_ROWS.map((row) => {
            const pct = clampPercent(segment.quality_breakdown[row.key]);
            const active = row.tier === currentTier;
            return (
              <div key={row.key} className="flex items-center gap-3">
                <div className="flex w-[92px] shrink-0 items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`h-[9px] w-[9px] rounded-full ${row.bg}`}
                  />
                  <span
                    className={`text-[12.5px] font-semibold ${
                      active ? "text-ink" : "text-fg-mute"
                    }`}
                  >
                    {t(row.label)}
                  </span>
                </div>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-paper-2">
                  <div
                    className={`h-full rounded-full ${row.bg}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <Mono
                  className={`w-[34px] text-right text-[11px] font-semibold ${
                    active ? "text-fg-dim" : "text-fg-mute"
                  }`}
                >
                  {format.percent(pct / 100)}
                </Mono>
              </div>
            );
          })}
        </div>
      </div>

      {hasTrend && (
        <>
          <Divider />
          {/* Quality trend (US-45) */}
          <div>
            <Stamp className="mb-3 block">{t("Quality trend")}</Stamp>
            <SegmentTrendChart
              segmentId={segment.id}
              history={qualityHistory}
              regionalHistory={regionalHistory}
            />
          </div>
        </>
      )}

      {/* Active hazards. A SECOND reception path for hazard data, independent of
          the map overlay: the segment-detail response carries notes, photos,
          reporter names and timestamps, so an operator kill has to reach here
          too or the overlay goes dark while the sidebar keeps serving the same
          rider-submitted content. The count goes with it — "3 active hazards"
          is hazard intelligence even with the list collapsed. */}
      {hazardAlertsEnabled && (
        <>
          <Divider />

          <div>
            <div className="flex items-center justify-between gap-3">
              <Stamp>{t("Active hazards")}</Stamp>
              <Mono className="text-[13px] font-bold text-fg-mute">
                {format.integer(segment.active_hazard_count)}
              </Mono>
            </div>
            {segment.active_hazards.length === 0 ? (
              <p className="mt-2 text-[12.5px] text-fg-dim">
                {t("No active hazards on this segment.")}
              </p>
            ) : (
              <ul className="mt-3 space-y-3">
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
                          <HazardSeverityLabel
                            hazard={t(config.label)}
                            severity={translateKnownLabel(
                              hazard.severity,
                              HAZARD_SEVERITY_LABELS,
                              t,
                            )}
                            t={t}
                          />
                        </p>
                        {hazard.note && (
                          <p className="mt-0.5 text-xs text-fg-dim">
                            {hazard.note}
                          </p>
                        )}
                        <p className="mt-1 text-[11px] text-fg-dim">
                          {t(
                            "{reporter} · {time} · {count, plural, one {# confirmation} other {# confirmations}}",
                            {
                              reporter: hazard.reporter ?? t("Unknown rider"),
                              time: formatRelativeTimeLabel(
                                hazard.created_at,
                                { format },
                                t,
                              ),
                              count: hazard.confirmations,
                            },
                          )}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      <Divider />

      {/* Reviews & photos */}
      <div>
        <div className="flex items-center justify-between gap-3">
          <Stamp>{t("Reviews & photos")}</Stamp>
          <Mono className="text-[11px] text-fg-mute">
            {t("{count, plural, one {# review} other {# reviews}}", {
              count: reviewCount,
            })}
          </Mono>
        </div>
        <div className="mt-3.5">
          <RoadReviewsPanel
            segmentId={segment.id}
            hideHeader
            onCountChange={setReviewCount}
          />
        </div>
      </div>
    </div>
  );
}

const QUALITY_BREAKDOWN_ROWS = [
  {
    key: "excellent",
    label: "Excellent",
    tier: "excellent",
    bg: QUALITY_CONFIG.excellent.bg,
  },
  { key: "good", label: "Good", tier: "good", bg: QUALITY_CONFIG.good.bg },
  { key: "fair", label: "Fair", tier: "fair", bg: QUALITY_CONFIG.fair.bg },
  { key: "poor", label: "Poor", tier: "poor", bg: QUALITY_CONFIG.poor.bg },
  {
    key: "very_poor",
    label: "Very poor",
    tier: "very-poor",
    bg: QUALITY_CONFIG["very-poor"].bg,
  },
] as const;

function Divider() {
  return <div aria-hidden="true" className="h-px w-full bg-line" />;
}

/** Short qualitative caption for the confidence metric tile. */
function confidenceCaption(confidence: number, t: Translate): string {
  if (confidence < 40) return t("Needs more passes");
  if (confidence < 75) return t("Building confidence");
  return t("Well established");
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

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
    <div className="flex items-start gap-3 px-5 py-6 text-sm text-ink">
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
  caption,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  caption?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-paper px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-fg-mute">
        {icon}
        <Stamp className="text-[10px] text-fg-mute">{label}</Stamp>
      </div>
      <div className="mt-[7px] text-[19px] font-extrabold tracking-[-0.4px] text-ink">
        {value}
      </div>
      {caption && (
        <div className="mt-px text-[11px] text-fg-mute">{caption}</div>
      )}
    </div>
  );
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-line-strong px-2.5 py-[5px] text-[11px] font-bold text-fg-dim">
      {children}
    </span>
  );
}

function segmentTitle(
  segment: RoadSegmentDetailResponse,
  t: Translate,
): string {
  return (
    segment.road_name ??
    segment.road_number ??
    t("Segment {id}", { id: segment.id })
  );
}

function trendPoints(points: RoadSegmentDetailResponse["quality_history"]) {
  return points.map(
    (point): QualityPoint => ({
      date: point.month,
      score: Number(point.score),
    }),
  );
}
