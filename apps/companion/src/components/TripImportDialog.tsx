"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileUp, Loader2, MapPin, X } from "lucide-react";
import { Button } from "@tarmoto/ui";
import {
  importErrorMessage,
  importedRouteToTrip,
  parseImportedRoute,
  type ImportedRoute,
} from "@/lib/gpx-kml-import";
import { QUALITY_CONFIG } from "@/lib/utils";
import { useTripStore } from "@/stores/trip";
import { flattenSegments } from "@/stores/trip";
import { useFormat } from "@/format/FormatProvider";
import type { Trip } from "@/lib/types";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
interface TripImportDialogProps {
  open: boolean;
  initialFile?: File | null;
  onClose: () => void;
}
/**
 * Dialog shown after a GPX/KML file is dropped or picked (US-38).
 * Owns the parse → preview → adopt lifecycle and calls `setActiveTrip` so the
 * planner sidebar and timeline light up with the imported route.
 */
export function TripImportDialog({
  open,
  initialFile,
  onClose,
}: TripImportDialogProps) {
  const t = useTranslation();
  // Operator kill switch, inside the dialog so any future entry point is covered
  // by the same gate. Rendering nothing rather than an explanation card: this is
  // a modal the rider opened deliberately, and a dialog whose only content is
  // "unavailable" is worse than the dialog not opening — the caller's own
  // affordance is where an explanation belongs, if one is ever needed.
  const { enabled: gpxImportEnabled } = useFeatureKillSwitch("gpx_import");
  const format = useFormat();
  const setActiveTrip = useTripStore((s) => s.setActiveTrip);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Monotonic token that lets `handleFile` detect when its in-flight parse has
  // been superseded (dialog closed, another file picked) and drop its result
  // instead of racing with the cleanup effect and leaving stale preview data.
  const parseTokenRef = useRef(0);
  const [status, setStatus] = useState<"idle" | "parsing" | "ready" | "error">(
    "idle",
  );
  const [route, setRoute] = useState<ImportedRoute | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handleFile = useCallback(
    async (file: File) => {
      const token = ++parseTokenRef.current;
      setStatus("parsing");
      setError(null);
      setRoute(null);
      setTrip(null);
      try {
        const text = await file.text();
        if (parseTokenRef.current !== token) return;
        const result = parseImportedRoute(text, file.name);
        if (parseTokenRef.current !== token) return;
        if (!result.ok) {
          setError(importErrorMessage(result.error, t));
          setStatus("error");
          return;
        }
        const nextTrip = importedRouteToTrip(result.route, format, t);
        if (parseTokenRef.current !== token) return;
        setRoute(result.route);
        setTrip(nextTrip);
        setStatus("ready");
      } catch {
        if (parseTokenRef.current !== token) return;
        setError(
          t("Could not read the file. Try again or pick a different file."),
        );
        setStatus("error");
      }
    },
    [t, format],
  );
  useEffect(() => {
    if (!open) {
      parseTokenRef.current++;
      setStatus("idle");
      setRoute(null);
      setTrip(null);
      setError(null);
    }
  }, [open]);
  useEffect(() => {
    // The kill switch has to stop the PARSE, not just the dialog. The planner's
    // drag-and-drop path leaves `open` and `initialFile` set under `force_off`,
    // so returning null from the render alone would still run
    // `parseImportedRoute` over the dropped file — continuing to feed
    // attacker-controlled input to the parser during precisely the
    // parser-vulnerability incident the switch would be flipped for.
    if (open && initialFile && gpxImportEnabled) void handleFile(initialFile);
  }, [handleFile, open, initialFile, gpxImportEnabled]);
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  const segments = useMemo(() => flattenSegments(trip), [trip]);
  function handleAdopt() {
    if (!trip) return;
    setActiveTrip(trip);
    onClose();
  }
  // After every hook, so the gate cannot change hook order between renders.
  if (!open || !gpxImportEnabled) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="trip-import-title"
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl overflow-hidden rounded-[14px] border border-line-strong bg-cream shadow-[0_18px_48px_rgba(14,14,16,0.3)]">
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2
            id="trip-import-title"
            className="flex items-center gap-2 text-sm font-semibold text-ink"
          >
            <FileUp size={14} className="text-accent" />
            {t("Import GPX or KML")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Close import dialog")}
            className="text-fg-dim transition hover:text-ink"
          >
            <X size={16} />
          </button>
        </header>

        <div className="p-5 space-y-4">
          {status === "idle" && (
            <IdlePicker onPick={() => fileInputRef.current?.click()} />
          )}

          {status === "parsing" && (
            <div className="flex items-center justify-center gap-3 py-6 text-sm text-fg-dim">
              <Loader2 size={16} className="animate-spin" />
              {t("Parsing route…")}
            </div>
          )}

          {status === "error" && (
            <div className="space-y-3 rounded-lg border border-quality-q1/30 bg-quality-q1/10 p-4 text-sm text-red-700">
              <p>{error}</p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="text-xs font-semibold text-red-700 underline hover:text-ink"
              >
                {t("Pick another file")}
              </button>
            </div>
          )}

          {status === "ready" && route && trip && (
            <RoutePreview
              route={route}
              trip={trip}
              segmentCount={segments.length}
            />
          )}

          {/* eslint-disable-next-line no-restricted-syntax -- hidden file
              picker (GPX/KML import); the ui library has no file control,
              the visible affordance is a Button. */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".gpx,.kml,application/gpx+xml,application/vnd.google-earth.kml+xml,text/xml,application/xml"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              // Allow re-picking the same file.
              e.target.value = "";
            }}
          />
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t("Cancel")}
          </Button>
          {status === "ready" && (
            <Button variant="accent" size="sm" onClick={handleAdopt}>
              {t("Adopt as trip draft")}
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}
function IdlePicker({ onPick }: { onPick: () => void }) {
  const t = useTranslation();
  return (
    <button
      type="button"
      onClick={onPick}
      className="w-full rounded-xl border-2 border-dashed border-line-strong p-8 text-center transition hover:border-accent"
    >
      <FileUp
        size={32}
        className="mx-auto mb-3 text-fg-dim group-hover:text-accent"
      />
      <p className="text-sm font-medium text-ink">
        {t("Choose a GPX or KML file")}
      </p>
      <p className="mt-1 text-xs text-fg-dim">
        {t("Exports from Garmin, Calimoto, Kurviger, Scenic, Google Earth")}
      </p>
    </button>
  );
}
function RoutePreview({
  route,
  trip,
  segmentCount,
}: {
  route: ImportedRoute;
  trip: Trip;
  segmentCount: number;
}) {
  const t = useTranslation();
  const format = useFormat();
  const firstDay = trip.days[0];
  const maxSegmentKm =
    firstDay?.segments?.reduce((m, seg) => Math.max(m, seg.distanceKm), 0) || 1;
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-paper-2 p-4">
        <p className="mb-1 text-xs uppercase tracking-wider text-fg-dim">
          {t("Route")}
        </p>
        <p className="truncate text-base font-semibold text-ink">
          {route.name}
        </p>
        <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
          <Stat
            label={t("Distance")}
            value={format.distanceKm(route.totalDistanceKm)}
          />
          <Stat
            label={t("Points")}
            value={format.integer(route.points.length)}
          />
          <Stat
            label={t("Avg quality")}
            value={firstDay ? format.decimal(firstDay.avgQuality, 1) : "—"}
          />
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-fg-dim">
          {t(
            "Road quality shown is a deterministic preview until your route is matched against Tarmoto's tile data. Each segment bar below uses the same colour scale as the planner overlay.",
          )}
        </p>
      </div>

      <div>
        <p className="mb-2 text-xs uppercase tracking-wider text-fg-dim">
          {t("Segment quality ({count, number})", { count: segmentCount })}
        </p>
        <div className="space-y-1">
          {firstDay?.segments?.map((seg) => {
            const cfg = QUALITY_CONFIG[seg.qualityTier];
            const widthPct = Math.max(8, (seg.distanceKm / maxSegmentKm) * 100);
            return (
              <div
                key={seg.id}
                className="flex items-center gap-2 text-xs"
                data-testid={`import-segment-${seg.id}`}
              >
                <span className="w-24 truncate text-fg-dim">{seg.name}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink/10">
                  <div
                    className={`${cfg.bg} h-full`}
                    style={{ width: `${widthPct}%` }}
                    aria-label={t("{tier} • {distance}", {
                      tier: t(cfg.label),
                      distance: format.distanceKm(seg.distanceKm),
                    })}
                  />
                </div>
                <span className="w-14 text-right tabular-nums text-fg-dim">
                  {format.distanceKm(seg.distanceKm)}
                </span>
                <span
                  className={`quality-${seg.qualityTier} w-16 rounded-full px-1.5 py-0.5 text-center text-[10px] font-semibold`}
                >
                  {t(cfg.label)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {route.waypoints.length > 0 && (
        <div>
          <p className="mb-2 text-xs uppercase tracking-wider text-fg-dim">
            {t("Waypoints ({count, number})", {
              count: route.waypoints.length,
            })}
          </p>
          <ul className="max-h-28 space-y-1 overflow-y-auto pr-1 text-xs text-fg-dim">
            {route.waypoints.map((wp, i) => (
              <li key={i} className="flex items-center gap-2 truncate">
                <MapPin size={12} className="shrink-0 text-fg-dim" />
                <span className="truncate">
                  {wp.name?.trim() ? wp.name : t("Waypoint {n}", { n: i + 1 })}
                </span>
                <span className="tabular-nums text-fg-dim">
                  {format.decimal(wp.lat, 4)}, {format.decimal(wp.lng, 4)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-fg-dim">
        {label}
      </p>
      <p className="font-semibold tabular-nums text-ink">{value}</p>
    </div>
  );
}
