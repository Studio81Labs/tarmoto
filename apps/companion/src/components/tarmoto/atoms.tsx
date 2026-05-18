/**
 * Tarmoto · shared cream/ink atoms (Web App v2 design language).
 *
 * Stamps, pills, quality bars, dots, and dividers used across the companion.
 * Mirrors the components in tarmoto/project/atoms.jsx so the web companion
 * speaks the same vocabulary as mobile + marketing.
 */
import clsx from "clsx";
import type { ReactNode } from "react";

export const QUALITY_COLORS = [
  "#E05A3C", // q1 · avoid
  "#F0A03C", // q2 · rough
  "#E8D66A", // q3 · ok
  "#C7D36A", // q4 · great
  "#6FD38A", // q5 · hero
] as const;

export type QualityTier = 1 | 2 | 3 | 4 | 5;

export function Stamp({
  children,
  tone = "dim",
  className,
}: {
  children: ReactNode;
  tone?: "dim" | "ink" | "accent" | "on-dark" | "on-dark-dim";
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "font-mono text-[10px] font-bold uppercase tracking-[1.5px] leading-none",
        tone === "dim" && "text-fg-dim",
        tone === "ink" && "text-ink",
        tone === "accent" && "text-accent",
        tone === "on-dark" && "text-fg-on-dark",
        tone === "on-dark-dim" && "text-fg-on-dark-dim",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Heading({
  children,
  size = "lg",
  className,
}: {
  children: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const sizes = {
    sm: "text-[18px]",
    md: "text-[22px]",
    lg: "text-[28px]",
    xl: "text-[32px]",
  } as const;
  return (
    <div
      className={clsx(
        "font-sans font-extrabold tracking-[-0.5px] leading-[1.05] text-ink",
        sizes[size],
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Pill({
  children,
  variant = "ink",
  className,
  onClick,
  as: Tag = "span",
  type,
  disabled,
  title,
}: {
  children: ReactNode;
  variant?: "ink" | "accent" | "outline" | "ghost" | "danger";
  className?: string;
  onClick?: () => void;
  as?: "span" | "button";
  type?: "button" | "submit";
  disabled?: boolean;
  title?: string;
}) {
  const variantClass = {
    ink: "bg-ink text-cream border-ink",
    accent: "bg-accent text-ink border-accent",
    outline: "bg-transparent text-ink border-line-strong",
    ghost: "bg-paper text-ink border-paper",
    danger: "bg-transparent text-quality-q1 border-quality-q1",
  }[variant];
  return (
    <Tag
      onClick={onClick}
      type={Tag === "button" ? (type ?? "button") : undefined}
      disabled={disabled}
      title={title}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[5px] text-[11px] font-bold tracking-[0.2px] whitespace-nowrap",
        variantClass,
        onClick && !disabled && "cursor-pointer transition hover:brightness-95",
        disabled && "opacity-50 cursor-not-allowed",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function QualityBars({
  q,
  size = 8,
  className,
}: {
  q: QualityTier | number;
  size?: number;
  className?: string;
}) {
  const tier = Math.max(1, Math.min(5, Math.round(q))) as QualityTier;
  return (
    <div className={clsx("inline-flex gap-[2px]", className)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <div
          key={n}
          style={{
            width: size,
            height: size * 1.75,
            borderRadius: 2,
            background:
              n <= tier ? QUALITY_COLORS[tier - 1] : "rgba(14,14,16,0.08)",
          }}
        />
      ))}
    </div>
  );
}

export function Dot({
  color = "currentColor",
  size = 8,
  className,
}: {
  color?: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={clsx("inline-block rounded-full shrink-0", className)}
      style={{ width: size, height: size, background: color }}
    />
  );
}

export function Mono({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={clsx("font-mono tabular-nums", className)}>
      {children}
    </span>
  );
}

export function Card({
  children,
  variant = "cream",
  className,
}: {
  children: ReactNode;
  variant?: "cream" | "paper" | "ink";
  className?: string;
}) {
  const v = {
    cream: "bg-cream border-line text-ink",
    paper: "bg-paper border-line text-ink",
    ink: "bg-ink border-ink text-cream",
  }[variant];
  return (
    <div className={clsx("rounded-2xl border", v, className)}>{children}</div>
  );
}

/**
 * Canonical SVG route preview — topo contours + quality-segmented road
 * ribbon, with optional hazard pulse and animated rider position.
 *
 * Geometry mirrors `docs/design/companion-spec/source/atoms.jsx`. The road
 * path is hand-drawn for the preview/placeholder use case (trip-card
 * thumbnails, share previews), NOT data-driven — Phase 3 view sweeps may
 * extend it with real route points but the canonical fallback stays.
 */
export function RouteMini({
  progress = 0,
  showHazard = false,
  dark = false,
  tall = false,
  className,
}: {
  progress?: number;
  showHazard?: boolean;
  dark?: boolean;
  tall?: boolean;
  className?: string;
}) {
  const accent = "#FF6A1A";
  const ink = "#0E0E10";
  const cream = "#F5EFE6";
  const bg = dark ? "#17181C" : "#EDE6DA";
  const topoStroke = dark ? "rgba(255,255,255,0.08)" : "rgba(14,14,16,0.08)";
  const roadBase = dark ? "#1A1B1E" : "#C4BBA8";

  const riderPosition = (() => {
    if (progress <= 0) return null;
    const samples: Array<[number, number]> = [
      [8, 150],
      [60, 142],
      [100, 128],
      [140, 120],
      [185, 100],
      [220, 88],
      [260, 72],
      [310, 55],
      [372, 30],
    ];
    const clamped = Math.min(1, Math.max(0, progress));
    const i = Math.min(
      samples.length - 2,
      Math.floor(clamped * (samples.length - 1)),
    );
    const t = clamped * (samples.length - 1) - i;
    const [x0, y0] = samples[i];
    const [x1, y1] = samples[i + 1];
    return {
      x: x0 + (x1 - x0) * t,
      y: y0 + (y1 - y0) * t,
    };
  })();

  return (
    <div
      className={clsx(
        "relative w-full overflow-hidden rounded-[18px]",
        className,
      )}
      style={{ height: tall ? 180 : 120, background: bg }}
    >
      <svg
        viewBox="0 0 380 180"
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        {[40, 70, 100, 130].map((y) => (
          <path
            key={y}
            d={`M -10 ${y} C 60 ${y - 10}, 140 ${y + 15}, 220 ${y - 5} S 340 ${y + 8}, 400 ${y - 5}`}
            stroke={topoStroke}
            strokeWidth="1"
            fill="none"
          />
        ))}
        <path
          d="M 8 150 C 60 140, 100 120, 140 130 S 220 80, 270 70 S 340 40, 372 30"
          stroke={roadBase}
          strokeWidth="10"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M 8 150 C 40 145, 70 130, 100 128"
          stroke={QUALITY_COLORS[4]}
          strokeWidth="7"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M 100 128 C 130 125, 160 110, 185 100"
          stroke={QUALITY_COLORS[3]}
          strokeWidth="7"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M 185 100 C 210 90, 235 75, 260 72"
          stroke={QUALITY_COLORS[1]}
          strokeWidth="7"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M 260 72 C 290 68, 320 50, 372 30"
          stroke={QUALITY_COLORS[4]}
          strokeWidth="7"
          fill="none"
          strokeLinecap="round"
        />

        {showHazard && (
          <g transform="translate(222 86)">
            <circle r="10" fill={accent} opacity="0.3">
              <animate
                attributeName="r"
                values="6;14;6"
                dur="1.6s"
                repeatCount="indefinite"
              />
            </circle>
            <circle r="6" fill={accent} />
          </g>
        )}

        <circle cx="8" cy="150" r="7" fill={accent} />
        <circle cx="8" cy="150" r="3" fill={ink} />
        <circle cx="372" cy="30" r="7" fill={ink} />
        <circle cx="372" cy="30" r="3" fill={cream} />

        {riderPosition && (
          <g transform={`translate(${riderPosition.x} ${riderPosition.y})`}>
            <circle r="12" fill={accent} opacity="0.25" />
            <circle
              r="6"
              fill={accent}
              stroke={dark ? ink : cream}
              strokeWidth="1.5"
            />
          </g>
        )}
      </svg>
    </div>
  );
}

/**
 * Tarmoto triangle mountain glyph — used in the sidebar logo, marketing
 * sites, and any place that needs the brand mark inline.
 */
/**
 * Canonical Tarmoto mark — geometry mirrors `docs/design/brand/logo-mark.svg`.
 * The earlier triangle was a placeholder pulled from the design sketches
 * before the brand was finalised; this one matches every other surface
 * (marketing site, favicon, mobile splash).
 *
 * Composed of two rounded rects forming a `T` and a wavy road path
 * below — the road-quality signal motif that runs through the brand.
 * Callers wrap it in an accent square (the sidebar / AppLogo do this);
 * the mark itself ships transparent so the same component works on any
 * background.
 */
export function TarmotoMark({
  size = 18,
  color = "#1A120D",
  className,
}: {
  size?: number;
  color?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      aria-hidden="true"
    >
      <rect x="18" y="20" width="64" height="12" rx="4" fill={color} />
      <rect x="40" y="20" width="20" height="42" rx="4" fill={color} />
      <path
        d="M 16 80 L 30 80 L 38 70 L 46 86 L 54 68 L 62 82 L 70 76 L 84 76"
        stroke={color}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
