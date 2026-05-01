"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Loader2, Printer } from "lucide-react";
import { ApiError, tripsApi } from "@/lib/api";
import {
  tripFromDetail,
  type TripDetailMember,
  type TripDetailResponse,
} from "@/lib/trip-from-detail";
import type { Trip } from "@/lib/types";
import { TripPrintBody } from "@/components/TripPrintBody";

/**
 * Print-friendly view of a saved trip (US-39 / issue #283). Fetches the
 * trip directly from the backend so opening the page from a deep link,
 * bookmark, or PDF cron job works without any state hand-off from the
 * planner. When `?autoprint=1` is set the page triggers `window.print()`
 * after hydration so the rider lands one keypress away from saving the
 * PDF — that's the mechanism behind the "Download PDF" export action.
 */
export default function TripPrintPage() {
  return (
    // `useSearchParams` requires a Suspense boundary in Next 15+ or the
    // build errors with "Missing Suspense boundary with useSearchParams".
    <Suspense
      fallback={
        <div className="min-h-screen bg-white p-10 text-sm text-slate-500">
          Loading…
        </div>
      }
    >
      <TripPrintPageContent />
    </Suspense>
  );
}

function TripPrintPageContent() {
  const { tripId } = useParams<{ tripId: string }>();
  const searchParams = useSearchParams();
  const autoprint = searchParams?.get("autoprint") === "1";
  const [trip, setTrip] = useState<Trip | null>(null);
  const [members, setMembers] = useState<TripDetailMember[]>([]);
  const [region, setRegion] = useState<string | undefined>(undefined);
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
        setRegion(detail.region ?? undefined);
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

  // Auto-trigger the browser's print dialog once the trip has rendered.
  // The 200ms delay gives layout + SVG previews time to settle so the
  // first PDF page isn't blank — without it Chrome occasionally captures
  // the page before the per-day route SVGs paint.
  useEffect(() => {
    if (!autoprint || !trip || loading) return;
    const id = window.setTimeout(() => window.print(), 200);
    return () => window.clearTimeout(id);
  }, [autoprint, trip, loading]);

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
          <Printer size={14} /> Print / Save as PDF
        </button>
      </div>

      <TripPrintBody trip={trip} region={region} members={members} />
    </div>
  );
}
