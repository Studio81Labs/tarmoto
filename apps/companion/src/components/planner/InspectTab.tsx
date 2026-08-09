"use client";

import { useI18n } from "@/i18n/I18nProvider";
import {
  dayPlanBoundaryDisplayName,
  waypointDisplayName,
} from "@/lib/planner/labels";
import { useMemo } from "react";
import { Mono } from "@tarmoto/ui";
import { deriveFlaggedSections, surfaceMixToPercents } from "@/lib/planner/api";
import type {
  DayPlan,
  RouteQualitySummary,
  RouteSegment,
} from "@/lib/planner/types";
import { deriveDayQualitySegments } from "@/lib/trip-planner-map";
import { filterRoutingWaypoints } from "@/lib/trip-routing";
import type { TripDay, Waypoint } from "@/lib/types";
import { normalizeDayFinish } from "@/stores/trip";
import { useFormat } from "@/format/FormatProvider";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
import { FlaggedSectionCard } from "./FlaggedSectionCard";
import { SectionStamp } from "./PlannerPanel";
import { RouteQualityStrip } from "./RouteQualityStrip";
import { SurfaceMixBar } from "./SurfaceMixBar";
import { formatDisplayUpperCase } from "@tarmoto/shared";

/**
 * INSPECT tab — the hero of Plan & inspect: route summary (real routing
 * stats), the quality-along-route strip, the surface mix, and flagged
 * sections. Distance/time/score come from the backend routing response
 * stored on the day; per-segment quality is the mock join (see
 * lib/planner) until the quality pipeline serves it.
 */
interface InspectTabProps {
  day: TripDay | null;
  selectedSegmentId: string | null;
  /** Scope the readout to one DayPlan (selected in the day column). */
  plan?: DayPlan | null;
  /** Back to the whole-route readout. */
  onClearPlan?: () => void;
  /** Open a section's Road Preview + fly the map to it. */
  onInspectSegment: (segmentId: string) => void;
  /**
   * Insert an avoidance via around the section and re-route. Omit on
   * read-only surfaces (trip preview) — flagged cards then fall back to
   * the INSPECT action instead of offering REROUTE.
   */
  onRerouteSegment?: ((segmentId: string) => void) | undefined;
}

const ROLE_COLORS: Record<"start" | "via" | "finish", string> = {
  start: "#1F8A5B",
  via: "#1FA6B8",
  finish: "#FF6A1A",
};

function waypointRole(
  waypoint: Waypoint,
  index: number,
  count: number,
): "start" | "via" | "finish" {
  if (waypoint.type === "start" || index === 0) return "start";
  if (waypoint.type === "end" || index === count - 1) return "finish";
  return "via";
}

/**
 * Surface mix for the day: prefer the real routing response mix; fall back
 * to weighting the (mock) quality segments by length for loaded/imported
 * trips that never went through live routing.
 */
export function daySurfaceMix(
  day: TripDay,
  segments: readonly RouteSegment[],
): RouteQualitySummary["surfaceMix"] {
  if (day.surfaceMix && Object.keys(day.surfaceMix).length > 0) {
    return surfaceMixToPercents(day.surfaceMix);
  }
  const metresBySurface: Record<string, number> = {};
  for (const segment of segments) {
    metresBySurface[segment.surface] =
      (metresBySurface[segment.surface] ?? 0) + segment.lengthKm * 1000;
  }
  return surfaceMixToPercents(metresBySurface);
}

