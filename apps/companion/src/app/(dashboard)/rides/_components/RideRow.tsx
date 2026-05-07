"use client";
import { t } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, Loader2, Pencil, X } from "lucide-react";
import { api } from "@/lib/api";
import type { RideSummary } from "./useRidesQuery";
interface Props {
  ride: RideSummary;
  selected: boolean;
  onSelect: () => void;
  onRenamed: (next: RideSummary) => void;
}
const QUALITY_COLOR: Record<number, string> = {
  5: "bg-emerald-500/20 text-emerald-300",
  4: "bg-lime-500/20 text-lime-300",
  3: "bg-yellow-500/20 text-yellow-300",
  2: "bg-orange-500/20 text-orange-300",
  1: "bg-red-500/20 text-red-300",
};
function qualityBand(q: number | null): number | null {
  if (q == null) return null;
  return Math.min(5, Math.max(1, Math.round(q)));
}
export function RideRow({ ride, selected, onSelect, onRenamed }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(ride.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rowRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    setDraft(ride.name ?? "");
  }, [ride.name]);
  useEffect(() => {
    if (selected) {
      rowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selected]);
  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const trimmed = draft.trim();
    try {
      const { data, error } = await api.PATCH("/api/v1/rides/{rideId}", {
        params: { path: { rideId: ride.id } },
        body: { name: trimmed === "" ? null : trimmed },
      } as never);
      if (error) throw new Error("Rename failed");
      const d = data as unknown as RideSummary;
      onRenamed(d);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rename failed");
    } finally {
      setBusy(false);
    }
  }
  const q = qualityBand(ride.avg_road_quality);
  const displayName =
    ride.name ?? `Ride on ${new Date(ride.started_at).toLocaleDateString()}`;
  return (
    <tr
      ref={rowRef}
      onClick={onSelect}
      className={`cursor-pointer transition ${
        selected
          ? "bg-slate-800/60 border-l-2 border-tarmoto-cyan"
          : "hover:bg-slate-800/40 border-l-2 border-transparent"
      }`}
    >
      <td className="px-3 py-2">
        {editing ? (
          <div
            className="flex items-center gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              value={draft}
              maxLength={120}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key === "Escape") {
                  setDraft(ride.name ?? "");
                  setEditing(false);
                }
              }}
              className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm"
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              aria-label={t("Save")}
              className="p-1 text-emerald-400 hover:bg-slate-700 rounded"
            >
              {busy ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Check size={14} />
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(ride.name ?? "");
                setEditing(false);
              }}
              aria-label={t("Cancel")}
              className="p-1 text-slate-400 hover:bg-slate-700 rounded"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
            className="group flex items-center gap-1.5 text-left"
          >
            <span className="truncate text-slate-100">{displayName}</span>
            <Pencil
              size={12}
              className="text-slate-500 opacity-0 group-hover:opacity-100 transition"
            />
          </button>
        )}
        {error && <p className="text-xs text-red-400 mt-0.5">{error}</p>}
      </td>
      <td className="px-3 py-2 text-slate-300 whitespace-nowrap">
        {new Date(ride.started_at).toLocaleDateString()}
      </td>
      <td className="px-3 py-2 text-slate-300 whitespace-nowrap">
        {ride.distance_km != null ? `${ride.distance_km.toFixed(1)} km` : "—"}
      </td>
      <td className="px-3 py-2 text-slate-300 whitespace-nowrap">
        {ride.duration_min != null ? `${ride.duration_min} min` : "—"}
      </td>
      <td className="px-3 py-2">
        {q != null ? (
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs ${QUALITY_COLOR[q]}`}
          >
            {ride.avg_road_quality?.toFixed(1)}
          </span>
        ) : (
          <span className="text-slate-500">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <Link
          href={`/rides/${ride.id}`}
          onClick={(e) => e.stopPropagation()}
          aria-label={t("Open ride")}
          className="inline-flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:text-tarmoto-cyan hover:bg-slate-800 transition"
        >
          <ArrowUpRight size={14} />
        </Link>
      </td>
    </tr>
  );
}
