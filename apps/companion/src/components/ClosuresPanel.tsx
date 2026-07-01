"use client";
import { t } from "@/i18n";
import { useEffect } from "react";
import type { UnitSystem } from "@tarmoto/shared";
import { AlertTriangle, Route } from "lucide-react";
import { useClosures, type ClosuresQueryResult } from "@/hooks/useClosures";
import {
  detourLengthKm,
  formatClosureWindow,
  type PlannerClosure,
  type PlannerClosureRoute,
} from "@/lib/closures-summary";
import { monthLabel } from "@/lib/passes-summary";
import { formatDistance } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences";
const SEVERITY_CLASS: Record<PlannerClosure["severity"], string> = {
  full: "text-quality-q1",
  partial: "text-amber-600",
  advisory: "text-sky-700",
};
const SEVERITY_LABEL: Record<PlannerClosure["severity"], string> = {
  full: "Full closure",
  partial: "Partial closure",
  advisory: "Advisory",
};
const REASON_LABEL: Record<PlannerClosure["reason"], string> = {
  closure: "Closure",
  roadworks: "Roadworks",
  seasonal: "Seasonal",
  weather: "Weather",
  event: "Event",
  other: "Other",
};
interface ClosuresPanelProps {
  month: number;
  routes: PlannerClosureRoute[];
  bbox?: string | undefined;
  showRouteWarnings?: boolean;
  data?: ClosuresQueryResult;
  /**
   * Optional explicit preview date. When omitted the panel falls back
   * to the month-derived preview (the 15th of the chosen month) —
   * useful for trip planner where the rider picks a target month for
   * a multi-day plan. /explore passes a concrete date so the rider
   * can preview "what's closed tomorrow" / "next weekend".
   */
  previewDate?: Date | undefined;
}
export function ClosuresPanel({
  month,
  routes,
  bbox,
  showRouteWarnings = true,
  data,
  previewDate,
}: ClosuresPanelProps) {
  if (data) {
    return (
      <ClosuresPanelBody
        month={month}
        routes={routes}
        showRouteWarnings={showRouteWarnings}
        data={data}
      />
    );
  }
  return (
    <FetchedClosuresPanel
      month={month}
      routes={routes}
      bbox={bbox}
      showRouteWarnings={showRouteWarnings}
      previewDate={previewDate}
    />
  );
}
function FetchedClosuresPanel({
  month,
  routes,
  bbox,
  showRouteWarnings = true,
  previewDate,
}: Omit<ClosuresPanelProps, "data">) {
  const data = useClosures(
    month,
    routes,
    bbox || previewDate
      ? {
          ...(bbox ? { bbox } : {}),
          ...(previewDate ? { previewDate } : {}),
        }
      : undefined,
  );
  return (
    <ClosuresPanelBody
      month={month}
      routes={routes}
      showRouteWarnings={showRouteWarnings}
      data={data}
    />
  );
}
function ClosuresPanelBody({
  month,
  routes,
  showRouteWarnings,
  data,
}: {
  month: number;
  routes: PlannerClosureRoute[];
  showRouteWarnings: boolean;
  data: ClosuresQueryResult;
}) {
  const unitSystem = usePreferencesStore((s) => s.unitSystem);
  const hydratePreferences = usePreferencesStore((s) => s.hydrate);
  const {
    closures,
    routeClosures,
    counts,
    routeCounts,
    loading,
    routeLoading,
    error,
    routeError,
    previewDate,
  } = data;
  useEffect(() => {
    hydratePreferences();
  }, [hydratePreferences]);
  const monthText = monthLabel(month);
  const previewDay = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(previewDate);
  const hasRouteClosures = routeCounts.total > 0;
  const hasRouteFailure = Boolean(routeError);
  return (
    <div className="space-y-3 pt-2 border-t border-line">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
        <AlertTriangle size={14} className="text-accent" />
        {t("Closures & roadworks ")}
      </div>

      <p className="text-xs text-fg-mute">
        {t("Previewing {month} conditions on {previewDay}.", {
          month: monthText || "this month",
          previewDay,
        })}
      </p>

      {showRouteWarnings && (
        <div className="space-y-2 rounded-xl border border-line bg-paper p-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-dim">
            <Route size={12} />
            {t("Route warnings ")}
          </div>

          {routes.length === 0 ? (
            <p className="text-xs text-fg-mute">
              {t("Import or generate a route to check crossings. ")}
            </p>
          ) : routeLoading ? (
            <p className="text-xs text-fg-mute">
              {t("Checking route crossings\u2026")}
            </p>
          ) : hasRouteClosures ? (
            <>
              <p className="text-xs text-fg-dim">
                {t("Current trip crosses {count} active {closureLabel}.", {
                  count: routeCounts.total,
                  closureLabel:
                    routeCounts.total === 1 ? "closure" : "closures",
                })}
              </p>
              {hasRouteFailure && (
                <p className="text-xs text-amber-600">{routeError}</p>
              )}
              <ul className="space-y-2">
                {routeClosures.slice(0, 3).map((closure) => (
                  <ClosureRow
                    key={closure.id}
                    closure={closure}
                    compact
                    units={unitSystem}
                  />
                ))}
              </ul>
            </>
          ) : hasRouteFailure ? (
            <p className="text-xs text-quality-q1">{routeError}</p>
          ) : routeCounts.total === 0 ? (
            <p className="text-xs text-[#1f8a5b]">
              {t("No active closures intersect the current trip. ")}
            </p>
          ) : null}
        </div>
      )}

      {error ? (
        <p className="text-xs text-quality-q1">{error}</p>
      ) : loading ? (
        <p className="text-xs text-fg-mute">{t("Loading closures\u2026")}</p>
      ) : counts.total === 0 ? (
        <p className="text-xs text-fg-mute">
          {t("No active closures for this month yet. ")}
        </p>
      ) : (
        <>
          <p className="text-xs text-fg-dim">
            <span className="text-quality-q1">
              {t("{count} full", { count: counts.full })}
            </span>
            {" • "}
            <span className="text-amber-600">
              {t("{count} partial", { count: counts.partial })}
            </span>
            {" • "}
            <span className="text-sky-700">
              {t("{count} advisory", { count: counts.advisory })}
            </span>
          </p>

          <ul className="space-y-2">
            {closures.slice(0, 5).map((closure) => (
              <ClosureRow
                key={closure.id}
                closure={closure}
                units={unitSystem}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
function ClosureRow({
  closure,
  compact = false,
  units,
}: {
  closure: PlannerClosure;
  compact?: boolean;
  units: UnitSystem;
}) {
  const detourKm =
    closure.reason === "roadworks" ? detourLengthKm(closure) : null;
  return (
    <li className="rounded-xl border border-line bg-paper p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{closure.title}</p>
          <p className="text-xs text-fg-mute">
            {REASON_LABEL[closure.reason]}
            {closure.region ? ` · ${closure.region}` : ""}
          </p>
        </div>
        <span
          className={`shrink-0 text-[11px] font-medium ${SEVERITY_CLASS[closure.severity]}`}
        >
          {SEVERITY_LABEL[closure.severity]}
        </span>
      </div>

      <p className="mt-1 text-xs text-fg-dim">{formatClosureWindow(closure)}</p>

      {detourKm != null && (
        <p className="mt-2 text-xs text-sky-700">
          {t("Detour available \u00B7 approx. ")}
          {formatDistance(detourKm, units)}
        </p>
      )}

      {!compact && closure.notes && (
        <p className="mt-2 text-xs text-fg-dim">{closure.notes}</p>
      )}
    </li>
  );
}
