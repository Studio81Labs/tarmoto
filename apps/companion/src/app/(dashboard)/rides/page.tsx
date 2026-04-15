"use client";

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { ridesApi } from '@/lib/api';
import { History, Calendar, MapPin, Gauge, ChevronRight } from 'lucide-react';
import type { Ride, QualityTier } from '@/lib/types';

const QUALITY_COLORS: Record<QualityTier, string> = {
  excellent: 'text-quality-excellent',
  good: 'text-quality-good',
  fair: 'text-quality-fair',
  poor: 'text-quality-poor',
  'very-poor': 'text-quality-very-poor',
};

export default function RideListPage() {
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    ridesApi.list().then(({ data }) => {
      setRides(data.data ?? []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-6xl mx-auto animate-fade-in">
      <h1 className="text-2xl font-bold mb-6">Ride History</h1>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 rounded-xl bg-slate-900 border border-slate-800 animate-pulse" />
          ))}
        </div>
      ) : rides.length === 0 ? (
        <div className="rounded-2xl bg-slate-900 border border-slate-800 p-16 text-center">
          <History size={48} className="mx-auto text-slate-600 mb-4" />
          <p className="text-slate-400 text-lg mb-2">No rides recorded yet</p>
          <p className="text-slate-500 text-sm">Start riding with the Tarmoto mobile app to see your history here.</p>
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
                  {ride.name ?? `Ride on ${new Date(ride.startedAt).toLocaleDateString()}`}
                </p>
                <div className="flex items-center gap-4 mt-1 text-sm text-slate-400">
                  <span className="flex items-center gap-1"><Calendar size={12} /> {new Date(ride.startedAt).toLocaleDateString()}</span>
                  <span className="flex items-center gap-1"><MapPin size={12} /> {ride.distanceKm.toFixed(1)} km</span>
                  <span className="flex items-center gap-1"><Gauge size={12} /> {ride.avgSpeedKmh.toFixed(0)} km/h avg</span>
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
