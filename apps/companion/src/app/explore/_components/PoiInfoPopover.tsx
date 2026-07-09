"use client";
import { t } from "@/i18n";
import { ExternalLink, X } from "lucide-react";
import { poiCategoryMeta } from "@/components/planner/MapToolbar";
import { PoiDetails } from "@/components/planner/PoiDetails";
import type { Poi } from "@/lib/planner/types";

/**
 * Info-only POI popover for the road explorer: header (category icon + name +
 * source attribution), the shared {@link PoiDetails} decision-support block, and
 * a "View on Google Maps" link. Unlike the planner's popover there are no
 * route-mutating actions (add as via/stop, set start/finish) — the explorer has
 * no route. Positioned `fixed` at the pin's viewport coordinates.
 */
export function PoiInfoPopover({
  poi,
  x,
  y,
  onClose,
}: {
  poi: Poi;
  x: number;
  y: number;
  onClose: () => void;
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
          <p className="truncate text-[13px] font-bold text-ink">{poi.name}</p>
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
        <button
          type="button"
          onClick={onClose}
          aria-label={t("Close POI details")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line-strong text-fg-dim transition hover:border-ink hover:text-ink"
        >
          <X size={13} />
        </button>
      </div>
      <PoiDetails poi={poi} />
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
