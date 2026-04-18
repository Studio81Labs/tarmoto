"use client";

import { useMemo, useState } from "react";
import { GripVertical, MapPin } from "lucide-react";
import { flattenSegments, useTripStore } from "@/stores/trip";
import { RoadPreviewCard } from "@/components/RoadPreviewCard";
import { formatDistance } from "@/lib/utils";

/**
 * Right-hand sidebar for the trip planner (US-33).
 * Renders one RoadPreviewCard per segment in the active trip, grouped by day.
 * Segment focus/hover is published into `trip` store so the future MapLibre
 * layer (#79) can zoom/highlight without coupling to this component.
 */
export function SegmentSidebar() {
  const activeTrip = useTripStore((s) => s.activeTrip);
  const focusedSegmentId = useTripStore((s) => s.focusedSegmentId);
  const hoveredSegmentId = useTripStore((s) => s.hoveredSegmentId);
  const focusSegment = useTripStore((s) => s.focusSegment);
  const hoverSegment = useTripStore((s) => s.hoverSegment);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const segments = useMemo(() => flattenSegments(activeTrip), [activeTrip]);
  const grouped = useMemo(() => {
    const map = new Map<number, typeof segments>();
    for (const seg of segments) {
      const bucket = map.get(seg.dayNumber) ?? [];
      bucket.push(seg);
      map.set(seg.dayNumber, bucket);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a - b);
  }, [segments]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <aside
      aria-label="Road preview cards"
      className="w-80 border-l border-slate-800 bg-slate-950 flex flex-col animate-slide-in-right"
    >
      <div className="p-4 border-b border-slate-800 shrink-0">
        <h3 className="text-sm font-semibold text-slate-300">
          Road Preview Cards
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          {segments.length > 0
            ? `${segments.length} segments across ${grouped.length} day${
                grouped.length === 1 ? "" : "s"
              }`
            : "Each segment of your route"}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {segments.length === 0 ? (
          <div className="p-8 text-center">
            <GripVertical size={32} className="mx-auto text-slate-700 mb-3" />
            <p className="text-slate-500 text-sm">
              Add waypoints on the map or generate a route to see segment
              previews.
            </p>
          </div>
        ) : (
          <div className="p-3 space-y-4">
            {grouped.map(([dayNumber, daySegments]) => {
              const dayDistance = daySegments.reduce(
                (sum, seg) => sum + seg.distanceKm,
                0,
              );
              return (
                <section key={dayNumber} className="space-y-2">
                  <header className="flex items-center justify-between px-1">
                    <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
                      <MapPin size={12} /> Day {dayNumber}
                    </h4>
                    <span className="text-[11px] text-slate-500 tabular-nums">
                      {formatDistance(dayDistance)}
                    </span>
                  </header>
                  <div className="space-y-2">
                    {daySegments.map((segment) => (
                      <RoadPreviewCard
                        key={segment.id}
                        segment={segment}
                        isFocused={focusedSegmentId === segment.id}
                        isHovered={hoveredSegmentId === segment.id}
                        isExpanded={expanded.has(segment.id)}
                        onFocus={() =>
                          focusSegment(
                            focusedSegmentId === segment.id ? null : segment.id,
                          )
                        }
                        onHoverStart={() => hoverSegment(segment.id)}
                        onHoverEnd={() => hoverSegment(null)}
                        onToggleExpand={() => toggleExpand(segment.id)}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
