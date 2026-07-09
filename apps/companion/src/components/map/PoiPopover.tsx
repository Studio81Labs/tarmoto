"use client";
import { t } from "@/i18n";
import { ExternalLink, Plus, X } from "lucide-react";
import { poiCategoryMeta } from "@/components/planner/MapToolbar";
import { PoiDetails } from "@/components/planner/PoiDetails";
import type { Poi } from "@/lib/planner/types";

/**
 * Route actions shown in the POI popover. All optional — omit them for an
 * info-only popover (the road explorer, and the read-only trip preview). The
 * planner passes either `onRemove` (when the POI is already placed) OR the
 * add/set handlers (when editable), never both.
 */
export interface PoiPopoverActions {
  /** "Remove from route" — shown when the POI is placed as a waypoint. */
  onRemove?: () => void;
  /** "Add as via". Its presence enables the editable action block. */
  onAddVia?: () => void;
  onSetStart?: () => void;
  onSetFinish?: () => void;
  /** "Add as stop" — shown only when provided (multi-day + stop category). */
  onAddStop?: () => void;
}

/**
 * Shared POI popover for any MapLibre map surface. A fixed-position card with
 * the category icon + name + close on one row, source attribution beneath, the
 * shared {@link PoiDetails} block, optional route actions, and a Google Maps
 * link. Used by the road explorer (info-only) and the trip planner (with
 * route-mutating actions).
 */
export function PoiPopover({
  poi,
  x,
  y,
  onClose,
  actions,
}: {
  poi: Poi;
  x: number;
  y: number;
  onClose: () => void;
  actions?: PoiPopoverActions;
}) {
  const meta = poiCategoryMeta(poi.category);
  const MetaIcon = meta.icon;
  const mapsUrl =
    typeof poi.meta?.mapsUrl === "string" ? poi.meta.mapsUrl : null;
  return (
    <div
      role="dialog"
      aria-label={t("POI details")}
      className="fixed z-30 w-64 overflow-hidden rounded-xl border border-line bg-cream p-2 shadow-[0_6px_20px_rgba(14,14,16,0.16)]"
      style={{ left: x, top: y }}
    >
      <div className="flex items-start gap-2.5 px-1.5 pb-2 pt-1">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-line bg-paper text-ink">
          <MetaIcon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          {/* Title + close on one row so the attribution beneath spans the
              full width instead of being narrowed by the close button. */}
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-[13px] font-bold text-ink">
              {poi.name}
            </p>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("Close POI details")}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line-strong text-fg-dim transition hover:border-ink hover:text-ink"
            >
              <X size={13} />
            </button>
          </div>
          <p className="font-mono text-[8.5px] font-bold uppercase tracking-[1.2px] text-fg-mute">
            {`${meta.label} · ${poi.source}`}
          </p>
          {poi.source === "osm" ? (
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 block font-mono text-[8px] uppercase tracking-[1px] text-fg-mute transition hover:text-ink"
            >
              © OpenStreetMap contributors
            </a>
          ) : poi.source === "fsq" ? (
            <a
              href="https://foursquare.com"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 block font-mono text-[8px] uppercase tracking-[1px] text-fg-mute transition hover:text-ink"
            >
              © Foursquare
            </a>
          ) : null}
        </div>
      </div>
      <PoiDetails poi={poi} />
      {actions?.onRemove ? (
        <button
          type="button"
          onClick={actions.onRemove}
          className="w-full rounded-[10px] border border-line-strong bg-cream px-3 py-2.5 text-[12.5px] font-bold text-quality-q1 transition hover:bg-paper"
        >
          {t("Remove from route")}
        </button>
      ) : actions?.onAddVia ? (
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
      ) : null}
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
    </div>
  );
}
