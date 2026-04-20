"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import {
  History,
  Calendar,
  MapPin,
  Gauge,
  ChevronRight,
  Scale,
  Download,
  Loader2,
} from "lucide-react";
import type { Ride } from "@/lib/types";
import {
  downloadAllRidesExport,
  type RideExportFormat,
} from "@/lib/ride-export";

export default function RideListPage() {
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // The spec returns RideSummaryDto (snake_case) while the local Ride type
    // uses camelCase. Cast through unknown until the local types are replaced
    // with spec-generated types.
    api
      .GET("/api/v1/rides")
      .then(({ data }) => {
        if (data?.rides) {
          setRides(data.rides as unknown as Ride[]);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-6xl mx-auto animate-fade-in">
      <div className="flex items-center justify-between mb-6 gap-4">
        <h1 className="text-2xl font-bold">Ride History</h1>
        <div className="flex items-center gap-2">
          {rides.length > 0 && <BulkExportMenu />}
          {rides.length >= 2 && (
            <Link
              href="/rides/compare"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 text-slate-200 text-sm hover:bg-slate-700 transition"
            >
              <Scale size={14} /> Compare rides
            </Link>
          )}
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-20 rounded-xl bg-slate-900 border border-slate-800 animate-pulse"
            />
          ))}
        </div>
      ) : rides.length === 0 ? (
        <div className="rounded-2xl bg-slate-900 border border-slate-800 p-16 text-center">
          <History size={48} className="mx-auto text-slate-600 mb-4" />
          <p className="text-slate-400 text-lg mb-2">No rides recorded yet</p>
          <p className="text-slate-500 text-sm">
            Start riding with the Tarmoto mobile app to see your history here.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rides.map((ride) => (
            <Link
              key={ride.id}
              href={`/rides/${ride.id}`}
              className="flex items-center gap-4 p-4 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 transition group"
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium text-white group-hover:text-tarmoto-cyan truncate transition">
                  {ride.name ??
                    `Ride on ${new Date(ride.startedAt).toLocaleDateString()}`}
                </p>
                <div className="flex items-center gap-4 mt-1 text-sm text-slate-400">
                  <span className="flex items-center gap-1">
                    <Calendar size={12} />{" "}
                    {new Date(ride.startedAt).toLocaleDateString()}
                  </span>
                  <span className="flex items-center gap-1">
                    <MapPin size={12} /> {ride.distanceKm.toFixed(1)} km
                  </span>
                  <span className="flex items-center gap-1">
                    <Gauge size={12} /> {ride.avgSpeedKmh.toFixed(0)} km/h avg
                  </span>
                </div>
              </div>
              <ChevronRight size={16} className="text-slate-600" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function BulkExportMenu() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<RideExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(ev: MouseEvent) {
      if (!containerRef.current?.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function handleExport(format: RideExportFormat) {
    if (busy) return;
    setBusy(format);
    setError(null);
    try {
      await downloadAllRidesExport(format);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={busy !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 text-slate-200 text-sm hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        {busy ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Download size={14} />
        )}
        Export all
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 w-44 rounded-lg bg-slate-900 border border-slate-800 shadow-lg overflow-hidden z-10"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => handleExport("csv")}
            disabled={busy !== null}
            className="w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            CSV (stats)
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleExport("gpx")}
            disabled={busy !== null}
            className="w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition border-t border-slate-800"
          >
            GPX (tracks)
          </button>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="absolute right-0 top-full mt-2 text-xs text-red-400 whitespace-nowrap"
        >
          Export failed: {error}
        </p>
      )}
    </div>
  );
}
