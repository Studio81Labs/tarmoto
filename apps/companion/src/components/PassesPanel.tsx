"use client";
import { t } from "@/i18n";
import { useMemo, useState } from "react";
import { Mountain, Route } from "lucide-react";
import { Select } from "@tarmoto/ui";
import { usePasses, type PassesQueryResult } from "@/hooks/usePasses";
import { ConditionStatusLine } from "@/components/ConditionStatusLine";
import { deriveConditionStatus } from "@/lib/conditions-status";
import {
  MONTH_NAMES,
  STATUS_DISPLAY_ORDER,
  countByStatus,
  currentUtcMonth,
  monthLabel,
  partitionByStatus,
  type MountainPass,
  type PassStatus,
} from "@/lib/passes-summary";
import type { PlannerClosureRoute } from "@/lib/closures-summary";
interface PassesPanelProps {
  month?: number;
  onMonthChange?: (month: number) => void;
  bbox?: string;
  routes?: PlannerClosureRoute[];
  showRouteWarnings?: boolean;
  data?: PassesQueryResult;
}
const EMPTY_ROUTES: PlannerClosureRoute[] = [];
const STATUS_DOT_CLASS: Record<PassStatus, string> = {
  open: "bg-[#1f8a5b]",
  closed: "bg-quality-q1",
  unknown: "bg-ink/40",
};
const STATUS_LABEL: Record<PassStatus, string> = {
  open: "Open",
  closed: "Closed",
  unknown: "Unknown",
};
const MAX_PASSES_PER_GROUP = 5;
/**
 * Seasonal passes panel for the trip planner sidebar (US-40).
 *
 * The planner map is still a placeholder (#79 will wire MapLibre); this
 * surfaces the backend's seasonal filter in its own section so riders can
 * already preview which passes are open/closed in a target month. Once the
 * map layer ships, the selector here drives the layer's status colouring.
 */
