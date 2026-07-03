"use client";
import { SURFACE_COLORS } from "@/components/map/MapCanvas";
import type { RouteQualitySummary } from "@/lib/planner/types";

/**
 * Surface mix: thin stacked bar + legend (design: Inspect § 02). Colors
 * come from the map's surface palette so the bar matches the
 * surface-colored route line.
 */
export function SurfaceMixBar({
  mix,
}: {
  mix: RouteQualitySummary["surfaceMix"];
}) {
  if (mix.length === 0) return null;
  return (
    <div>
      <div className="mb-2.5 flex h-1.5 overflow-hidden rounded-[3px]">
        {mix.map((entry) => (
          <div
            key={entry.surface}
            style={{
              flexGrow: entry.pct,
              flexBasis: 0,
              background:
                SURFACE_COLORS[entry.surface] ?? SURFACE_COLORS.unknown,
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {mix.map((entry) => (
          <span key={entry.surface} className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-sm"
              style={{
                background:
                  SURFACE_COLORS[entry.surface] ?? SURFACE_COLORS.unknown,
              }}
            />
            <span className="text-[11.5px] text-fg-dim">
              <b className="font-bold text-ink">{entry.pct}%</b> {entry.surface}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
