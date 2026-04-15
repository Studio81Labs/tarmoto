"use client";

import { useState } from 'react';
import { Users, Search, TrendingUp, Clock, MapPin } from 'lucide-react';

/**
 * CommunityFeedPage — Browse shared routes and rides
 *
 * TODO: Fetch /community/feed from API
 * TODO: Route/ride cards with mini-map preview
 * TODO: Filter by region, distance, curviness, quality, popularity
 * TODO: Sort by newest, most popular, highest rated, nearest
 */

export default function CommunityFeedPage() {
  const [sort, setSort] = useState<'newest' | 'popular' | 'rated' | 'nearest'>('popular');

  return (
    <div className="p-6 max-w-6xl mx-auto animate-fade-in">
      <h1 className="text-2xl font-bold mb-6">Community</h1>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            placeholder="Search routes, riders, regions..."
            className="w-full pl-9 pr-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan transition"
          />
        </div>
        <div className="flex items-center gap-1">
          {([
            { key: 'popular', icon: TrendingUp, label: 'Popular' },
            { key: 'newest', icon: Clock, label: 'Newest' },
            { key: 'nearest', icon: MapPin, label: 'Nearest' },
          ] as const).map((opt) => (
            <button
              key={opt.key}
              onClick={() => setSort(opt.key)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition ${
                sort === opt.key ? 'bg-tarmoto-cyan/10 text-tarmoto-cyan' : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              <opt.icon size={14} /> {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Empty state */}
      <div className="rounded-2xl bg-slate-900 border border-slate-800 p-16 text-center">
        <Users size={48} className="mx-auto text-slate-600 mb-4" />
        <p className="text-slate-400 text-lg mb-2">Community is growing</p>
        <p className="text-slate-500 text-sm">Shared routes and rides from the community will appear here.</p>
      </div>
    </div>
  );
}