export function PassesPanel({
  month: controlledMonth,
  onMonthChange,
  bbox,
  routes = EMPTY_ROUTES,
  showRouteWarnings = true,
  data,
}: PassesPanelProps) {
  const [localMonth, setLocalMonth] = useState<number>(() => currentUtcMonth());
  const isControlled =
    controlledMonth !== undefined && onMonthChange !== undefined;
  const isReadOnlyControlled =
    controlledMonth !== undefined && onMonthChange === undefined;
  const month = isControlled
    ? controlledMonth
    : (controlledMonth ?? localMonth);
  const setMonth = (nextMonth: number) => {
    if (isControlled) onMonthChange(nextMonth);
    else setLocalMonth(nextMonth);
  };
  if (data) {
    return (
      <PassesPanelBody
        month={month}
        setMonth={setMonth}
        isReadOnlyControlled={isReadOnlyControlled}
        routes={routes}
        showRouteWarnings={showRouteWarnings}
        data={data}
      />
    );
  }
  return (
    <FetchedPassesPanel
      month={month}
      setMonth={setMonth}
      isReadOnlyControlled={isReadOnlyControlled}
      routes={routes}
      bbox={bbox}
      showRouteWarnings={showRouteWarnings}
    />
  );
}
function FetchedPassesPanel({
  month,
  setMonth,
  isReadOnlyControlled,
  routes,
  bbox,
  showRouteWarnings,
}: {
  month: number;
  setMonth: (nextMonth: number) => void;
  isReadOnlyControlled: boolean;
  routes: PlannerClosureRoute[];
  bbox?: string | undefined;
  showRouteWarnings: boolean;
}) {
  const data = usePasses(month, routes, bbox ? { bbox } : undefined);
  return (
    <PassesPanelBody
      month={month}
      setMonth={setMonth}
      isReadOnlyControlled={isReadOnlyControlled}
      routes={routes}
      showRouteWarnings={showRouteWarnings}
      data={data}
    />
  );
}
function PassesPanelBody({
  month,
  setMonth,
  isReadOnlyControlled,
  routes,
  showRouteWarnings,
  data,
}: {
  month: number;
  setMonth: (nextMonth: number) => void;
  isReadOnlyControlled: boolean;
  routes: PlannerClosureRoute[];
  showRouteWarnings: boolean;
  data: PassesQueryResult;
}) {
  const {
    passes,
    routePasses,
    routeClosedCount,
    routeUnknownCount,
    loading,
    routeLoading,
    error,
    routeError,
  } = data;
  const counts = useMemo(() => countByStatus(passes), [passes]);
  const groups = useMemo(() => partitionByStatus(passes), [passes]);
  const hasRouteWarnings = routeClosedCount > 0 || routeUnknownCount > 0;
  const routeSummary = buildRouteSummary(routeClosedCount, routeUnknownCount);
  // ONE data-state-aware status (revision 6): no pass data = UNKNOWN
  // (grey, like the legend), never a green all-clear.
  const status = deriveConditionStatus({
    sourceCount: counts.total,
    routeHitCount: routeClosedCount + routeUnknownCount,
  });
  const routeBoxVisible = showRouteWarnings && routes.length > 0;
  return (
    <div className="space-y-3 pt-2 border-t border-line">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
        <Mountain size={14} className="text-accent" />
        {t("Seasonal passes ")}
      </div>

      <div>
        <label
          htmlFor="passes-month"
          className="block text-xs text-fg-mute mb-1"
        >
          {t("Travel month ")}
        </label>
        <Select
          id="passes-month"
          value={month}
          onChange={(value) => setMonth(Number(value))}
          disabled={isReadOnlyControlled}
          tone="cream"
        >
          {MONTH_NAMES.map((name, idx) => (
            <option key={name} value={idx + 1}>
              {name}
            </option>
          ))}
        </Select>
      </div>

      <Legend />

      {showRouteWarnings && (
        <div className="space-y-2 rounded-xl border border-line bg-paper p-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-dim">
            <Route size={12} />
            {t("Route warnings ")}
          </div>

          {routes.length === 0 ? (
            <p className="text-xs text-fg-mute">
              {t(
                "Import or generate a route to check mountain pass crossings. ",
              )}
            </p>
          ) : routeLoading ? (
            <p className="text-xs text-fg-mute">
              {t("Checking route passes\u2026")}
            </p>
          ) : hasRouteWarnings ? (
            <>
              <p className="text-xs text-fg-dim">{routeSummary}</p>
              {routeError && (
                <p className="text-xs text-amber-600">{routeError}</p>
              )}
              <ul className="space-y-1.5">
                {routePasses
                  .filter((pass) => pass.status !== "open")
                  .slice(0, 3)
                  .map((pass) => (
                    <PassRow key={pass.id} pass={pass} />
                  ))}
              </ul>
            </>
          ) : routeError ? (
            <p className="text-xs text-quality-q1">{routeError}</p>
          ) : status === "no_data" ? (
            <ConditionStatusLine tone="no_data">
              {t("Pass data not available for this region yet. ")}
            </ConditionStatusLine>
          ) : (
            <ConditionStatusLine tone="clear">
              {t("No closed or unknown passes on your route. ")}
            </ConditionStatusLine>
          )}
        </div>
      )}

      {error ? (
        <p className="text-xs text-quality-q1">{error}</p>
      ) : loading ? (
        <p className="text-xs text-fg-mute">{t("Loading passes\u2026")}</p>
      ) : counts.total === 0 ? (
        // The route-warnings box already carries the no-data status when
        // visible — one status line per section (revision 6).
        routeBoxVisible ? null : (
          <ConditionStatusLine tone="no_data">
            {t("Pass data not available for this region yet. ")}
          </ConditionStatusLine>
        )
      ) : (
        <>
          <p className="text-xs text-fg-dim">
            {t("In ")}
            {monthLabel(month)}:{" "}
            <span className="text-quality-q1">
              {t("{count} closed", { count: counts.closed })}
            </span>
            {" • "}
            <span className="text-fg-dim">
              {t("{count} unknown", { count: counts.unknown })}
            </span>
            {" • "}
            <span className="text-[#1f8a5b]">
              {t("{count} open", { count: counts.open })}
            </span>
          </p>

          <ul className="space-y-1.5">
            {STATUS_DISPLAY_ORDER.flatMap((status) =>
              groups[status]
                .slice(0, MAX_PASSES_PER_GROUP)
                .map((p) => <PassRow key={p.id} pass={p} />),
            )}
          </ul>
        </>
      )}
    </div>
  );
}
function Legend() {
  return (
    <div
      role="list"
      aria-label={t("Pass status legend")}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-dim"
    >
      {STATUS_DISPLAY_ORDER.map((status) => (
        <span
          key={status}
          role="listitem"
          className="inline-flex items-center gap-1.5"
        >
          <span
            aria-hidden
            className={`inline-block w-2 h-2 rounded-full ${STATUS_DOT_CLASS[status]}`}
          />
          {STATUS_LABEL[status]}
        </span>
      ))}
    </div>
  );
}
function PassRow({ pass }: { pass: MountainPass }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      <span
        aria-hidden
        className={`mt-1 inline-block w-2 h-2 rounded-full shrink-0 ${STATUS_DOT_CLASS[pass.status]}`}
      />
      <span className="flex-1 min-w-0">
        <span className="text-ink truncate block">{pass.name}</span>
        <span className="text-fg-mute">
          {pass.elevation_m.toLocaleString()}
          {t("m ")}
          {pass.region ? ` · ${pass.region}` : ""}
        </span>
      </span>
    </li>
  );
}
function buildRouteSummary(closedCount: number, unknownCount: number): string {
  const parts: string[] = [];
  if (closedCount > 0) {
    parts.push(
      `${closedCount} closed ${closedCount === 1 ? "pass" : "passes"}`,
    );
  }
  if (unknownCount > 0) {
    parts.push(
      `${unknownCount} unknown ${unknownCount === 1 ? "pass" : "passes"}`,
    );
  }
  if (parts.length === 0) {
    return "No closed or unknown passes on your route.";
  }
  if (parts.length === 1) {
    return `Current trip crosses ${parts[0]}.`;
  }
  return `Current trip crosses ${parts[0]} and ${parts[1]}.`;
}
