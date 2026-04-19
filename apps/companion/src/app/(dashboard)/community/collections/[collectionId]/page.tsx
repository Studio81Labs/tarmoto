"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Calendar,
  Check,
  Globe,
  Link as LinkIcon,
  Loader2,
  Lock,
  MapPin,
  Plus,
  Route as RouteIcon,
  Trash2,
  X,
} from "lucide-react";
import { tripsApi } from "@/lib/api";
import { useTripStore } from "@/stores/trip";
import { useAuthStore } from "@/stores/auth";
import {
  addTripsToCollection,
  loadCollections,
  removeTripFromCollection,
  saveCollections,
  sortCollectionsByName,
  type StoredRouteCollection,
} from "@/lib/route-collections";
import { tripDistanceKm } from "@/lib/trip-filters";
import { buildRoutePreview, type RoutePoint } from "@/lib/ride-detail";
import { formatDistance, formatRelativeTime } from "@/lib/utils";
import type { Trip, TripDay } from "@/lib/types";

export default function CollectionDetailPage() {
  const { collectionId } = useParams<{ collectionId: string }>();
  const router = useRouter();
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const trips = useTripStore((s) => s.trips);
  const setTrips = useTripStore((s) => s.setTrips);

  const [collections, setCollections] = useState<StoredRouteCollection[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [loadingTrips, setLoadingTrips] = useState(true);
  const [showPicker, setShowPicker] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);

  useEffect(() => {
    if (!userId) {
      setCollections([]);
      setHydrated(true);
      return;
    }
    setCollections(sortCollectionsByName(loadCollections(userId)));
    setHydrated(true);
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    setTrips([]);
    if (!userId) {
      setLoadingTrips(false);
      return () => {
        cancelled = true;
      };
    }
    setLoadingTrips(true);
    tripsApi
      .list()
      .then(({ data }) => {
        if (cancelled) return;
        const body = data as unknown as { data?: Trip[] } | Trip[];
        setTrips(Array.isArray(body) ? body : (body?.data ?? []));
      })
      .catch(() => {
        if (!cancelled) setTrips([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingTrips(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setTrips, userId]);

  const collection = useMemo(
    () => collections.find((c) => c.id === collectionId) ?? null,
    [collections, collectionId],
  );

  const tripById = useMemo(() => {
    const map = new Map<string, Trip>();
    for (const t of trips) map.set(t.id, t);
    return map;
  }, [trips]);

  const persist = (next: readonly StoredRouteCollection[]) => {
    const sorted = sortCollectionsByName(next);
    setCollections(sorted);
    if (userId) saveCollections(userId, sorted);
  };

  const handleAddTrips = (tripIds: string[]) => {
    if (!collection || tripIds.length === 0) return;
    persist(addTripsToCollection(collections, collection.id, tripIds));
    setShowPicker(false);
  };

  const handleRemoveTrip = (tripId: string) => {
    if (!collection) return;
    persist(removeTripFromCollection(collections, collection.id, tripId));
  };

  async function handleShare() {
    if (typeof window === "undefined") return;
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch {
      // Clipboard API can reject on insecure origins; fall back silently.
    }
  }

  if (!hydrated) {
    return (
      <div className="p-6 max-w-4xl mx-auto animate-fade-in">
        <div className="flex items-center gap-2 text-slate-400 text-sm">
          <Loader2 size={16} className="animate-spin" /> Loading collection…
        </div>
      </div>
    );
  }

  if (!collection) {
    return (
      <div className="p-6 max-w-4xl mx-auto animate-fade-in">
        <Link
          href="/community/collections"
          className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white mb-4 transition"
        >
          <ArrowLeft size={16} /> Collections
        </Link>
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-10 text-center">
          <RouteIcon size={40} className="mx-auto text-slate-600 mb-3" />
          <p className="text-slate-200 font-medium mb-1">
            Collection not found
          </p>
          <p className="text-sm text-slate-500">
            This collection may have been deleted from this device.
          </p>
        </div>
      </div>
    );
  }

  const memberTripIds = new Set(collection.tripIds);
  const memberTrips: (Trip | { id: string; missing: true })[] =
    collection.tripIds.map((id) => tripById.get(id) ?? { id, missing: true });
  const presentTrips = memberTrips.filter((t): t is Trip => !("missing" in t));
  const totalDistance = presentTrips.reduce(
    (sum, t) => sum + tripDistanceKm(t),
    0,
  );
  const totalDays = presentTrips.reduce((sum, t) => sum + t.days.length, 0);
  const availableTrips = trips.filter((t) => !memberTripIds.has(t.id));

  return (
    <div className="p-6 max-w-4xl mx-auto animate-fade-in">
      <Link
        href="/community/collections"
        className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white mb-4 transition"
      >
        <ArrowLeft size={16} /> Collections
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-3 mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-2xl font-bold break-words">
              {collection.name}
            </h1>
            <span
              className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${
                collection.isPublic
                  ? "bg-tarmoto-cyan/10 text-tarmoto-cyan"
                  : "bg-slate-800 text-slate-400"
              }`}
            >
              {collection.isPublic ? <Globe size={10} /> : <Lock size={10} />}
              {collection.isPublic ? "Public" : "Private"}
            </span>
          </div>
          <p className="text-xs text-slate-500">
            Updated {formatRelativeTime(collection.updatedAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleShare}
            disabled={!collection.isPublic}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
            title={
              collection.isPublic
                ? shareCopied
                  ? "Link copied"
                  : "Copy share link"
                : "Make the collection public to share it"
            }
          >
            {shareCopied ? (
              <>
                <Check size={14} /> Copied
              </>
            ) : (
              <>
                <LinkIcon size={14} /> Share
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => setShowPicker(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 text-sm font-semibold hover:bg-tarmoto-cyan-light transition"
          >
            <Plus size={14} /> Add routes
          </button>
        </div>
      </header>

      {collection.description && (
        <p className="text-sm text-slate-300 mt-3 max-w-2xl whitespace-pre-line">
          {collection.description}
        </p>
      )}

      <section className="mt-6 grid grid-cols-3 gap-3">
        <Stat
          label="Routes"
          value={`${collection.tripIds.length}`}
          hint={
            collection.tripIds.length - presentTrips.length > 0 && !loadingTrips
              ? `${collection.tripIds.length - presentTrips.length} unavailable`
              : undefined
          }
        />
        <Stat label="Total distance" value={formatDistance(totalDistance)} />
        <Stat label="Riding days" value={`${totalDays}`} />
      </section>

      <section className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
          Routes
        </h2>
        {memberTrips.length === 0 ? (
          <EmptyRoutes onAdd={() => setShowPicker(true)} />
        ) : loadingTrips ? (
          // Until the trips API has responded, `tripById` is empty and every
          // member would otherwise render as "missing" with an active remove
          // button. Show skeleton rows instead so users don't accidentally
          // drop valid references on slow networks or API failures.
          <ul className="space-y-3">
            {memberTrips.map((entry) => (
              <LoadingTripRow key={entry.id} />
            ))}
          </ul>
        ) : (
          <ul className="space-y-3">
            {memberTrips.map((entry) =>
              "missing" in entry ? (
                <MissingTripRow
                  key={entry.id}
                  onRemove={() => handleRemoveTrip(entry.id)}
                />
              ) : (
                <TripRow
                  key={entry.id}
                  trip={entry}
                  onRemove={() => handleRemoveTrip(entry.id)}
                />
              ),
            )}
          </ul>
        )}
      </section>

      {showPicker && (
        <RoutePickerModal
          trips={availableTrips}
          loading={loadingTrips}
          hasAnyTrips={trips.length > 0}
          onClose={() => setShowPicker(false)}
          onAdd={handleAddTrips}
          onPlanTrip={() => router.push("/trips/planner")}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <p className="text-[11px] uppercase tracking-widest text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold text-white">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-amber-400">{hint}</p>}
    </div>
  );
}

function EmptyRoutes({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-2xl bg-slate-900 border border-dashed border-slate-800 p-10 text-center">
      <RouteIcon size={40} className="mx-auto text-slate-600 mb-3" />
      <p className="text-slate-400 mb-1">No routes in this collection yet</p>
      <p className="text-sm text-slate-500 mb-5">
        Add routes from your planned or completed trips.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold text-sm hover:bg-tarmoto-cyan-light transition"
      >
        <Plus size={16} /> Add routes
      </button>
    </div>
  );
}

function TripRow({ trip, onRemove }: { trip: Trip; onRemove: () => void }) {
  const points = useMemo(() => combineTripRoutePoints(trip.days), [trip.days]);
  const preview = useMemo(() => buildRoutePreview(points, 200, 6), [points]);
  const distance = tripDistanceKm(trip);

  return (
    <li className="rounded-2xl border border-slate-800 bg-slate-900 hover:border-slate-700 transition">
      <div className="flex items-stretch gap-0">
        <Link
          href={`/trips/${trip.id}`}
          className="flex-1 flex items-center gap-4 p-4 min-w-0 group"
        >
          <div className="hidden sm:flex shrink-0 w-24 h-16 items-center justify-center rounded-lg bg-slate-950 border border-slate-800">
            {preview ? (
              <svg
                viewBox={preview.viewBox}
                className="h-full w-full"
                role="img"
                aria-label={`${trip.name} route preview`}
              >
                <path
                  d={preview.path}
                  fill="none"
                  stroke="#0ED3CF"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <RouteIcon size={20} className="text-slate-600" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-medium text-white group-hover:text-tarmoto-cyan transition truncate">
              {trip.name}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
              <span className="inline-flex items-center gap-1">
                <Calendar size={12} />
                {trip.days.length} day{trip.days.length === 1 ? "" : "s"}
              </span>
              <span className="inline-flex items-center gap-1">
                <MapPin size={12} />
                {formatDistance(distance)}
              </span>
              <span className="text-[11px] text-slate-600 uppercase tracking-widest">
                {trip.status}
              </span>
            </div>
          </div>
        </Link>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${trip.name} from collection`}
          className="px-3 text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </li>
  );
}

function MissingTripRow({ onRemove }: { onRemove: () => void }) {
  return (
    <li className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/50 p-4 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm text-slate-400">Trip no longer available</p>
        <p className="text-[11px] text-slate-600">
          The route may have been deleted or belongs to another account.
        </p>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition"
      >
        <X size={12} /> Remove
      </button>
    </li>
  );
}

function LoadingTripRow() {
  return (
    <li className="rounded-2xl border border-slate-800 bg-slate-900 p-4 flex items-center gap-4 animate-pulse">
      <div className="hidden sm:block shrink-0 w-24 h-16 rounded-lg bg-slate-800" />
      <div className="flex-1 min-w-0 space-y-2">
        <div className="h-3.5 w-1/2 rounded bg-slate-800" />
        <div className="h-2.5 w-1/3 rounded bg-slate-800" />
      </div>
    </li>
  );
}

// ─────────────────────────────────────────────────────────
// Route picker modal
// ─────────────────────────────────────────────────────────

function RoutePickerModal({
  trips,
  loading,
  hasAnyTrips,
  onClose,
  onAdd,
  onPlanTrip,
}: {
  trips: Trip[];
  loading: boolean;
  // `trips` is already filtered to exclude members of this collection, so
  // `trips.length === 0` alone can't distinguish "user has no trips" from
  // "every trip is already here". Caller passes the unfiltered count so we
  // render the right empty state.
  hasAnyTrips: boolean;
  onClose: () => void;
  onAdd: (tripIds: string[]) => void;
  onPlanTrip: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return trips;
    return trips.filter((t) =>
      `${t.name} ${t.description ?? ""}`.toLowerCase().includes(needle),
    );
  }, [trips, search]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg max-h-[80vh] rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl flex flex-col"
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-white">Add routes</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X size={14} />
          </button>
        </div>
        <input
          type="text"
          placeholder="Search your trips…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-white text-sm placeholder:text-slate-600 focus:outline-none focus:border-tarmoto-cyan mb-3"
        />

        <div className="flex-1 overflow-y-auto -mx-1 px-1">
          {loading ? (
            <div className="py-10 text-center text-sm text-slate-500">
              <Loader2
                size={16}
                className="animate-spin inline-block mr-2 align-[-3px]"
              />
              Loading your trips…
            </div>
          ) : trips.length === 0 ? (
            hasAnyTrips ? (
              <div className="py-8 text-center">
                <p className="text-sm text-slate-400 mb-1">
                  All your trips are already in this collection
                </p>
                <p className="text-xs text-slate-500">
                  Plan another trip to add it here.
                </p>
              </div>
            ) : (
              <div className="py-8 text-center">
                <p className="text-sm text-slate-400 mb-1">
                  You don&apos;t have any trips yet
                </p>
                <p className="text-xs text-slate-500 mb-4">
                  Plan a trip first and it will show up here.
                </p>
                <button
                  type="button"
                  onClick={onPlanTrip}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 text-xs hover:bg-slate-700 transition"
                >
                  <Plus size={14} /> New trip
                </button>
              </div>
            )
          ) : visible.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">
              No trips match your search.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {visible.map((trip) => {
                const checked = selected.has(trip.id);
                const distance = tripDistanceKm(trip);
                return (
                  <li key={trip.id}>
                    <label
                      className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer border transition ${
                        checked
                          ? "border-tarmoto-cyan/40 bg-tarmoto-cyan/5"
                          : "border-slate-800 bg-slate-950 hover:border-slate-700"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(trip.id)}
                        className="accent-tarmoto-cyan"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-white truncate">
                          {trip.name}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          {trip.days.length} day
                          {trip.days.length === 1 ? "" : "s"} ·{" "}
                          {formatDistance(distance)} · {trip.status}
                        </p>
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <p className="text-[11px] text-slate-500">{selected.size} selected</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-sm text-slate-400 hover:text-white transition"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={selected.size === 0}
              onClick={() => onAdd(Array.from(selected))}
              className="px-3 py-1.5 rounded-lg bg-tarmoto-cyan text-slate-950 text-sm font-semibold hover:bg-tarmoto-cyan-light disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              Add{selected.size > 0 ? ` (${selected.size})` : ""}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Route geometry helpers
// ─────────────────────────────────────────────────────────

// Combines each day's routeGeometry (a GeoJSON LineString of [lng, lat]
// tuples) into a single flat list of lat/lng points that `buildRoutePreview`
// expects. Days without geometry are skipped; a single M command is emitted
// per day implicitly because `buildRoutePreview` draws a continuous path, but
// the visual discontinuity between days is small at preview resolution and
// better than omitting the geometry altogether.
function combineTripRoutePoints(days: readonly TripDay[]): RoutePoint[] {
  const out: RoutePoint[] = [];
  for (const day of days) {
    const coords = day.routeGeometry?.coordinates;
    if (!coords) continue;
    for (const [lng, lat] of coords) {
      if (typeof lng === "number" && typeof lat === "number") {
        out.push({ lat, lng });
      }
    }
  }
  return out;
}
