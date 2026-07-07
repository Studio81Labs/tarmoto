"use client";
import { Mono } from "@tarmoto/ui";
import {
  coalesceQualityRuns,
  QUALITY_BAND_COLORS,
  QUALITY_BAND_LABELS,
} from "@/lib/planner/quality-bands";
import type { QualityBand, RouteSegment } from "@/lib/planner/types";

/**
 * Road-quality-along-route strip: the day's quality segments laid out
 * horizontally by length. Every section is clickable and opens its Road
 * Preview (design: Inspect § 01).
 */
interface RouteQualityStripProps {
  segments: RouteSegment[];
  startLabel?: string | undefined;
  endLabel?: string | undefined;
  onSegmentClick?: (segmentId: string) => void;
}

export function RouteQualityStrip({
  segments,
  startLabel,
  endLabel,
  onSegmentClick,
}: RouteQualityStripProps) {
  if (segments.length === 0) return null;
  const totalKm = segments.reduce((sum, s) => sum + s.lengthKm, 0);
  // Coalesce adjacent same-band segments so a long covered route (thousands of
  // ~100 m spans) renders a handful of band runs, not thousands of buttons.
  const runs = coalesceQualityRuns(segments);
  return (
    <div>
      <div className="flex h-4 overflow-hidden rounded-lg border border-line bg-paper">
        {runs.map((segment) => (
          <button
            key={segment.id}
            type="button"
            aria-label={`Preview ${QUALITY_BAND_LABELS[segment.band]} section, ${Math.round(segment.lengthKm * 10) / 10} km`}
            title={QUALITY_BAND_LABELS[segment.band]}
            onClick={() => onSegmentClick?.(segment.id)}
            className="h-full border-r border-ink/20 transition last:border-r-0 hover:brightness-95"
            style={{
              flexGrow: Math.max(segment.lengthKm, 0.01),
              flexBasis: 0,
              background: QUALITY_BAND_COLORS[segment.band],
              cursor: onSegmentClick ? "pointer" : "default",
            }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between">
        <Mono className="text-[9.5px] text-fg-mute">
          {(startLabel ?? "START").toUpperCase()} · 0 KM
        </Mono>
        <Mono className="text-[9.5px] text-fg-mute">
          {(endLabel ?? "FINISH").toUpperCase()} · {Math.round(totalKm)} KM
        </Mono>
      </div>
      <div className="mt-3 flex flex-wrap gap-3">
        {(Object.entries(QUALITY_BAND_LABELS) as [QualityBand, string][]).map(
          ([band, label]) => (
            <span key={band} className="flex items-center gap-1.5">
              <span
                className="h-[9px] w-[9px] rounded-sm"
                style={{ background: QUALITY_BAND_COLORS[band] }}
              />
              <span className="text-[11px] text-fg-dim">{label}</span>
            </span>
          ),
        )}
      </div>
    </div>
  );
}
