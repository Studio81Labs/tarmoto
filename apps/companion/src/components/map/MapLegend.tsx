"use client";
import { t } from "@/i18n";
import { SURFACE_COLORS } from "@/components/map/MapCanvas";
import { CONDITION_COLORS } from "@/lib/conditions-visual";
import { HAZARD_CONFIG, HAZARD_TYPES_UI, SURFACE_LABELS } from "@/lib/utils";
import type { EnglishMessageKey } from "@/i18n";

const SURFACE_KEYS = Object.keys(
  SURFACE_COLORS,
) as (keyof typeof SURFACE_COLORS)[];

/**
 * One legend for every map (explorer, planner, preview). Each active overlay is
 * its OWN cream card, stacked in the bottom-left (matching the planner's split
 * layout): quality/surface as line swatches, conditions + hazards as the
 * rotated "diamond" badges that match the markers. Surface, conditions, and
 * hazards are identical everywhere (shared constants); quality is passed in
 * because each map colours roads on its own scale (the explorer's 5 tiles vs
 * the planner's 4 route bands).
 */

/** A quality swatch — the label + the exact line colour the map paints. */
export interface QualityLegendEntry {
  label: EnglishMessageKey;
  color: string;
}

export interface MapLegendProps {
  /** Quality swatches for the active scale, or omit to hide the section. */
  quality?: readonly QualityLegendEntry[];
  /** Surface swatches (shared SURFACE_COLORS). */
  surface?: boolean;
  /** Condition diamonds (roadworks / closures / seasonal pass). */
  conditions?: boolean;
  /** Hazard diamonds (all reported hazard types). */
  hazards?: boolean;
}

const CONDITION_LEGEND: readonly [color: string, label: EnglishMessageKey][] = [
  [CONDITION_COLORS.roadworks, "Roadworks"],
  [CONDITION_COLORS["closure-full"], "Full closure"],
  [CONDITION_COLORS["closure-partial"], "Partial closure"],
  [CONDITION_COLORS.pass, "Seasonal pass"],
];

function LineSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden
        className="h-1 w-3.5 rounded-sm"
        style={{ background: color }}
      />
      <span className="text-[11px] font-semibold text-fg-dim">{label}</span>
    </span>
  );
}

function DiamondSwatch({
  color,
  label,
  emoji,
}: {
  color: string;
  label: string;
  emoji?: string;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border-2 bg-cream"
        style={{ borderColor: color, transform: "rotate(45deg)" }}
      >
        {emoji ? (
          <span
            className="text-[8px] leading-none"
            style={{ transform: "rotate(-45deg)" }}
          >
            {emoji}
          </span>
        ) : null}
      </span>
      <span className="text-[11px] text-fg-dim">{label}</span>
    </span>
  );
}

/** One cream card holding a horizontal row of labelled swatches. */
function LegendCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none flex max-w-[440px] flex-wrap items-center gap-x-3.5 gap-y-2.5 rounded-[10px] border border-line-strong bg-cream/90 px-3.5 py-2.5 shadow-[0_4px_12px_rgba(14,14,16,0.12)] backdrop-blur-sm">
      {children}
    </div>
  );
}

export function MapLegend({
  quality,
  surface,
  conditions,
  hazards,
}: MapLegendProps) {
  const hasQuality = quality != null && quality.length > 0;
  if (!hasQuality && !surface && !conditions && !hazards) return null;
  return (
    <div className="pointer-events-none absolute bottom-8 left-3 z-10 flex flex-col items-start gap-2">
      {hasQuality ? (
        <LegendCard>
          {quality.map((entry) => (
            <LineSwatch
              key={entry.label}
              color={entry.color}
              label={t(entry.label)}
            />
          ))}
        </LegendCard>
      ) : null}
      {surface ? (
        <LegendCard>
          {/* Every surface the maps can paint, incl. `unknown` (grey) — the
              planner route + explorer overlay both colour unknown segments. */}
          {SURFACE_KEYS.map((surfaceKey) => (
            <LineSwatch
              key={surfaceKey}
              color={SURFACE_COLORS[surfaceKey]}
              label={t(SURFACE_LABELS[surfaceKey])}
            />
          ))}
        </LegendCard>
      ) : null}
      {conditions ? (
        <LegendCard>
          {CONDITION_LEGEND.map(([color, label]) => (
            <DiamondSwatch key={label} color={color} label={t(label)} />
          ))}
        </LegendCard>
      ) : null}
      {hazards ? (
        <LegendCard>
          {HAZARD_TYPES_UI.map((type) => (
            <DiamondSwatch
              key={type}
              color={HAZARD_CONFIG[type].hex}
              label={t(HAZARD_CONFIG[type].label)}
              emoji={HAZARD_CONFIG[type].emoji}
            />
          ))}
        </LegendCard>
      ) : null}
    </div>
  );
}
