"use client";

import { useEffect } from "react";
import type { UnitSystem } from "@tarmoto/shared";
import { AlertTriangle, Route } from "lucide-react";
import { useClosures } from "@/hooks/useClosures";
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
  full: "text-rose-400",
  partial: "text-amber-300",
  advisory: "text-sky-300",
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
}

export function ClosuresPanel({ month, routes }: ClosuresPanelProps) {
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
  } = useClosures(month, routes);

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
    <div className="space-y-3 pt-2 border-t border-slate-800">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-300">
        <AlertTriangle size={14} className="text-slate-500" />
        Closures & roadworks
      </div>

      <p className="text-xs text-slate-500">
        Previewing {monthText || "this month"} conditions on {previewDay}.
      </p>

      <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/70 p-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
          <Route size={12} />
          Route warnings
        </div>

        {routes.length === 0 ? (
          <p className="text-xs text-slate-500">
            Import or generate a route to check crossings.
          </p>
        ) : routeLoading ? (
          <p className="text-xs text-slate-500">Checking route crossings…</p>
        ) : hasRouteClosures ? (
          <>
            <p className="text-xs text-slate-300">
              Current trip crosses {routeCounts.total} active{" "}
              {routeCounts.total === 1 ? "closure" : "closures"}.
            </p>
            {hasRouteFailure && (
              <p className="text-xs text-amber-300">{routeError}</p>
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
          <p className="text-xs text-rose-400">{routeError}</p>
        ) : routeCounts.total === 0 ? (
          <p className="text-xs text-emerald-400">
            No active closures intersect the current trip.
          </p>
        ) : null}
      </div>

      {error ? (
        <p className="text-xs text-rose-400">{error}</p>
      ) : loading ? (
        <p className="text-xs text-slate-500">Loading closures…</p>
      ) : counts.total === 0 ? (
        <p className="text-xs text-slate-500">
          No active closures for this month yet.
        </p>
      ) : (
        <>
          <p className="text-xs text-slate-400">
            <span className="text-rose-400">{counts.full} full</span>
            {" • "}
            <span className="text-amber-300">{counts.partial} partial</span>
            {" • "}
            <span className="text-sky-300">{counts.advisory} advisory</span>
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
    <li className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-100">{closure.title}</p>
          <p className="text-xs text-slate-500">
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

      <p className="mt-1 text-xs text-slate-400">
        {formatClosureWindow(closure)}
      </p>

      {detourKm != null && (
        <p className="mt-2 text-xs text-cyan-300">
          Detour available · approx. {formatDistance(detourKm, units)}
        </p>
      )}

      {!compact && closure.notes && (
        <p className="mt-2 text-xs text-slate-400">{closure.notes}</p>
      )}
    </li>
  );
}
