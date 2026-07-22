"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { useMemo, useState } from "react";
import { GripVertical, MapPin } from "lucide-react";
import { flattenSegments, useTripStore } from "@/stores/trip";
import { RoadPreviewCard } from "@/components/RoadPreviewCard";
import { useFormat } from "@/format/FormatProvider";
import { Stamp } from "@tarmoto/ui";
/**
 * "Road preview cards" list for the trip detail panel.
 * Renders one RoadPreviewCard per segment in the active trip, grouped by day.
 * Segment focus/hover is published into `trip` store so the map layer can
 * zoom/highlight without coupling to this component.
 */
export function SegmentSidebar() {
  const t = useTranslation();
  const format = useFormat();
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
      aria-label={t("Road preview cards")}
      className="flex w-full flex-col animate-slide-in-right"
    >
      <div className="shrink-0 p-4 pb-0">
        <Stamp as="h3">{t("Road preview cards")}</Stamp>
        <p className="mt-1 text-xs text-fg-dim">
          {segments.length > 0
            ? t("Tap a segment to preview it on the map")
            : t("Each segment of your route")}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {segments.length === 0 ? (
          <div className="p-8 text-center">
            <GripVertical size={32} className="mx-auto mb-3 text-fg-faint" />
            <p className="text-sm text-fg-dim">
              {t(
                "Add waypoints on the map or generate a route to see segment previews.",
              )}
            </p>
          </div>
        ) : (
          <div className="space-y-4 p-4 pt-3">
            {grouped.map(([dayNumber, daySegments]) => {
              const dayDistance = daySegments.reduce(
                (sum, seg) => sum + seg.distanceKm,
                0,
              );
              return (
                <section key={dayNumber} className="space-y-2">
                  <header className="flex items-center justify-between px-1">
                    <h4 className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-[1.2px] text-fg-mute">
                      <MapPin size={11} />
                      {t("Day {day}", { day: dayNumber })}
                    </h4>
                    <span className="font-mono text-[10px] tabular-nums text-fg-mute">
                      {format.distanceKm(dayDistance)}
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
