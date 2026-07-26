"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { ExternalLink, MapPin, Plus, TriangleAlert, X } from "lucide-react";
import {
  basemapPlaceCategoryDisplay,
  type BasemapPlace,
} from "@/lib/basemap-poi";
import { poiCategoryMeta } from "@/components/planner/MapToolbar";
import { PoiDetails } from "@/components/planner/PoiDetails";
import { HAZARD_CONFIG } from "@/lib/utils";
import {
  detourLengthKm,
  formatClosureWindow,
  type PlannerClosure,
} from "@/lib/closures-summary";
import type { MountainPass } from "@/lib/passes-summary";
import {
  CONDITION_COLORS,
  closureConditionKind,
  conditionKindIcon,
} from "@/lib/conditions-visual";
import type { Poi } from "@/lib/planner/types";
import { poiDisplayName, poiSourceDisplayName } from "@/lib/planner/labels";
import { formatRelativeTimeLabel, type HazardType } from "@tarmoto/shared";
import { useFormat } from "@/format/FormatProvider";
import {
  CLOSURE_REASON_LABELS,
  CLOSURE_SEVERITY_SHORT_LABELS,
  HAZARD_SEVERITY_LABELS,
  PASS_STATUS_LABELS,
  translateKnownLabel,
} from "@/i18n/domainLabels";

/** Legally required provider attributions are proper names, not UI copy. */
const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
const FOURSQUARE_ATTRIBUTION = "© Foursquare";

/** Hazard fields the popover renders (a subset of the hazard DTO). */
export interface HazardPoint {
  hazard_type: HazardType;
  severity: string;
  road_name?: string | null;
  note?: string | null;
  photo_url?: string | null;
  reporter?: string | null;
  created_at: string;
  confirmations: number;
}

/** The point a popover describes — one discriminated union across all pins. */
export type MapPoint =
  | { kind: "poi"; poi: Poi }
  | { kind: "hazard"; hazard: HazardPoint }
  | { kind: "closure"; closure: PlannerClosure; affectsRoute: boolean }
  | { kind: "pass"; pass: MountainPass; affectsRoute: boolean }
  // A basemap (OpenStreetMap) POI — name + category only, no curated detail.
  | { kind: "place"; place: BasemapPlace };

/** Route actions for a POI (planner, editable). Omit for info-only surfaces. */
export interface PoiPopoverActions {
  onRemove?: () => void;
  onAddVia?: () => void;
  onSetStart?: () => void;
  onSetFinish?: () => void;
  onAddStop?: () => void;
}

export interface MapPointActions {
  /** POI route actions (planner, editable). */
  poi?: PoiPopoverActions;
  /** "Reroute around it" for a route-affecting condition (planner, editable). */
  onReroute?: () => void;
}

const CARD_BASE =
  "fixed z-30 overflow-hidden rounded-xl border border-line bg-cream p-2 shadow-[0_6px_20px_rgba(14,14,16,0.16)]";

/**
 * The one popover for every map point — POIs, hazards, closures, passes — used
 * by the road explorer and the trip planner/preview. A shared card shell with a
 * per-kind body: category/emoji/diamond header (close on the title row), the
 * kind's detail, and a conditional action block (POI route actions, condition
 * reroute, or a Google Maps link — otherwise info only).
 */
export function MapPointPopover({
  point,
  x,
  y,
  onClose,
  actions,
}: {
  point: MapPoint;
  x: number;
  y: number;
  onClose: () => void;
  actions?: MapPointActions;
}) {
  const t = useTranslation();
  const wide = point.kind === "closure" || point.kind === "pass";
  return (
    <div
      role="dialog"
      aria-label={t("Map point details")}
      className={`${CARD_BASE} ${wide ? "w-72" : "w-64"}`}
      style={{ left: x, top: y }}
    >
      {point.kind === "poi" ? (
        <PoiBody
          poi={point.poi}
          onClose={onClose}
          {...(actions?.poi ? { actions: actions.poi } : {})}
        />
      ) : point.kind === "place" ? (
        <PlaceBody
          place={point.place}
          onClose={onClose}
          {...(actions?.poi ? { actions: actions.poi } : {})}
        />
      ) : point.kind === "hazard" ? (
        <HazardBody hazard={point.hazard} onClose={onClose} />
      ) : (
        <ConditionBody
          point={point}
          onClose={onClose}
          {...(actions?.onReroute ? { onReroute: actions.onReroute } : {})}
        />
      )}
    </div>
  );
}

