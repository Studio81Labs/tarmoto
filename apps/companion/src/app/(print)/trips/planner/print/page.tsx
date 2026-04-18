"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Printer, ArrowLeft } from "lucide-react";
import type { Trip } from "@/lib/types";
import {
  TRIP_PRINT_STORAGE_KEY,
  buildTurnList,
  tripToGpx,
} from "@/lib/trip-export";
import { formatDistance, formatDuration } from "@/lib/utils";
import { DEMO_TRIP } from "@/lib/demo-trip";

/**
 * Print-friendly trip summary (US-39). Opened in a new tab from the planner's
 * Export menu; the Zustand trip store is tab-local so the planner stashes the
 * active trip in localStorage keyed by id and we hydrate from there.
 * `sessionStorage` would be the natural fit but `window.open(..., "noopener")`
 * in the planner severs the creator relationship, which skips its copy; we
 * therefore use localStorage and clear the key after reading so nothing
 * persists beyond the print handoff.
 */

// Module-level cache keyed by trip id. React StrictMode double-invokes
// effects in dev (setup → cleanup → setup) and Next.js can re-run them on
// fast-refresh; after the first run deletes the localStorage entry the
// subsequent runs would otherwise see `null` and clobber the loaded trip.
const hydratedTrips = new Map<string, Trip>();

export default function TripPrintPage() {
  // `useSearchParams` requires a Suspense boundary in Next.js 15 or the
  // build errors with "Missing Suspense boundary with useSearchParams".
  return (
    <Suspense
      fallback={<div className="p-10 text-sm text-slate-500">Loading…</div>}
    >
      <TripPrintPageContent />
    </Suspense>
  );
}

function TripPrintPageContent() {
  const params = useSearchParams();
  const tripId = params?.get("trip") ?? null;
  const [trip, setTrip] = useState<Trip | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const cacheKey = tripId ?? "";
    const cached = hydratedTrips.get(cacheKey);
    if (cached) {
      setTrip(cached);
      setReady(true);
      return;
    }

    let loaded: Trip | null = null;
    try {
      const raw = localStorage.getItem(TRIP_PRINT_STORAGE_KEY);
      if (raw) {
        localStorage.removeItem(TRIP_PRINT_STORAGE_KEY);
        const parsed = JSON.parse(raw) as Trip;
        if (!tripId || parsed.id === tripId) loaded = parsed;
      }
    } catch {
      /* ignore — fall back below */
    }
    if (!loaded && tripId === DEMO_TRIP.id) loaded = DEMO_TRIP;
    if (loaded) hydratedTrips.set(cacheKey, loaded);
    setTrip(loaded);
    setReady(true);
  }, [tripId]);

  const turns = useMemo(() => (trip ? buildTurnList(trip) : []), [trip]);
  const totals = useMemo(() => {
    if (!trip) return { distanceKm: 0, durationMinutes: 0 };
    return trip.days.reduce(
      (acc, day) => ({
        distanceKm: acc.distanceKm + day.distanceKm,
        durationMinutes: acc.durationMinutes + day.durationMinutes,
      }),
      { distanceKm: 0, durationMinutes: 0 },
    );
  }, [trip]);

  if (!ready) {
    return <div className="p-10 text-sm text-slate-500">Loading…</div>;
  }

  if (!trip) {
    return (
      <div className="min-h-screen bg-white text-slate-900 p-10 max-w-3xl mx-auto">
        <p className="mb-4 text-sm text-slate-600">
          No trip to print. Open a trip in the planner first.
        </p>
        <Link
          href="/trips/planner"
          className="inline-flex items-center gap-1.5 text-slate-900 underline text-sm"
        >
          <ArrowLeft size={14} /> Back to planner
        </Link>
      </div>
    );
  }

  const gpxHeader = tripToGpx(trip).split("\n").slice(0, 2).join(" ");

  return (
    <div className="trip-print min-h-screen bg-white text-slate-900">
      <style>{`
        @media print {
          .trip-print-toolbar { display: none !important; }
          @page { margin: 18mm; }
        }
      `}</style>

      <div className="trip-print-toolbar sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/95 backdrop-blur px-6 py-3">
        <Link
          href="/trips/planner"
          className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft size={14} /> Back to planner
        </Link>
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-sm hover:bg-slate-800 transition"
        >
          <Printer size={14} /> Print
        </button>
      </div>

      <article className="max-w-3xl mx-auto px-6 py-8 space-y-8 text-[14px] leading-relaxed">
        <header>
          <p className="text-xs uppercase tracking-widest text-slate-500">
            Tarmoto trip summary
          </p>
          <h1 className="text-3xl font-bold mt-1">{trip.name}</h1>
          {trip.description && (
            <p className="mt-2 text-slate-600">{trip.description}</p>
          )}
          <dl className="mt-4 grid grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-slate-500">Days</dt>
              <dd className="font-semibold tabular-nums">{trip.days.length}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Total distance</dt>
              <dd className="font-semibold tabular-nums">
                {formatDistance(totals.distanceKm)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Riding time</dt>
              <dd className="font-semibold tabular-nums">
                {formatDuration(totals.durationMinutes)}
              </dd>
            </div>
          </dl>
        </header>

        <section>
          <h2 className="text-lg font-semibold mb-3">Itinerary</h2>
          <ol className="space-y-5">
            {turns.map((day) => (
              <li
                key={day.dayNumber}
                className="border-l-2 border-slate-300 pl-4"
              >
                <div className="flex items-baseline gap-3 mb-2">
                  <h3 className="text-base font-semibold">
                    Day {day.dayNumber}
                    {day.dayTitle && (
                      <span className="text-slate-500 font-normal">
                        {" "}
                        — {day.dayTitle}
                      </span>
                    )}
                  </h3>
                  <span className="text-xs text-slate-500 tabular-nums">
                    {formatDistance(day.distanceKm)} ·{" "}
                    {formatDuration(day.durationMinutes)}
                  </span>
                </div>

                {day.waypoints.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    No waypoints yet for this day.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {day.waypoints.map((wp, idx) => (
                      <li
                        key={idx}
                        className="flex items-baseline gap-3 text-sm"
                      >
                        <span className="w-20 shrink-0 text-xs uppercase tracking-wider text-slate-500">
                          {wp.typeLabel}
                        </span>
                        <span className="flex-1 font-medium">{wp.label}</span>
                        <span className="tabular-nums text-xs text-slate-500">
                          {wp.lat.toFixed(4)}, {wp.lng.toFixed(4)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </section>

        <footer className="pt-4 border-t border-slate-200 text-xs text-slate-500">
          <p>
            Generated with Tarmoto Companion · {new Date().toLocaleDateString()}
          </p>
          <p className="mt-1 font-mono text-[10px] truncate" title={gpxHeader}>
            {gpxHeader}
          </p>
        </footer>
      </article>
    </div>
  );
}
