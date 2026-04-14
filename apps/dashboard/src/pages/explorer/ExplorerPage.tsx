import { useState } from 'react';
import { useMapStore } from '@/stores/mapStore';
import { Layers, Filter, Search } from 'lucide-react';

/**
 * ExplorerPage — Full-screen road quality map explorer
 *
 * Layout:
 * ┌───────────────────────────────────────────────┐
 * │ Search bar + filter toggles                   │
 * ├──────────┬────────────────────────────────────┤
 * │ Filter   │                                    │
 * │ Panel    │        MapLibre GL JS              │
 * │ (quality,│     Road quality heatmap           │
 * │  surface,│     Hazard markers                 │
 * │  curves) │     Click segment → detail panel   │
 * │          │                                    │
 * └──────────┴────────────────────────────────────┘
 *
 * TODO: MapLibre GL JS integration
 * TODO: Vector tile road quality layer
 * TODO: Segment detail slide-out panel
 * TODO: Hazard markers with clustering
 */

const QUALITY_OPTIONS = [
  { key: 'excellent', label: 'Excellent', color: 'bg-quality-excellent' },
  { key: 'good', label: 'Good', color: 'bg-quality-good' },
  { key: 'fair', label: 'Fair', color: 'bg-quality-fair' },
  { key: 'poor', label: 'Poor', color: 'bg-quality-poor' },
  { key: 'very-poor', label: 'Very Poor', color: 'bg-quality-very-poor' },
];

const SURFACE_OPTIONS = [
  { key: 'asphalt', label: 'Asphalt', color: 'bg-surface-asphalt' },
  { key: 'concrete', label: 'Concrete', color: 'bg-surface-concrete' },
  { key: 'cobblestone', label: 'Cobblestone', color: 'bg-surface-cobblestone' },
  { key: 'gravel', label: 'Gravel', color: 'bg-surface-gravel' },
  { key: 'dirt', label: 'Dirt', color: 'bg-surface-dirt' },
];

export function ExplorerPage() {
  const [filterOpen, setFilterOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const {
    showQualityOverlay, showHazardOverlay, showSurfaceOverlay,
    toggleQuality, toggleHazards, toggleSurface,
  } = useMapStore();

  return (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800">
        <div className="relative flex-1 max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search roads, regions..."
            className="w-full pl-9 pr-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan transition"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setFilterOpen(!filterOpen)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition ${
              filterOpen ? 'bg-tarmoto-cyan/10 text-tarmoto-cyan' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            <Filter size={14} /> Filters
          </button>

          <button
            onClick={toggleQuality}
            className={`px-3 py-2 rounded-lg text-sm transition ${
              showQualityOverlay ? 'bg-quality-good/10 text-quality-good' : 'bg-slate-800 text-slate-400'
            }`}
          >
            Quality
          </button>

          <button
            onClick={toggleHazards}
            className={`px-3 py-2 rounded-lg text-sm transition ${
              showHazardOverlay ? 'bg-red-500/10 text-red-400' : 'bg-slate-800 text-slate-400'
            }`}
          >
            Hazards
          </button>

          <button
            onClick={toggleSurface}
            className={`px-3 py-2 rounded-lg text-sm transition ${
              showSurfaceOverlay ? 'bg-blue-500/10 text-blue-400' : 'bg-slate-800 text-slate-400'
            }`}
          >
            Surface
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Filter panel */}
        {filterOpen && (
          <div className="w-64 border-r border-slate-800 bg-slate-950 overflow-y-auto p-4 space-y-6 animate-slide-in-right">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">Road quality</h3>
              <div className="space-y-2">
                {QUALITY_OPTIONS.map((opt) => (
                  <label key={opt.key} className="flex items-center gap-2.5 text-sm text-slate-300 cursor-pointer">
                    <input type="checkbox" defaultChecked className="rounded border-slate-600 bg-slate-800 text-tarmoto-cyan focus:ring-tarmoto-cyan" />
                    <span className={`w-2.5 h-2.5 rounded-full ${opt.color}`} />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">Surface type</h3>
              <div className="space-y-2">
                {SURFACE_OPTIONS.map((opt) => (
                  <label key={opt.key} className="flex items-center gap-2.5 text-sm text-slate-300 cursor-pointer">
                    <input type="checkbox" defaultChecked className="rounded border-slate-600 bg-slate-800 text-tarmoto-cyan focus:ring-tarmoto-cyan" />
                    <span className={`w-2.5 h-2.5 rounded-full ${opt.color}`} />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">Curviness</h3>
              <input
                type="range"
                min={0}
                max={100}
                defaultValue={0}
                className="w-full accent-tarmoto-cyan"
              />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>Straight</span>
                <span>Very twisty</span>
              </div>
            </div>
          </div>
        )}

        {/* Map */}
        <div className="flex-1 relative bg-slate-900">
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <Layers size={64} className="mx-auto text-slate-700 mb-4" />
              <p className="text-slate-500 text-lg font-medium">Road Quality Explorer</p>
              <p className="text-slate-600 text-sm mt-1">
                MapLibre GL JS • Quality heatmap • Hazard markers • Click any segment for details
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
