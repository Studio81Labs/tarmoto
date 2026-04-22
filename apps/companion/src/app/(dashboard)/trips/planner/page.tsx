"use client";

import { useCallback, useMemo, useState } from "react";
import { useTripStore } from "@/stores/trip";
import {
  Layers,
  Sliders,
  Users,
  Upload,
  Sparkles,
  ChevronRight,
  FileUp,
} from "lucide-react";
import { ClosuresPanel } from "@/components/ClosuresPanel";
import { PassesPanel } from "@/components/PassesPanel";
import { SegmentSidebar } from "@/components/SegmentSidebar";
import { TripStopsPanel } from "@/components/TripStopsPanel";
import { TripExportMenu } from "@/components/TripExportMenu";
import { TripImportDialog } from "@/components/TripImportDialog";
import { buildTripClosureRoutes } from "@/lib/closures-summary";
import { DEMO_TRIP } from "@/lib/demo-trip";
import { currentUtcMonth } from "@/lib/passes-summary";

/**
 * TripPlannerPage — Full-screen map-based trip planner
 *
 * TODO: Integrate MapLibre GL JS with draw controls (#79)
 * TODO: Connect to /trips/generate endpoint (US-34)
 * TODO: WebSocket collaboration (cursor sync, live edits) (US-35)
 */

