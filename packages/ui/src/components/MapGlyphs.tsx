/**
 * Map glyphs · the SVG vocabulary that paints Tarmoto's maps.
 * Spec: §17 Map vocabulary in Web App v2 Design Map.
 *
 * Every map point is one of six primitives. Each renders into an inline
 * SVG that's stateless and accepts a `size` so callers can drop them
 * into legends, hover cards, or layer pickers without rewrapping them.
 */
import type { ReactNode } from "react";
import { palette, qualityColors } from "../tokens";

export interface MapGlyphProps {
  size?: number;
  className?: string;
}

/** Waypoint · ink circle + cream ring + single mono letter (A–Z). */
export function WaypointGlyph({
  size = 60,
  letter = "B",
  selected = false,
  hover = false,
  dragging = false,
  className,
}: MapGlyphProps & {
  letter?: string;
  selected?: boolean;
  hover?: boolean;
  dragging?: boolean;
}) {
  const fill = selected ? palette.accent : palette.ink;
  const ringStroke = selected ? palette.ink : palette.cream;
  const textFill = selected ? palette.ink : palette.cream;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 60 60"
      aria-hidden="true"
      className={className}
    >
      {hover && (
        <circle
          cx="30"
          cy="30"
          r="22"
          fill="none"
          stroke="#0E0E10"
          strokeOpacity="0.18"
        />
      )}
      <circle
        cx="30"
        cy="30"
        r="15"
        fill={fill}
        stroke={ringStroke}
        strokeWidth="2.5"
        strokeDasharray={dragging ? "3 2" : undefined}
      />
      <text
        x="30"
        y="34"
        textAnchor="middle"
        fill={textFill}
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        {letter}
      </text>
    </svg>
  );
}

/** Hazard pin · accent circle + cream ring + "!". */
export function HazardGlyph({
  size = 60,
  state = "unconfirmed",
  className,
}: MapGlyphProps & {
  state?: "unconfirmed" | "confirmed" | "resolved" | "stale";
}) {
  const fill =
    state === "resolved"
      ? palette.ink
      : state === "stale"
        ? "rgba(255,106,26,0.45)"
        : palette.accent;
  const glyph = state === "resolved" ? "✓" : "!";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 60 60"
      aria-hidden="true"
      className={className}
    >
      {state === "confirmed" && (
        <circle
          cx="30"
          cy="30"
          r="18"
          fill="none"
          stroke={palette.accent}
          strokeOpacity="0.2"
          strokeWidth="6"
        />
      )}
      <circle
        cx="30"
        cy="30"
        r="10"
        fill={fill}
        stroke={palette.cream}
        strokeWidth="1.8"
      />
      <text
        x="30"
        y="33.5"
        textAnchor="middle"
        fill={palette.cream}
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 10,
          fontWeight: 800,
        }}
      >
        {glyph}
      </text>
    </svg>
  );
}

/** Peak / pass · open triangle + summit dot, mono label trailing. */
export function PeakGlyph({
  size = 60,
  label = "STELVIO",
  elev = "2757m",
  className,
}: MapGlyphProps & { label?: string; elev?: string }) {
  return (
    <svg
      width={size * 1.4}
      height={size}
      viewBox="0 0 80 60"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M 31 35 L 40 21 L 49 35 Z"
        fill="none"
        stroke="rgba(14,14,16,0.62)"
        strokeWidth="1.5"
      />
      <circle cx="40" cy="21" r="1.8" fill="rgba(14,14,16,0.62)" />
      <text
        x="56"
        y="29"
        fill="rgba(14,14,16,0.62)"
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: 0.5,
        }}
      >
        {label}
      </text>
      <text
        x="56"
        y="41"
        fill="rgba(14,14,16,0.45)"
        style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 8 }}
      >
        {elev}
      </text>
    </svg>
  );
}

/** Town · ink dot + halo ring + sans label. */
export function TownGlyph({
  size = 60,
  name = "Bormio",
  className,
}: MapGlyphProps & { name?: string }) {
  return (
    <svg
      width={size * 1.4}
      height={size}
      viewBox="0 0 80 60"
      aria-hidden="true"
      className={className}
    >
      <circle cx="20" cy="30" r="4.5" fill={palette.ink} />
      <circle
        cx="20"
        cy="30"
        r="9"
        fill="none"
        stroke={palette.ink}
        strokeOpacity="0.3"
      />
      <text
        x="34"
        y="33"
        fill={palette.ink}
        style={{
          fontFamily: "Space Grotesk, system-ui",
          fontSize: 13,
          fontWeight: 700,
        }}
      >
        {name}
      </text>
    </svg>
  );
}

