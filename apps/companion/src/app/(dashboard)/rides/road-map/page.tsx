"use client";

import { MapPin } from 'lucide-react';

/**
 * RoadMapPage — Personal road map (ridden vs unridden)
 *
 * TODO: Fetch /rides/road-map from API
 * TODO: MapLibre full-screen with ridden roads highlighted in tarmoto-cyan
 * TODO: Exploration percentage per region
 * TODO: Nearby unridden roads suggestions
 * TODO: Share exploration stats as image
 */

export default function RoadMapPage() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
        <div>
          <h1 className="text-xl font-bold">My Road Map</h1>
          <p className="text-sm text-slate-400 mt-0.5">Every road you&apos;ve ridden</p>
        </div>
        <div className="px-4 py-2 rounded-xl bg-tarmoto-cyan/10 text-tarmoto-cyan font-semibold text-sm">
          0% explored
        </div>
      </div>

      <div className="flex-1 relative bg-slate-900">
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <MapPin size={64} className="mx-auto text-slate-700 mb-4" />
            <p className="text-slate-500 text-lg font-medium">Personal Road Map</p>
            <p className="text-slate-600 text-sm mt-1">
              Ridden roads highlighted • Exploration stats • Unridden suggestions
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
