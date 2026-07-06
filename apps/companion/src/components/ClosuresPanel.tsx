"use client";
import { t } from "@/i18n";
import { useEffect } from "react";
import type { UnitSystem } from "@tarmoto/shared";
import { AlertTriangle, Loader2, Route } from "lucide-react";
import { useClosures, type ClosuresQueryResult } from "@/hooks/useClosures";
import { ConditionStatusLine } from "@/components/ConditionStatusLine";
import { deriveConditionStatus } from "@/lib/conditions-status";
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
  /**
   * Regional (non-route) closures list. The planner CONDITIONS tab
   * hides it (revision 7 — ambient awareness lives on the map now);
   * /explore keeps it as the regional discovery browser.
   */
  showRegionalList?: boolean | undefined;
  /** Fly to the closure's marker + open its popover (revision 7). */
  onFocusClosure?: ((closure: PlannerClosure) => void) | undefined;
  /** Insert a via around this on-route closure and re-route. */
  onRerouteClosure?: ((closure: PlannerClosure) => void) | undefined;
}
export function ClosuresPanel({
  month,
  routes,
  bbox,
  showRouteWarnings = true,
  data,
  previewDate,
  showRegionalList = true,
  onFocusClosure,
  onRerouteClosure,
}: ClosuresPanelProps) {
  if (data) {
    return (
      <ClosuresPanelBody
        month={month}
        routes={routes}
        showRouteWarnings={showRouteWarnings}
        data={data}
        showRegionalList={showRegionalList}
        onFocusClosure={onFocusClosure}
        onRerouteClosure={onRerouteClosure}
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
      showRegionalList={showRegionalList}
      onFocusClosure={onFocusClosure}
      onRerouteClosure={onRerouteClosure}
    />
  );
}
function FetchedClosuresPanel({
  month,
  routes,
  bbox,
  showRouteWarnings = true,
  previewDate,
  showRegionalList,
  onFocusClosure,
  onRerouteClosure,
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
      showRegionalList={showRegionalList}
      onFocusClosure={onFocusClosure}
      onRerouteClosure={onRerouteClosure}
    />
  );
}
function ClosuresPanelBody({
  month,
  routes,
  showRouteWarnings,
  data,
  showRegionalList = true,
  onFocusClosure,
  onRerouteClosure,
}: {
  month: number;
  routes: PlannerClosureRoute[];
  showRouteWarnings: boolean;
  data: ClosuresQueryResult;
  showRegionalList?: boolean | undefined;
  onFocusClosure?: ((closure: PlannerClosure) => void) | undefined;
  onRerouteClosure?: ((closure: PlannerClosure) => void) | undefined;
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
  // ONE data-state-aware status (revision 6): an empty source is
  // UNKNOWN, never a green all-clear — the clear state is earned only
  // when closure data exists and none of it crosses the route.
  const status = deriveConditionStatus({
    sourceCount: counts.total,
    routeHitCount: routeCounts.total,
  });
  const routeBoxVisible = showRouteWarnings && routes.length > 0;
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
            <p className="flex items-center gap-2 text-xs text-fg-mute">
              <Loader2
                size={12}
                aria-hidden
                className="shrink-0 animate-spin"
              />
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
                {routeClosures.slice(0, 5).map((closure) => (
                  <OnRouteClosureCard
                    key={closure.id}
                    closure={closure}
                    units={unitSystem}
                    onFocus={onFocusClosure}
                    onReroute={onRerouteClosure}
                  />
                ))}
              </ul>
            </>
          ) : hasRouteFailure ? (
            <p className="text-xs text-quality-q1">{routeError}</p>
          ) : status === "no_data" ? (
            <ConditionStatusLine tone="no_data">
              {t("Closure data not available for this region yet. ")}
            </ConditionStatusLine>
          ) : (
            <ConditionStatusLine tone="clear">
              {t("No active closures on your route. ")}
            </ConditionStatusLine>
          )}
        </div>
      )}

      {!showRegionalList ? null : error ? (
        <p className="text-xs text-quality-q1">{error}</p>
      ) : loading ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-line bg-paper p-3">
          <Loader2
            size={14}
            aria-hidden
            className="shrink-0 animate-spin text-fg-mute"
          />
          <p className="text-xs text-fg-dim">{t("Loading closures\u2026")}</p>
        </div>
      ) : counts.total === 0 ? (
        // The route-warnings box already carries the no-data status when
        // it's visible — never render two lines describing the same
        // empty state (revision 6).
        routeBoxVisible ? null : (
          <ConditionStatusLine tone="no_data">
            {t("Closure data not available for this region yet. ")}
          </ConditionStatusLine>
        )
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
/**
 * Full on-route card (revision 7): ON ROUTE badge, detail, REROUTE.
 * Clicking the card is the shared marker interaction — fly to the
 * closure and open its map popover.
 */
function OnRouteClosureCard({
  closure,
  units,
  onFocus,
  onReroute,
}: {
  closure: PlannerClosure;
  units: UnitSystem;
  onFocus?: ((closure: PlannerClosure) => void) | undefined;
  onReroute?: ((closure: PlannerClosure) => void) | undefined;
}) {
  const detourKm =
    closure.reason === "roadworks" ? detourLengthKm(closure) : null;
  return (
    <li className="rounded-xl border border-line bg-cream p-3">
      <button
        type="button"
        onClick={() => onFocus?.(closure)}
        className="block w-full text-left"
        title={t("Show on map")}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-medium text-ink">
              <span className="truncate">{closure.title}</span>
              <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[1px] text-cream">
                {t("On route")}
              </span>
            </p>
            <p className="text-xs text-fg-mute">
              {REASON_LABEL[closure.reason]}
              {closure.region ? ` \u00B7 ${closure.region}` : ""}
            </p>
          </div>
          <span
            className={`shrink-0 text-[11px] font-medium ${SEVERITY_CLASS[closure.severity]}`}
          >
            {SEVERITY_LABEL[closure.severity]}
          </span>
        </div>
        <p className="mt-1 text-xs text-fg-dim">
          {formatClosureWindow(closure)}
        </p>
        {closure.notes ? (
          <p className="mt-1 text-xs text-fg-dim">{closure.notes}</p>
        ) : null}
        {detourKm != null && (
          <p className="mt-2 inline-flex rounded-[7px] border border-line-strong px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.4px] text-fg-dim">
            {t("Detour ~")}
            {formatDistance(detourKm, units)}
          </p>
        )}
      </button>
      {onReroute ? (
        <button
          type="button"
          onClick={() => onReroute(closure)}
          className="mt-2.5 w-full rounded-[10px] border border-line-strong bg-cream px-3 py-2 text-[12px] font-extrabold uppercase tracking-[0.6px] text-ink transition hover:bg-paper"
        >
          {t("Reroute around it")}
        </button>
      ) : null}
    </li>
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