/** Fun Zone · radial gradient blob. */
export function FunZoneGlyph({
  size = 60,
  tier = 5,
  className,
}: MapGlyphProps & { tier?: 4 | 5 }) {
  const c = qualityColors[tier - 1];
  return (
    <svg
      width={size * 1.6}
      height={size}
      viewBox="0 0 100 60"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <radialGradient id={`fz-${tier}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={c} stopOpacity="0.55" />
          <stop offset="100%" stopColor={c} stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="50" cy="30" rx="40" ry="22" fill={`url(#fz-${tier})`} />
    </svg>
  );
}

/** Quality ribbon · multi-segment, multi-quality polyline. */
export function QualityRibbonGlyph({ size = 40, className }: MapGlyphProps) {
  const w = size * 4.5;
  return (
    <svg
      width={w}
      height={size}
      viewBox="0 0 180 40"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M 10 30 C 30 20, 50 24, 70 20"
        stroke={qualityColors[4]}
        strokeWidth="5.5"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M 70 20 C 90 16, 110 10, 130 12"
        stroke={qualityColors[3]}
        strokeWidth="5.5"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M 130 12 C 150 14, 165 20, 170 28"
        stroke={qualityColors[1]}
        strokeWidth="5.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Cluster glyph · accent or ink fill, count number. */
export function ClusterGlyph({
  size = 60,
  count = 7,
  variant = "hazard",
  selected = false,
  className,
}: MapGlyphProps & {
  count?: number;
  variant?: "hazard" | "waypoint";
  selected?: boolean;
}) {
  const isHazard = variant === "hazard";
  const fill = isHazard ? palette.accent : palette.ink;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 60 60"
      aria-hidden="true"
      className={className}
    >
      {isHazard && (
        <circle
          cx="30"
          cy="30"
          r="16"
          fill={palette.accent}
          fillOpacity="0.18"
        />
      )}
      <circle
        cx="30"
        cy="30"
        r={isHazard ? 12 : 14}
        fill={fill}
        stroke={selected ? palette.accent : palette.cream}
        strokeWidth={selected ? 2.5 : 2}
      />
      <text
        x="30"
        y="34"
        textAnchor="middle"
        fill={palette.cream}
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        {count}
      </text>
    </svg>
  );
}

/** Collaborator cursor · pointer path + name tag. */
export function CollaboratorCursor({
  name = "Mira",
  color = "#6FD38A",
  size = 60,
  className,
}: MapGlyphProps & { name?: string; color?: string }) {
  // Tag pill width scales with the name; the viewBox must grow with it
  // so longer collaborator names don't get clipped at the right edge.
  // Base layout uses x=24 for the rect with 4 px right margin inside the
  // viewport; reference geometry (size=60) yields width=84 for short names.
  const tagWidth = Math.max(48, name.length * 8 + 14);
  const viewportWidth = Math.max(84, 24 + tagWidth + 4);
  return (
    <svg
      width={(size * viewportWidth) / 60}
      height={size * 0.8}
      viewBox={`0 0 ${viewportWidth} 48`}
      aria-hidden="true"
      className={className}
    >
      <path
        d="M 6 6 L 22 12 L 13 14 L 17 23 L 14 24 L 10 16 L 6 20 Z"
        fill={color}
        stroke={palette.ink}
        strokeWidth="1"
      />
      <rect
        x="24"
        y="10"
        rx="4"
        ry="4"
        width={tagWidth}
        height="18"
        fill={color}
      />
      <text
        x="31"
        y="23"
        fill={palette.ink}
        style={{
          fontFamily: "Space Grotesk, system-ui",
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        {name}
      </text>
    </svg>
  );
}

/**
 * North arrow + scale bar combo · drawn directly into the map SVG.
 * Renders both stacked for the overlay legend / compass corner.
 *
 * SVG strokes/fills use `currentColor`, so the overlay legibility is
 * driven by CSS text color. Default is ink at ~62 % opacity (matches
 * the cream/paper map surfaces in §22). Pass `onDark` for ink/satellite
 * map modes where ink would disappear into the dark background.
 */
export function CompassScale({
  className,
  onDark = false,
}: {
  className?: string;
  onDark?: boolean;
}): ReactNode {
  const rootTone = onDark ? "text-cream/[0.62]" : "text-ink/[0.62]";
  const labelTone = onDark ? "text-cream/60" : "text-fg-dim";
  return (
    <div className={`flex items-center gap-6 ${rootTone} ${className ?? ""}`}>
      <div className="relative size-[60px]">
        <svg viewBox="0 0 60 60" className="size-full">
          <circle
            cx="30"
            cy="30"
            r="22"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
          />
          <path d="M 30 14 L 24 36 L 30 30 L 36 36 Z" fill="currentColor" />
          <text
            x="30"
            y="10"
            textAnchor="middle"
            fill="currentColor"
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 9,
              fontWeight: 700,
            }}
          >
            N
          </text>
        </svg>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <svg width="100" height="12" viewBox="0 0 100 12">
          <line
            x1="4"
            y1="6"
            x2="96"
            y2="6"
            stroke="currentColor"
            strokeWidth="2"
          />
          <line
            x1="4"
            y1="2"
            x2="4"
            y2="10"
            stroke="currentColor"
            strokeWidth="2"
          />
          <line
            x1="50"
            y1="3"
            x2="50"
            y2="9"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <line
            x1="96"
            y1="2"
            x2="96"
            y2="10"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
        <span className={`font-mono text-[10px] tracking-[1px] ${labelTone}`}>
          10 KM
        </span>
      </div>
    </div>
  );
}
