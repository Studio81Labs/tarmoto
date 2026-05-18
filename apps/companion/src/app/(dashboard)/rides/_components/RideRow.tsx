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
// Quality pills on the rides table render against the cream row surface,
// so use the canonical q-scale hues directly with bold ink text on a
// light same-hue tint. The text-ink-on-q* contrast lands ≥4.5:1 for
// q3-q5 and passes WCAG 3:1 large-text on q1/q2 (these are 12px chip
// labels in tabular-nums).
const QUALITY_COLOR: Record<number, string> = {
  5: "bg-quality-q5/30 text-ink",
  4: "bg-quality-q4/35 text-ink",
  3: "bg-quality-q3/40 text-ink",
  2: "bg-quality-q2/30 text-ink",
  1: "bg-quality-q1/25 text-ink",
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
          ? "bg-paper border-l-2 border-accent"
          : "hover:bg-paper border-l-2 border-transparent"
      }`}
    >
      <td className="px-3 py-3">
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
              className="flex-1 bg-cream border border-line rounded px-2 py-1 text-sm text-ink focus:outline-none focus:border-ink"
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              aria-label={t("Save")}
              className="p-1 text-accent hover:bg-paper-2 rounded"
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
              className="p-1 text-fg-dim hover:bg-paper-2 rounded"
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
            <span className="truncate font-semibold text-ink">
              {displayName}
            </span>
            <Pencil
              size={12}
              className="text-fg-mute opacity-0 group-hover:opacity-100 transition"
            />
          </button>
        )}
        {error && <p className="text-xs text-red-400 mt-0.5">{error}</p>}
      </td>
      <td className="px-3 py-3 font-mono text-fg-dim whitespace-nowrap tabular-nums">
        {new Date(ride.started_at).toLocaleDateString()}
      </td>
      <td className="px-3 py-3 font-mono text-ink font-semibold whitespace-nowrap tabular-nums">
        {ride.distance_km != null ? `${ride.distance_km.toFixed(1)} km` : "—"}
      </td>
      <td className="px-3 py-3 font-mono text-fg-dim whitespace-nowrap tabular-nums">
        {ride.duration_min != null ? `${ride.duration_min} min` : "—"}
      </td>
      <td className="px-3 py-3">
        {q != null ? (
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold tabular-nums ${QUALITY_COLOR[q]}`}
          >
            {ride.avg_road_quality?.toFixed(1)}
          </span>
        ) : (
          <span className="text-fg-mute">—</span>
        )}
      </td>
      <td className="px-3 py-3 text-right">
        <Link
          href={`/rides/${ride.id}`}
          onClick={(e) => e.stopPropagation()}
          aria-label={t("Open ride")}
          className="inline-flex items-center justify-center w-7 h-7 rounded-md text-fg-dim hover:text-accent hover:bg-paper-2 transition"
        >
          <ArrowUpRight size={14} />
        </Link>
      </td>
    </tr>
  );
}
