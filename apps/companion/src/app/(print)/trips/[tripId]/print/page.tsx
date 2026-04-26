"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Loader2, Printer } from "lucide-react";
import { ApiError, tripsApi } from "@/lib/api";
import {
  tripFromDetail,
  type TripDetailMember,
  type TripDetailResponse,
} from "@/lib/trip-from-detail";
import type { Trip } from "@/lib/types";
import { buildTurnList } from "@/lib/trip-export";
import { formatDistance, formatDuration } from "@/lib/utils";

/**
 * Print-friendly view of a saved trip (US-39 / issue #259). Unlike the
 * planner print page (which hydrates from `localStorage` so the
 * `noopener` tab handoff still works), this route fetches the trip
 * directly so opening it from a deep link, bookmark, or PDF cron job
 * works without the planner having to stash anything.
 */
export default function TripPrintPage() {
  const { tripId } = useParams<{ tripId: string }>();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [members, setMembers] = useState<TripDetailMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!tripId) return;
    let cancelled = false;
    setLoading(true);
    setErrorMessage(null);
    tripsApi
      .get(tripId)
      .then(({ data }) => {
        if (cancelled) return;
        const detail = data as unknown as TripDetailResponse;
        setTrip(tripFromDetail(detail));
        setMembers(detail.members ?? []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = err instanceof ApiError ? err.status : null;
        setErrorMessage(
          status === 404
            ? "Trip not found."
            : status === 403
              ? "You don't have access to this trip."
              : "Couldn't load this trip.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tripId]);

  const turns = useMemo(() => (trip ? buildTurnList(trip) : []), [trip]);
  const totals = useMemo(() => {
    if (!trip) return { distanceKm: 0, durationMinutes: 0, elevationGain: 0 };
    return trip.days.reduce(
      (acc, day) => ({
        distanceKm: acc.distanceKm + day.distanceKm,
        durationMinutes: acc.durationMinutes + day.durationMinutes,
        elevationGain: acc.elevationGain + day.elevationGain,
      }),
      { distanceKm: 0, durationMinutes: 0, elevationGain: 0 },
    );
  }, [trip]);

  if (loading) {
    return (
      <div className="min-h-screen bg-white text-slate-900 p-10 flex items-center justify-center">
        <Loader2 size={20} className="mr-2 animate-spin" /> Loading…
      </div>
    );
  }

  if (errorMessage || !trip) {
    return (
      <div className="min-h-screen bg-white text-slate-900 p-10 max-w-3xl mx-auto">
        <p className="mb-4 text-sm text-slate-600">
          {errorMessage ?? "Trip unavailable."}
        </p>
        <Link
          href="/trips"
          className="inline-flex items-center gap-1.5 text-slate-900 underline text-sm"
        >
          <ArrowLeft size={14} /> Back to trips
        </Link>
      </div>
    );
  }

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
          href={`/trips/${trip.id}`}
          className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft size={14} /> Back to trip
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
          <dl className="mt-4 grid grid-cols-4 gap-4 text-sm">
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
                {totals.durationMinutes > 0
                  ? formatDuration(totals.durationMinutes)
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Elevation gain</dt>
              <dd className="font-semibold tabular-nums">
                {totals.elevationGain > 0
                  ? `${Math.round(totals.elevationGain)} m`
                  : "—"}
              </dd>
            </div>
          </dl>
        </header>

        {members.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold mb-2">Members</h2>
            <ul className="space-y-1 text-sm">
              {members.map((m) => (
                <li
                  key={m.user_id}
                  className="flex items-center gap-2 text-slate-700"
                >
                  <span className="font-medium">{m.display_name}</span>
                  <span className="text-xs uppercase tracking-wide text-slate-500">
                    {m.role}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

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
                    {formatDistance(day.distanceKm)}
                    {day.durationMinutes > 0 && (
                      <> · {formatDuration(day.durationMinutes)}</>
                    )}
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
        </footer>
      </article>
    </div>
  );
}
