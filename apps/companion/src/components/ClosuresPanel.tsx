"use client";
import { t } from "@/i18n";
import { useEffect } from "react";
import { AlertTriangle, Loader2, Route } from "lucide-react";
import { DatePicker } from "@tarmoto/ui";
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
import { useFormat } from "@/format/FormatProvider";
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
// Dot colours mirror the severity text classes + the counts line, so the
// legend, the count summary, and each row all read as one system (matches the
// Seasonal-passes panel's status dots).
// full is quality-q1 (#e05a3c, red-orange), so partial uses a clearly-yellow
// gold rather than amber-600 (dark orange) — the two dots were too close to
// tell apart. Red / yellow / blue now reads at a glance.
const SEVERITY_DOT_CLASS: Record<PlannerClosure["severity"], string> = {
  full: "bg-quality-q1",
  partial: "bg-amber-400",
  advisory: "bg-sky-700",
};
// Compact one-word labels for the legend (the row/tooltip use the full ones).
const SEVERITY_SHORT_LABEL: Record<PlannerClosure["severity"], string> = {
  full: "Full",
  partial: "Partial",
  advisory: "Advisory",
};
const SEVERITY_DISPLAY_ORDER: PlannerClosure["severity"][] = [
  "full",
  "partial",
  "advisory",
];

