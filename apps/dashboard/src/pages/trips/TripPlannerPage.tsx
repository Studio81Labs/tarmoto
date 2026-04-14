import { useState } from 'react';
import { useTripStore } from '@/stores/tripStore';
import {
  Layers,
  Sliders,
  Users,
  Download,
  Upload,
  Sparkles,
  ChevronRight,
  GripVertical,
} from 'lucide-react';

/**
 * TripPlannerPage — Full-screen map-based trip planner
 *
 * Layout:
 * ┌─────────────────────────────────────────────────────┐
 * │ Toolbar: [Generate] [Import] [Export] [Collaborate] │
 * ├──────────┬──────────────────────────────────────────┤
 * │ Params   │                                          │
 * │ Panel    │           MapLibre GL JS                  │
 * │          │        (full-screen map)                  │
 * │──────────│                                          │
 * │ Segment  │     Road quality heatmap overlay         │
 * │ Sidebar  │     Fun Zone clusters                    │
 * │ (Road    │     Draggable waypoints                  │
 * │ Preview  │                                          │
 * │ Cards)   │                                          │
 * ├──────────┴──────────────────────────────────────────┤
 * │ Timeline strip: Day 1 | Day 2 | Day 3 | ...        │
 * └─────────────────────────────────────────────────────┘
 *
 * TODO: Integrate MapLibre GL JS with draw controls
 * TODO: Connect to /trips/generate endpoint
 * TODO: WebSocket collaboration (cursor sync, live edits)
 */

export function TripPlannerPage() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [paramsOpen, setParamsOpen] = useState(true);
  const activeTrip = useTripStore((s) => s.activeTrip);
  const isGenerating = useTripStore((s) => s.isGenerating);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-950/90 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold mr-4">
            {activeTrip?.name ?? 'New Trip'}
          </h1>
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-tarmoto-cyan text-slate-950 text-sm font-semibold hover:bg-tarmoto-cyan-light transition">
            <Sparkles size={14} />
            Generate
          </button>
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition">
            <Upload size={14} />
            Import GPX
          </button>
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition">
            <Download size={14} />
            Export
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setParamsOpen(!paramsOpen)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition"
          >
            <Sliders size={14} />
            Parameters
          </button>
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition">
            <Users size={14} />
            Collaborate
          </button>
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition"
          >
            <Layers size={14} />
            Segments
          </button>
        </div>
      </div>

      {/* Main area */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Parameters panel (left, collapsible) */}
        {paramsOpen && (
          <div className="w-72 border-r border-slate-800 bg-slate-950 overflow-y-auto p-4 space-y-4 animate-slide-in-right">
            <h3 className="text-sm font-semibold text-slate-300">Trip parameters</h3>

            <div>
              <label className="block text-xs text-slate-500 mb-1">Number of days</label>
              <input
                type="number"
                min={1}
                max={14}
                defaultValue={3}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-tarmoto-cyan transition"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-500 mb-1">Daily km target</label>
              <input
                type="number"
                min={50}
                max={500}
                step={25}
                defaultValue={250}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-tarmoto-cyan transition"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-500 mb-1">Road preference</label>
              <select className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-tarmoto-cyan transition">
                <option value="curvy">Maximum curviness</option>
                <option value="scenic">Scenic roads</option>
                <option value="mixed" selected>Mixed (balanced)</option>
                <option value="direct">Direct / efficient</option>
              </select>
            </div>

            <div>
              <label className="block text-xs text-slate-500 mb-1">Minimum road quality</label>
              <select className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-tarmoto-cyan transition">
                <option value="1">Any condition</option>
                <option value="2">Fair or better</option>
                <option value="3" selected>Good or better</option>
                <option value="4">Excellent only</option>
              </select>
            </div>

            <div className="space-y-2 pt-2">
              <label className="flex items-center gap-2 text-sm text-slate-400">
                <input type="checkbox" defaultChecked className="rounded border-slate-600 bg-slate-800 text-tarmoto-cyan focus:ring-tarmoto-cyan" />
                Avoid highways
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-400">
                <input type="checkbox" className="rounded border-slate-600 bg-slate-800 text-tarmoto-cyan focus:ring-tarmoto-cyan" />
                Avoid tolls
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-400">
                <input type="checkbox" defaultChecked className="rounded border-slate-600 bg-slate-800 text-tarmoto-cyan focus:ring-tarmoto-cyan" />
                Avoid unpaved roads
              </label>
            </div>
          </div>
        )}

        {/* Map canvas */}
        <div className="flex-1 relative bg-slate-900">
          {/* MapLibre GL JS will mount here */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <Map size={64} className="mx-auto text-slate-700 mb-4" />
              <p className="text-slate-500 text-lg font-medium">MapLibre GL JS</p>
              <p className="text-slate-600 text-sm mt-1">
                Road quality heatmap • Fun Zone clusters • Draggable waypoints
              </p>
            </div>
          </div>

          {/* Generating overlay */}
          {isGenerating && (
            <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center z-20">
              <div className="text-center">
                <div className="w-12 h-12 mx-auto mb-4 border-2 border-tarmoto-cyan/30 border-t-tarmoto-cyan rounded-full animate-spin" />
                <p className="text-white font-medium">Generating your route...</p>
                <p className="text-slate-400 text-sm mt-1">Finding the best roads for you</p>
              </div>
            </div>
          )}
        </div>

        {/* Segment sidebar (right, collapsible) */}
        {sidebarOpen && (
          <div className="w-80 border-l border-slate-800 bg-slate-950 overflow-y-auto animate-slide-in-right">
            <div className="p-4 border-b border-slate-800">
              <h3 className="text-sm font-semibold text-slate-300">Road Preview Cards</h3>
              <p className="text-xs text-slate-500 mt-1">Each segment of your route</p>
            </div>

            {/* Empty state */}
            <div className="p-8 text-center">
              <GripVertical size={32} className="mx-auto text-slate-700 mb-3" />
              <p className="text-slate-500 text-sm">
                Add waypoints on the map or generate a route to see segment previews.
              </p>
            </div>

            {/* TODO: Road Preview Card components
              Each card shows:
              - Segment name + distance
              - Quality score badge (1-5)
              - Curviness rating
              - Elevation mini-chart
              - Photo thumbnails
              - Active hazard count
              - Expand for full detail
            */}
          </div>
        )}
      </div>

      {/* Timeline strip */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-800 bg-slate-950/90 overflow-x-auto">
        {(activeTrip?.days ?? [{ dayNumber: 1 }, { dayNumber: 2 }, { dayNumber: 3 }]).map(
          (day: any) => (
            <button
              key={day.dayNumber}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 text-sm text-slate-300 hover:bg-slate-700 whitespace-nowrap transition"
            >
              Day {day.dayNumber}
              {day.distanceKm && (
                <span className="text-xs text-slate-500">{day.distanceKm} km</span>
              )}
              <ChevronRight size={14} className="text-slate-500" />
            </button>
          ),
        )}
        <button className="px-3 py-2 rounded-lg border border-dashed border-slate-700 text-sm text-slate-500 hover:text-slate-300 hover:border-slate-600 transition">
          + Add day
        </button>
      </div>
    </div>
  );
}

// Placeholder for lucide icon used in map
function Map({ size, className }: { size: number; className: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z" />
      <path d="M8 2v16" />
      <path d="M16 6v16" />
    </svg>
  );
}