export default function TripPlannerPage() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [paramsOpen, setParamsOpen] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [travelMonth, setTravelMonth] = useState<number>(() =>
    currentUtcMonth(),
  );
  const activeTrip = useTripStore((s) => s.activeTrip);
  const setActiveTrip = useTripStore((s) => s.setActiveTrip);
  const isGenerating = useTripStore((s) => s.isGenerating);
  const closureRoutes = useMemo(
    () => buildTripClosureRoutes(activeTrip),
    [activeTrip],
  );

  const openImport = useCallback((file: File | null = null) => {
    setPendingImportFile(file);
    setImportOpen(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Only clear if leaving the drop target, not bubbling from children.
    if (e.currentTarget === e.target) setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = Array.from(e.dataTransfer.files).find((f) =>
        /\.(gpx|kml)$/i.test(f.name),
      );
      if (file) openImport(file);
    },
    [openImport],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-950/90 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold mr-4">
            {activeTrip?.name ?? "New Trip"}
          </h1>
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-tarmoto-cyan text-slate-950 text-sm font-semibold hover:bg-tarmoto-cyan-light transition">
            <Sparkles size={14} />
            Generate
          </button>
          <button
            type="button"
            onClick={() => openImport()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition"
          >
            <Upload size={14} />
            Import GPX
          </button>
          <TripExportMenu trip={activeTrip} />
          {!activeTrip && (
            <button
              type="button"
              onClick={() => setActiveTrip(DEMO_TRIP)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-slate-700 text-slate-400 text-sm hover:text-white hover:border-slate-500 transition"
            >
              Load demo trip
            </button>
          )}
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
            aria-pressed={sidebarOpen}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition ${
              sidebarOpen
                ? "bg-tarmoto-cyan/10 text-tarmoto-cyan"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
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
            <h3 className="text-sm font-semibold text-slate-300">
              Trip parameters
            </h3>

            <div>
              <label className="block text-xs text-slate-500 mb-1">
                Number of days
              </label>
              <input
                type="number"
                min={1}
                max={14}
                defaultValue={3}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-tarmoto-cyan transition"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-500 mb-1">
                Daily km target
              </label>
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
              <label className="block text-xs text-slate-500 mb-1">
                Road preference
              </label>
              <select className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-tarmoto-cyan transition">
                <option value="curvy">Maximum curviness</option>
                <option value="scenic">Scenic roads</option>
                <option value="mixed" defaultValue="mixed">
                  Mixed (balanced)
                </option>
                <option value="direct">Direct / efficient</option>
              </select>
            </div>

            <div>
              <label className="block text-xs text-slate-500 mb-1">
                Minimum road quality
              </label>
              <select className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-tarmoto-cyan transition">
                <option value="1">Any condition</option>
                <option value="2">Fair or better</option>
                <option value="3" defaultValue="3">
                  Good or better
                </option>
                <option value="4">Excellent only</option>
              </select>
            </div>

            <div className="space-y-2 pt-2">
              <label className="flex items-center gap-2 text-sm text-slate-400">
                <input
                  type="checkbox"
                  defaultChecked
                  className="rounded border-slate-600 bg-slate-800 text-tarmoto-cyan focus:ring-tarmoto-cyan"
                />
                Avoid highways
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-400">
                <input
                  type="checkbox"
                  className="rounded border-slate-600 bg-slate-800 text-tarmoto-cyan focus:ring-tarmoto-cyan"
                />
                Avoid tolls
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-400">
                <input
                  type="checkbox"
                  defaultChecked
                  className="rounded border-slate-600 bg-slate-800 text-tarmoto-cyan focus:ring-tarmoto-cyan"
                />
                Avoid unpaved roads
              </label>
            </div>
            <PassesPanel
              month={travelMonth}
              onMonthChange={setTravelMonth}
              routes={closureRoutes}
            />
            <ClosuresPanel month={travelMonth} routes={closureRoutes} />
            <TripStopsPanel trip={activeTrip} />
          </div>
        )}

        {/* Map canvas */}
        <div
          className="flex-1 relative bg-slate-900"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* MapLibre GL JS will mount here */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <MapIcon size={64} className="mx-auto text-slate-700 mb-4" />
              <p className="text-slate-500 text-lg font-medium">
                MapLibre GL JS
              </p>
              <p className="text-slate-600 text-sm mt-1">
                Road quality heatmap • Fun Zone clusters • Draggable waypoints
              </p>
              <p className="text-slate-600 text-xs mt-3">
                Drop a GPX or KML file here to import a route
              </p>
            </div>
          </div>

          {/* Drop overlay */}
          {isDragOver && (
            <div
              aria-hidden
              className="absolute inset-4 rounded-2xl border-2 border-dashed border-tarmoto-cyan bg-tarmoto-cyan/10 flex items-center justify-center pointer-events-none z-10"
            >
              <div className="text-center">
                <FileUp size={40} className="mx-auto text-tarmoto-cyan mb-2" />
                <p className="text-tarmoto-cyan font-semibold">
                  Drop to import GPX or KML
                </p>
              </div>
            </div>
          )}

          {/* Generating overlay */}
          {isGenerating && (
            <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center z-20">
              <div className="text-center">
                <div className="w-12 h-12 mx-auto mb-4 border-2 border-tarmoto-cyan/30 border-t-tarmoto-cyan rounded-full animate-spin" />
                <p className="text-white font-medium">
                  Generating your route...
                </p>
                <p className="text-slate-400 text-sm mt-1">
                  Finding the best roads for you
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Segment sidebar (right, collapsible) — Road Preview Cards (US-33) */}
        {sidebarOpen && <SegmentSidebar />}
      </div>

      {/* Timeline strip */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-800 bg-slate-950/90 overflow-x-auto">
        {(
          activeTrip?.days ?? [
            { dayNumber: 1 },
            { dayNumber: 2 },
            { dayNumber: 3 },
          ]
        ).map((day: { dayNumber: number; distanceKm?: number }) => (
          <button
            key={day.dayNumber}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 text-sm text-slate-300 hover:bg-slate-700 whitespace-nowrap transition"
          >
            Day {day.dayNumber}
            {day.distanceKm && (
              <span className="text-xs text-slate-500">
                {day.distanceKm} km
              </span>
            )}
            <ChevronRight size={14} className="text-slate-500" />
          </button>
        ))}
        <button className="px-3 py-2 rounded-lg border border-dashed border-slate-700 text-sm text-slate-500 hover:text-slate-300 hover:border-slate-600 transition">
          + Add day
        </button>
      </div>

      <TripImportDialog
        open={importOpen}
        initialFile={pendingImportFile}
        onClose={() => {
          setImportOpen(false);
          setPendingImportFile(null);
        }}
      />
    </div>
  );
}

// Placeholder for map icon used in canvas
function MapIcon({ size, className }: { size: number; className: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={className}
    >
      <path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z" />
      <path d="M8 2v16" />
      <path d="M16 6v16" />
    </svg>
  );
}
