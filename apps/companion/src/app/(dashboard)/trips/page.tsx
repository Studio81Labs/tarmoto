"use client";

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { tripsApi } from '@/lib/api';
import { useTripStore } from '@/stores/trip';
import { Plus, Route, Calendar, MapPin, Users } from 'lucide-react';
import type { Trip } from '@/lib/types';

export default function TripListPage() {
  const trips = useTripStore((s) => s.trips);
  const setTrips = useTripStore((s) => s.setTrips);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    tripsApi.list().then(({ data }) => {
      setTrips(data.data ?? []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [setTrips]);

  return (
    <div className="p-6 max-w-6xl mx-auto animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">My Trips</h1>
        <Link
          href="/trips/planner"
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold text-sm hover:bg-tarmoto-cyan-light transition"
        >
          <Plus size={16} /> New trip
        </Link>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-48 rounded-2xl bg-slate-900 border border-slate-800 animate-pulse" />
          ))}
        </div>
      ) : trips.length === 0 ? (
        <div className="rounded-2xl bg-slate-900 border border-slate-800 p-16 text-center">
          <Route size={48} className="mx-auto text-slate-600 mb-4" />
          <p className="text-slate-400 text-lg mb-2">No trips yet</p>
          <p className="text-slate-500 text-sm mb-6">Plan your first ride with the trip planner.</p>
          <Link
            href="/trips/planner"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold text-sm hover:bg-tarmoto-cyan-light transition"
          >
            <Plus size={16} /> Create trip
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {trips.map((trip) => (
            <TripCard key={trip.id} trip={trip} />
          ))}
        </div>
      )}
    </div>
  );
}

function TripCard({ trip }: { trip: Trip }) {
  const statusColors = {
    draft: 'bg-slate-600',
    planned: 'bg-blue-500',
    active: 'bg-tarmoto-cyan',
    completed: 'bg-quality-excellent',
  };

  return (
    <Link
      href={`/trips/${trip.id}`}
      className="group rounded-2xl bg-slate-900 border border-slate-800 hover:border-slate-700 p-5 transition"
    >
      <div className="flex items-start justify-between mb-3">
        <h3 className="font-semibold text-white group-hover:text-tarmoto-cyan transition">
          {trip.name}
        </h3>
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium text-white ${statusColors[trip.status]}`}>
          {trip.status}
        </span>
      </div>

      <div className="space-y-2 text-sm text-slate-400">
        <div className="flex items-center gap-2">
          <Calendar size={14} />
          <span>{trip.days.length} days</span>
        </div>
        <div className="flex items-center gap-2">
          <MapPin size={14} />
          <span>{trip.days.reduce((sum, d) => sum + d.distanceKm, 0)} km total</span>
        </div>
        {trip.collaborators.length > 1 && (
          <div className="flex items-center gap-2">
            <Users size={14} />
            <span>{trip.collaborators.length} riders</span>
          </div>
        )}
      </div>
    </Link>
  );
}