/** Header row shared by every kind: leading badge + title + close button. */
function PopoverHeader({
  badge,
  title,
  subtitle,
  children,
  onClose,
}: {
  badge: React.ReactNode;
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
  onClose: () => void;
}) {
  const t = useTranslation();
  return (
    <div className="flex items-start gap-2.5 px-1.5 pb-2 pt-1">
      {badge}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-[13px] font-bold text-ink">
            {title}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Close details")}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line-strong text-fg-dim transition hover:border-ink hover:text-ink"
          >
            <X size={13} />
          </button>
        </div>
        {subtitle ? (
          <p className="font-mono text-[8.5px] font-bold uppercase tracking-[1.2px] text-fg-mute">
            {subtitle}
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}

// ── POI ──
function PoiBody({
  poi,
  onClose,
  actions,
}: {
  poi: Poi;
  onClose: () => void;
  actions?: PoiPopoverActions;
}) {
  const t = useTranslation();
  const meta = poiCategoryMeta(poi.category);
  const MetaIcon = meta.icon;
  const mapsUrl =
    typeof poi.meta?.mapsUrl === "string" ? poi.meta.mapsUrl : null;
  return (
    <>
      <PopoverHeader
        onClose={onClose}
        title={poiDisplayName(poi, t)}
        subtitle={t("{category} · {source}", {
          category: t(meta.label),
          source: poiSourceDisplayName(poi.source, t),
        })}
        badge={
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-line bg-paper text-ink">
            <MetaIcon size={16} />
          </span>
        }
      >
        {poi.source === "osm" ? (
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-0.5 block font-mono text-[8px] uppercase tracking-[1px] text-fg-mute transition hover:text-ink"
          >
            {OSM_ATTRIBUTION}
          </a>
        ) : poi.source === "fsq" ? (
          <a
            href="https://foursquare.com"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-0.5 block font-mono text-[8px] uppercase tracking-[1px] text-fg-mute transition hover:text-ink"
          >
            {FOURSQUARE_ATTRIBUTION}
          </a>
        ) : null}
      </PopoverHeader>
      <PoiDetails poi={poi} />
      <PlacementActions actions={actions} />
      {mapsUrl ? (
        <a
          href={mapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-line-strong bg-cream px-3 py-2 text-[12px] font-bold text-ink transition hover:bg-paper"
        >
          <ExternalLink size={13} strokeWidth={2.5} />
          {t("View on Google Maps")}
        </a>
      ) : null}
    </>
  );
}

/**
 * The route-placement action block shared by POI and basemap-place bodies:
 * Remove (a placed POI), or Add as via + Set start/finish (+ optional stop) on
 * the editable planner. Renders nothing on info-only surfaces.
 */
function PlacementActions({
  actions,
}: {
  actions: PoiPopoverActions | undefined;
}) {
  const t = useTranslation();
  if (actions?.onRemove) {
    return (
      <button
        type="button"
        onClick={actions.onRemove}
        className="w-full rounded-[10px] border border-line-strong bg-cream px-3 py-2.5 text-[12.5px] font-bold text-quality-q1 transition hover:bg-paper"
      >
        {t("Remove from route")}
      </button>
    );
  }
  if (!actions?.onAddVia) return null;
  return (
    <>
      <button
        type="button"
        onClick={actions.onAddVia}
        className="flex w-full items-center justify-center gap-1.5 rounded-[10px] bg-accent px-3 py-2.5 text-[13px] font-extrabold text-cream transition hover:brightness-95"
      >
        <Plus size={14} strokeWidth={3} />
        {t("Add as via")}
      </button>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={actions.onSetStart}
          className="rounded-[10px] border border-line-strong bg-cream px-2 py-2 text-[12px] font-bold text-ink transition hover:bg-paper"
        >
          {t("Set as start")}
        </button>
        <button
          type="button"
          onClick={actions.onSetFinish}
          className="rounded-[10px] border border-line-strong bg-cream px-2 py-2 text-[12px] font-bold text-ink transition hover:bg-paper"
        >
          {t("Set as finish")}
        </button>
      </div>
      {actions.onAddStop ? (
        <button
          type="button"
          onClick={actions.onAddStop}
          className="mt-1.5 w-full rounded-[10px] border border-line-strong bg-cream px-3 py-2 text-[12.5px] font-bold text-ink transition hover:bg-paper"
        >
          {t("Add as stop")}
        </button>
      ) : null}
    </>
  );
}

/**
 * A basemap (OpenStreetMap) POI: a light card — map-pin badge, name, category,
 * an OSM credit, the placement actions (editable planner), and a Google Maps
 * link. No curated detail, because the tile feature only carries name + class.
 */
function PlaceBody({
  place,
  onClose,
  actions,
}: {
  place: BasemapPlace;
  onClose: () => void;
  actions?: PoiPopoverActions;
}) {
  const t = useTranslation();
  // Unnamed POIs (a bare parking / bin icon) fall back to the category as the
  // title, so we don't repeat it as the subtitle. Every category is translated
  // via its catalog key; unknown OSM subclasses use the generic "Place" key.
  const categoryLabel = basemapPlaceCategoryDisplay(place, t);
  const title = place.name || categoryLabel;
  const subtitle = place.name ? categoryLabel : undefined;
  return (
    <>
      <PopoverHeader
        onClose={onClose}
        title={title}
        {...(subtitle ? { subtitle } : {})}
        badge={
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-line bg-paper text-ink">
            <MapPin size={16} />
          </span>
        }
      >
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-0.5 block font-mono text-[8px] uppercase tracking-[1px] text-fg-mute transition hover:text-ink"
        >
          {OSM_ATTRIBUTION}
        </a>
      </PopoverHeader>
      <PlacementActions actions={actions} />
      <a
        href={place.mapsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-line-strong bg-cream px-3 py-2 text-[12px] font-bold text-ink transition hover:bg-paper"
      >
        <ExternalLink size={13} strokeWidth={2.5} />
        {t("View on Google Maps")}
      </a>
    </>
  );
}

// ── Hazard ──
function severityBadgeClass(severity: string): string {
  if (severity === "high") return "bg-quality-q1/15 text-quality-q1";
  if (severity === "low") return "bg-quality-q5/20 text-quality-q5";
  return "bg-quality-q2/20 text-[#A9762A]";
}

function HazardBody({
  hazard,
  onClose,
}: {
  hazard: HazardPoint;
  onClose: () => void;
}) {
  const t = useTranslation();
  const format = useFormat();
  const cfg = HAZARD_CONFIG[hazard.hazard_type] ?? HAZARD_CONFIG.other;
  return (
    <>
      <PopoverHeader
        onClose={onClose}
        title={t(cfg.label)}
        {...(hazard.road_name ? { subtitle: hazard.road_name } : {})}
        badge={
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-line bg-paper text-[18px] leading-none">
            {cfg.emoji}
          </span>
        }
      >
        <span
          className={`mt-1 inline-block rounded-full px-2 py-0.5 font-mono text-[8.5px] font-bold uppercase tracking-[1.2px] ${severityBadgeClass(
            hazard.severity,
          )}`}
        >
          {translateKnownLabel(hazard.severity, HAZARD_SEVERITY_LABELS, t)}
        </span>
      </PopoverHeader>
      <div className="px-1.5 pb-2">
        {hazard.photo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={hazard.photo_url}
            alt={t("Hazard photo")}
            className="mb-2 block w-full rounded-[8px] bg-paper-2"
          />
        ) : null}
        {hazard.note ? (
          <p className="mb-2 rounded-[8px] bg-paper px-2 py-1.5 text-[12px] leading-snug text-ink">
            {hazard.note}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-2 text-[11px] text-fg-dim">
          <span className="truncate">
            {hazard.reporter ?? t("Unknown rider")} ·{" "}
            {formatRelativeTimeLabel(hazard.created_at, { format }, t)}
          </span>
          <span className="shrink-0">
            ✓ {format.integer(hazard.confirmations)}
          </span>
        </div>
      </div>
    </>
  );
}

// ── Closure / Pass ──
function ConditionBody({
  point,
  onClose,
  onReroute,
}: {
  point: Extract<MapPoint, { kind: "closure" | "pass" }>;
  onClose: () => void;
  onReroute?: () => void;
}) {
  const t = useTranslation();
  const format = useFormat();
  const isClosure = point.kind === "closure";
  const kind = isClosure ? closureConditionKind(point.closure) : "pass";
  const color = CONDITION_COLORS[kind];
  const BadgeIcon = conditionKindIcon(kind);
  const title = isClosure ? point.closure.title : point.pass.name;
  const subtitle = isClosure
    ? t("{reason} · {severity}", {
        reason: translateKnownLabel(
          point.closure.reason,
          CLOSURE_REASON_LABELS,
          t,
        ),
        severity: translateKnownLabel(
          point.closure.severity,
          CLOSURE_SEVERITY_SHORT_LABELS,
          t,
        ),
      })
    : t("{kind} · {status}", {
        kind: t("Seasonal pass"),
        status: translateKnownLabel(point.pass.status, PASS_STATUS_LABELS, t),
      });
  const detourKm =
    isClosure && point.closure.reason === "roadworks"
      ? detourLengthKm(point.closure)
      : null;
  return (
    <>
      <PopoverHeader
        onClose={onClose}
        title={title}
        subtitle={subtitle}
        badge={
          <span
            className="flex h-9 w-9 shrink-0 rotate-45 items-center justify-center rounded-[10px] border-2 bg-paper"
            style={{ borderColor: color }}
          >
            <BadgeIcon size={15} className="-rotate-45" style={{ color }} />
          </span>
        }
      />
      {point.affectsRoute ? (
        <p className="mx-1.5 mb-2 inline-flex items-center gap-1.5 rounded-[8px] border border-accent bg-accent/10 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[1.2px] text-accent">
          <TriangleAlert size={11} />
          {t("Affects your route")}
        </p>
      ) : null}
      <div className="px-1.5 pb-2 text-[11.5px] leading-snug text-fg-dim">
        {isClosure ? (
          <>
            <p className="font-mono text-[10px] uppercase tracking-[0.4px] text-fg-mute">
              {formatClosureWindow(point.closure, format, t)}
            </p>
            {point.closure.notes ? (
              <p className="mt-1">{point.closure.notes}</p>
            ) : null}
            {detourKm != null ? (
              <p className="mt-1.5 inline-flex rounded-[7px] border border-line-strong px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.4px] text-fg-dim">
                {t("Detour approx. {distance}", {
                  distance: format.distanceKm(detourKm),
                })}
              </p>
            ) : null}
          </>
        ) : (
          <p>
            {format.elevation(point.pass.elevation_m)}
            {point.pass.region ? ` · ${point.pass.region}` : ""}
          </p>
        )}
      </div>
      {point.affectsRoute && onReroute ? (
        <button
          type="button"
          onClick={onReroute}
          className="w-full rounded-[10px] bg-accent px-3 py-2.5 text-[13px] font-extrabold text-cream transition hover:brightness-95"
        >
          {t("Reroute around it")}
        </button>
      ) : null}
    </>
  );
}
