"use client";

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Download, Share2 } from 'lucide-react';

/**
 * RideDetailPage
 *
 * TODO: Fetch ride from API with route geometry
 * TODO: MapLibre map with ride track (color-coded by road quality)
 * TODO: Recharts: elevation profile, speed graph
 * TODO: Road quality breakdown donut chart
 * TODO: Stats summary card
 * TODO: Photo gallery
 */

export default function RideDetailPage() {
  const { rideId } = useParams<{ rideId: string }>();
  void rideId; // Used when detail view is implemented

  return (
    <div className="p-6 max-w-6xl mx-auto animate-fade-in">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/rides" className="p-2 rounded-lg hover:bg-slate-800 transition">
          <ArrowLeft size={20} className="text-slate-400" />
        </Link>
        <h1 className="text-2xl font-bold flex-1">Ride Detail</h1>
        <button className="p-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 transition">
          <Share2 size={16} />
        </button>
        <button className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition">
          <Download size={14} /> Export GPX
        </button>
      </div>

      {/* Map */}
      <div className="rounded-2xl bg-slate-900 border border-slate-800 h-80 mb-6 flex items-center justify-center">
        <p className="text-slate-500">Ride route map with quality color coding</p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Distance', value: '—', unit: 'km' },
          { label: 'Duration', value: '—', unit: '' },
          { label: 'Avg Speed', value: '—', unit: 'km/h' },
          { label: 'Elevation', value: '—', unit: 'm' },
        ].map((stat) => (
          <div key={stat.label} className="p-4 rounded-xl bg-slate-900 border border-slate-800">
            <p className="text-xs text-slate-500 mb-1">{stat.label}</p>
            <p className="text-xl font-bold text-white">
              {stat.value} <span className="text-sm font-normal text-slate-400">{stat.unit}</span>
            </p>
          </div>
        ))}
      </div>

      {/* Charts placeholder */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl bg-slate-900 border border-slate-800 h-48 flex items-center justify-center">
          <p className="text-slate-500 text-sm">Elevation profile chart</p>
        </div>
        <div className="rounded-xl bg-slate-900 border border-slate-800 h-48 flex items-center justify-center">
          <p className="text-slate-500 text-sm">Road quality breakdown</p>
        </div>
      </div>
    </div>
  );
}
