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
        tone === "dim" && "text-ink/60",
        tone === "ink" && "text-ink",
        tone === "accent" && "text-accent",
        tone === "on-dark" && "text-cream",
        tone === "on-dark-dim" && "text-cream/60",
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
    sm: "text-lg",
    md: "text-2xl",
    lg: "text-[28px]",
    xl: "text-[32px]",
  } as const;
  return (
    <div
      className={clsx(
        "font-sans font-bold tracking-tight leading-[1.05]",
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
  variant?: "ink" | "accent" | "outline" | "ghost";
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
    outline: "bg-transparent text-ink border-ink/20",
    ghost: "bg-paper text-ink border-paper",
  }[variant];
  return (
    <Tag
      onClick={onClick}
      type={Tag === "button" ? (type ?? "button") : undefined}
      disabled={disabled}
      title={title}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold tracking-[0.2px] whitespace-nowrap",
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
  size = 6,
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
            height: size * 2.2,
            borderRadius: 1.5,
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
    cream: "bg-cream border-ink/10 text-ink",
    paper: "bg-paper border-ink/10 text-ink",
    ink: "bg-ink border-ink text-cream",
  }[variant];
  return (
    <div className={clsx("rounded-2xl border", v, className)}>{children}</div>
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
