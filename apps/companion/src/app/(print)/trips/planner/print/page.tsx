"use client";
import { t } from "@/i18n";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Printer, ArrowLeft } from "lucide-react";
import type { Trip } from "@/lib/types";
import { TRIP_PRINT_STORAGE_KEY } from "@/lib/trip-export";
import { TripPrintBody } from "@/components/TripPrintBody";
import { DEMO_TRIP } from "@/lib/demo-trip";
/**
 * Print-friendly trip summary for an unsaved planner trip (US-39 / #283).
 * Opened in a new tab from the planner's Export menu; the Zustand trip
 * store is tab-local so the planner stashes the active trip in
 * localStorage keyed by id and we hydrate from there. `sessionStorage`
 * would be the natural fit but `window.open(..., "noopener")` in the
 * planner severs the creator relationship, which skips its copy; we
 * therefore use localStorage and clear the key after reading so nothing
 * persists beyond the print handoff.
 */
// Module-level cache keyed by trip id. React StrictMode double-invokes
// effects in dev (setup → cleanup → setup) and Next.js can re-run them on
// fast-refresh; after the first run deletes the localStorage entry the
// subsequent runs would otherwise see `null` and clobber the loaded trip.
const hydratedTrips = new Map<string, Trip>();
export default function TripPrintPage() {
  return (
    // `useSearchParams` requires a Suspense boundary in Next 15+ or the
    // build errors with "Missing Suspense boundary with useSearchParams".
    <Suspense
      fallback={
        <div className="p-10 text-sm text-slate-500">{t("Loading\u2026")}</div>
      }
    >
      <TripPrintPageContent />
    </Suspense>
  );
}
function TripPrintPageContent() {
  const params = useSearchParams();
  const tripId = params?.get("trip") ?? null;
  const autoprint = params?.get("autoprint") === "1";
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
        // localStorage persists across app versions so schema drift is a
        // real risk; do a minimal shape check before trusting the payload
        // so downstream `.days.reduce(...)` can't crash the page.
        if (
          parsed &&
          typeof parsed.id === "string" &&
          typeof parsed.name === "string" &&
          Array.isArray(parsed.days) &&
          (!tripId || parsed.id === tripId)
        ) {
          loaded = parsed;
        }
      }
    } catch {
      /* ignore — fall back below */
    }
    if (!loaded && tripId === DEMO_TRIP.id) loaded = DEMO_TRIP;
    if (loaded) hydratedTrips.set(cacheKey, loaded);
    setTrip(loaded);
    setReady(true);
  }, [tripId]);
  // Auto-trigger the browser's print dialog once hydration finishes —
  // mirrors the saved-trip print page so the "Download PDF" export works
  // for unsaved planner trips too. 200ms delay lets the per-day SVG
  // previews paint before Chrome captures.
  useEffect(() => {
    if (!autoprint || !trip || !ready) return;
    const id = window.setTimeout(() => window.print(), 200);
    return () => window.clearTimeout(id);
  }, [autoprint, trip, ready]);
  if (!ready) {
    return (
      <div className="p-10 text-sm text-slate-500">{t("Loading\u2026")}</div>
    );
  }
  if (!trip) {
    return (
      <div className="min-h-screen bg-white text-slate-900 p-10 max-w-3xl mx-auto">
        <p className="mb-4 text-sm text-slate-600">
          {t("No trip to print. Open a trip in the planner first. ")}
        </p>
        <Link
          href="/trips/planner"
          className="inline-flex items-center gap-1.5 text-slate-900 underline text-sm"
        >
          <ArrowLeft size={14} />
          {t("Back to planner ")}
        </Link>
      </div>
    );
  }
  return (
    <div className="trip-print min-h-screen bg-white text-slate-900">
      <div className="trip-print-toolbar sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/95 backdrop-blur px-6 py-3">
        <Link
          href="/trips/planner"
          className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft size={14} />
          {t("Back to planner ")}
        </Link>
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-sm hover:bg-slate-800 transition"
        >
          <Printer size={14} />
          {t("Print / Save as PDF ")}
        </button>
      </div>

      <TripPrintBody trip={trip} />
    </div>
  );
}