export function InspectTab({
  day,
  selectedSegmentId,
  plan = null,
  onClearPlan,
  onInspectSegment,
  onRerouteSegment,
}: InspectTabProps) {
  const { locale, t } = useI18n();
  const format = useFormat();
  const allSegments = useMemo(
    () => (day ? deriveDayQualitySegments(day) : []),
    [day],
  );
  // A selected DayPlan scopes the readout to its slice of the route.
  const segments = useMemo(
    () =>
      plan
        ? allSegments.filter((segment) => plan.segmentIds.includes(segment.id))
        : allSegments,
    [allSegments, plan],
  );
  // Gated here rather than at the two parents (planner + saved-trip detail) so
  // neither can be missed. Only the QUALITY sections go: distance, duration and
  // the surface mix are not road-quality data and belong to other features.
  const { enabled: qualityOverlayEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  const flagged = useMemo(() => deriveFlaggedSections(segments), [segments]);
  const surfaceMix = useMemo(
    () =>
      plan
        ? plan.quality.surfaceMix
        : day
          ? daySurfaceMix(day, allSegments)
          : [],
    [plan, day, allSegments],
  );
  const spine = useMemo(
    () =>
      day ? filterRoutingWaypoints(normalizeDayFinish(day.waypoints)) : [],
    [day],
  );

  if (!day || segments.length === 0) {
    return (
      <p className="text-[12px] leading-relaxed text-fg-dim">
        {t(
          "Build a route first — place a start and finish on the map (right-click) or generate a draft from the BUILD tab. Once a route exists you can inspect its road quality here.",
        )}
      </p>
    );
  }

  const startLabel = spine[0] ? waypointDisplayName(spine[0], t) : t("Start");
  const finish = spine[spine.length - 1];
  const finishLabel = finish ? waypointDisplayName(finish, t) : t("Finish");

  // Distance keeps its value and unit paired from the SAME `splitDistanceKm`
  // call — an imperial viewer must see "mi", never a converted mile figure
  // mislabelled "km". Falls back to the current unit system (not a
  // hardcoded "km") when there's no distance to show, so the empty-state
  // sublabel is still honest.
  const scopedDistanceKm = plan ? plan.distanceKm : day.distanceKm;
  const distanceSplit = scopedDistanceKm
    ? format.splitDistanceKm(scopedDistanceKm)
    : null;
  const distanceUnit =
    distanceSplit?.unit ?? (format.units === "imperial" ? "mi" : "km");
  const distanceUnitPosition = distanceSplit?.unitPosition ?? "after";
  const metrics = plan
    ? {
        distance: distanceSplit?.value ?? "—",
        time: plan.timeMin ? format.duration(plan.timeMin) : "—",
        score:
          plan.quality.score !== null
            ? format.decimal(plan.quality.score, 1)
            : "—",
      }
    : {
        distance: distanceSplit?.value ?? "—",
        time: day.durationMinutes ? format.duration(day.durationMinutes) : "—",
        score: day.avgQuality ? format.decimal(day.avgQuality, 1) : "—",
      };

  return (
    <div className="flex flex-col gap-6">
      {plan ? (
        <div className="flex items-center justify-between gap-2 rounded-[10px] border border-line bg-cream px-3 py-2">
          <span className="text-[12px] font-bold text-ink">
            {t("Inspecting Day {day} · {start} → {end}", {
              day: plan.dayNumber,
              start: dayPlanBoundaryDisplayName(
                plan.startTown,
                plan.startNameIsSource,
                plan.startPoiCategory,
                "start",
                t,
              ),
              end: dayPlanBoundaryDisplayName(
                plan.endTown,
                plan.endNameIsSource,
                plan.endPoiCategory,
                "end",
                t,
              ),
            })}
          </span>
          {onClearPlan ? (
            <button
              type="button"
              onClick={onClearPlan}
              className="font-mono text-[10px] font-bold tracking-[0.4px] text-fg-dim transition hover:text-ink"
            >
              {t("WHOLE ROUTE")}
            </button>
          ) : null}
        </div>
      ) : null}
      {/* route summary card */}
      <div className="overflow-hidden rounded-[14px] border border-line bg-cream">
        <div className="px-4 py-3.5">
          {spine.map((waypoint, index) => {
            const role = waypointRole(waypoint, index, spine.length);
            const roleLabel =
              role === "start"
                ? t("Start")
                : role === "finish"
                  ? t("Finish")
                  : t("Via");
            return (
              <div
                key={waypoint.id}
                className={`flex items-center gap-2.5 ${index < spine.length - 1 ? "mb-2" : ""}`}
              >
                <span
                  className="h-[9px] w-[9px] shrink-0 rounded-full"
                  style={{ background: ROLE_COLORS[role] }}
                />
                <Mono className="w-11 shrink-0 text-[9.5px] text-fg-mute">
                  {formatDisplayUpperCase(roleLabel, locale)}
                </Mono>
                <span className="truncate text-[13.5px] font-bold tracking-[-0.2px] text-ink">
                  {waypointDisplayName(waypoint, t)}
                </span>
              </div>
            );
          })}
        </div>
        <div className="flex border-t border-line">
          {(
            [
              {
                key: "distance",
                label: t("Distance"),
                value: metrics.distance,
                unit: distanceUnit,
                unitPosition: distanceUnitPosition,
                accent: false,
              },
              {
                key: "duration",
                label: t("Duration"),
                value: metrics.time,
                unit: "",
                unitPosition: "after",
                accent: false,
              },
              {
                key: "quality",
                label: t("Quality"),
                value: metrics.score,
                unit: t("/ {max}", { max: format.integer(5) }),
                unitPosition: "after",
                accent: true,
              },
            ] as const
          )
            .filter((stat) => stat.key !== "quality" || qualityOverlayEnabled)
            .map((stat, index) => (
              <div
                key={stat.key}
                className={`flex-1 px-3.5 py-3 ${index > 0 ? "border-l border-line" : ""}`}
              >
                <Mono className="text-[8.5px] tracking-[0.8px] text-fg-mute">
                  {formatDisplayUpperCase(stat.label, locale)}
                </Mono>
                <div className="mt-1 flex items-baseline gap-1">
                  {stat.unit && stat.unitPosition === "before" ? (
                    <span className="text-[10.5px] font-semibold text-fg-mute">
                      {stat.unit}
                    </span>
                  ) : null}
                  <span
                    className={`text-[19px] font-extrabold tracking-[-0.6px] ${
                      stat.accent ? "text-accent" : "text-ink"
                    }`}
                  >
                    {stat.value}
                  </span>
                  {stat.unit && stat.unitPosition === "after" ? (
                    <span className="text-[10.5px] font-semibold text-fg-mute">
                      {stat.unit}
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
        </div>
      </div>

      {/* quality along route */}
      {qualityOverlayEnabled && (
        <div>
          <SectionStamp n={1}>{t("Road quality along route")}</SectionStamp>
          <RouteQualityStrip
            segments={segments}
            startLabel={startLabel}
            endLabel={finishLabel}
            onSegmentClick={onInspectSegment}
          />
        </div>
      )}

      {/* surface mix */}
      <div>
        <SectionStamp n={2}>{t("Surface mix")}</SectionStamp>
        <SurfaceMixBar mix={surfaceMix} />
      </div>

      {/* flagged sections — derived from measured quality ("Fair or better"),
          so they go with it. */}
      {qualityOverlayEnabled && (
        <div>
          <SectionStamp n={3}>
            {t(
              "{count, plural, one {Flagged section · #} other {Flagged sections · #}}",
              { count: flagged.length },
            )}
          </SectionStamp>
          {flagged.length === 0 ? (
            <p className="text-[11.5px] leading-relaxed text-fg-mute">
              {t(
                "Nothing flagged — every section of this route is measured at Fair or better.",
              )}
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                {flagged.map((flag) => (
                  <FlaggedSectionCard
                    key={flag.segmentId}
                    flag={flag}
                    selected={selectedSegmentId === flag.segmentId}
                    onOpen={onInspectSegment}
                    onReroute={onRerouteSegment}
                  />
                ))}
              </div>
              <p className="mt-3 text-[11.5px] leading-relaxed text-fg-mute">
                {t(
                  "Tap a flagged section to preview the road before you commit — measured quality where we have it, street-level imagery where we don’t.",
                )}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