function toDateInputValue(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function parseDateInputValue(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, y, m, d] = match;
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), 12, 0, 0));
}
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
   * When supplied, the panel renders its own preview-date picker under the
   * heading (matching the Seasonal-passes month select) and calls this on
   * change. /explore passes it; the planner omits it (its closure date follows
   * the travel month), so the picker only appears where it's editable.
   */
  onPreviewDateChange?: ((date: Date) => void) | undefined;
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
  /**
   * Draws a `border-t` divider above the panel (default). /explore composites
   * this into a multi-block info column and places dividers between blocks
   * itself, so it passes `false` to drop the leading divider.
   */
  topDivider?: boolean;
}
export function ClosuresPanel({
  month,
  routes,
  bbox,
  showRouteWarnings = true,
  data,
  previewDate,
  onPreviewDateChange,
  showRegionalList = true,
  onFocusClosure,
  onRerouteClosure,
  topDivider = true,
}: ClosuresPanelProps) {
  if (data) {
    return (
      <ClosuresPanelBody
        month={month}
        routes={routes}
        showRouteWarnings={showRouteWarnings}
        data={data}
        onPreviewDateChange={onPreviewDateChange}
        showRegionalList={showRegionalList}
        onFocusClosure={onFocusClosure}
        onRerouteClosure={onRerouteClosure}
        topDivider={topDivider}
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
      onPreviewDateChange={onPreviewDateChange}
      showRegionalList={showRegionalList}
      onFocusClosure={onFocusClosure}
      onRerouteClosure={onRerouteClosure}
      topDivider={topDivider}
    />
  );
}
function FetchedClosuresPanel({
  month,
  routes,
  bbox,
  showRouteWarnings = true,
  previewDate,
  onPreviewDateChange,
  showRegionalList,
  onFocusClosure,
  onRerouteClosure,
  topDivider = true,
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
      topDivider={topDivider}
      onPreviewDateChange={onPreviewDateChange}
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
  onPreviewDateChange,
  showRegionalList = true,
  onFocusClosure,
  onRerouteClosure,
  topDivider = true,
}: {
  month: number;
  routes: PlannerClosureRoute[];
  showRouteWarnings: boolean;
  data: ClosuresQueryResult;
  onPreviewDateChange?: ((date: Date) => void) | undefined;
  showRegionalList?: boolean | undefined;
  onFocusClosure?: ((closure: PlannerClosure) => void) | undefined;
  onRerouteClosure?: ((closure: PlannerClosure) => void) | undefined;
  topDivider?: boolean;
}) {
  const format = useFormat();
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
  const previewDay = format.calendarDate(previewDate);
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
    <div
      className={
        topDivider ? "space-y-3 border-t border-line pt-2" : "space-y-3"
      }
    >
      <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
        <AlertTriangle size={14} className="text-accent" />
        {t("Closures & roadworks ")}
      </div>

      {onPreviewDateChange ? (
        <DatePicker
          id="closures-preview-date"
          label={t("Preview date ")}
          value={toDateInputValue(previewDate)}
          onChange={(value) => {
            const next = parseDateInputValue(value);
            if (next) onPreviewDateChange(next);
          }}
          tone="cream"
        />
      ) : (
        <p className="text-xs text-fg-mute">
          {t("Previewing {month} conditions on {previewDay}.", {
            month: monthText || "this month",
            previewDay,
          })}
        </p>
      )}

      <ClosuresLegend />

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
                {t(
                  "Current trip crosses {count, plural, one {# active closure} other {# active closures}}.",
                  { count: routeCounts.total },
                )}
              </p>
              {hasRouteFailure && (
                <p className="text-xs text-amber-600">{routeError}</p>
              )}
              <ul className="space-y-2">
                {routeClosures.slice(0, 5).map((closure) => (
                  <OnRouteClosureCard
                    key={closure.id}
                    closure={closure}
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
                onFocus={onFocusClosure}
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
  onFocus,
  onReroute,
}: {
  closure: PlannerClosure;
  onFocus?: ((closure: PlannerClosure) => void) | undefined;
  onReroute?: ((closure: PlannerClosure) => void) | undefined;
}) {
  const format = useFormat();
  const detourKm =
    closure.reason === "roadworks" ? detourLengthKm(closure) : null;
  return (
    <li className="rounded-xl border border-line bg-cream p-3">
      <button
        type="button"
        onClick={() => onFocus?.(closure)}
        className="block w-full cursor-pointer text-left"
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
          {formatClosureWindow(closure, format)}
        </p>
        {closure.notes ? (
          <p className="mt-1 text-xs text-fg-dim">{closure.notes}</p>
        ) : null}
        {detourKm != null && (
          <p className="mt-2 inline-flex rounded-[7px] border border-line-strong px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.4px] text-fg-dim">
            {t("Detour ~")}
            {format.distanceKm(detourKm)}
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

function ClosuresLegend() {
  return (
    <div
      role="list"
      aria-label={t("Closure severity legend")}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-dim"
    >
      {SEVERITY_DISPLAY_ORDER.map((severity) => (
        <span
          key={severity}
          role="listitem"
          className="inline-flex items-center gap-1.5"
        >
          <span
            aria-hidden
            className={`inline-block h-2 w-2 rounded-full ${SEVERITY_DOT_CLASS[severity]}`}
          />
          {SEVERITY_SHORT_LABEL[severity]}
        </span>
      ))}
    </div>
  );
}
function ClosureRow({
  closure,
  compact = false,
  onFocus,
}: {
  closure: PlannerClosure;
  compact?: boolean;
  onFocus?: ((closure: PlannerClosure) => void) | undefined;
}) {
  const format = useFormat();
  const detourKm =
    closure.reason === "roadworks" ? detourLengthKm(closure) : null;
  const body = (
    <>
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          title={SEVERITY_LABEL[closure.severity]}
          className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT_CLASS[closure.severity]}`}
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">
            {closure.title}
          </p>
          <p className="text-xs text-fg-mute">
            {REASON_LABEL[closure.reason]}
            {closure.region ? ` · ${closure.region}` : ""}
          </p>
          {/* The severity dot above is decorative (aria-hidden); carry the
              label for screen readers + non-hover devices, since colour and a
              hover tooltip alone don't convey it. */}
          <span className="sr-only">{SEVERITY_LABEL[closure.severity]}</span>
        </div>
      </div>

      <p className="mt-1 text-xs text-fg-dim">
        {formatClosureWindow(closure, format)}
      </p>

      {detourKm != null && (
        <p className="mt-2 text-xs text-sky-700">
          {t("Detour available \u00B7 approx. ")}
          {format.distanceKm(detourKm)}
        </p>
      )}

      {!compact && closure.notes && (
        <p className="mt-2 text-xs text-fg-dim">{closure.notes}</p>
      )}
    </>
  );
  // When a focus handler is supplied (the /explore Conditions list), the whole
  // row is a button that flies the map to the marker + opens its popover.
  return (
    <li className="rounded-xl border border-line bg-paper p-3">
      {onFocus ? (
        <button
          type="button"
          onClick={() => onFocus(closure)}
          className="block w-full cursor-pointer text-left"
          title={t("Show on map")}
        >
          {body}
        </button>
      ) : (
        body
      )}
    </li>
  );
}
