import { cn } from "../utils/cn";

/**
 * Tarmoto brand mark — the T-with-road glyph. Inlined SVG, transparent
 * background. Callers wrap it in an accent square if they want the full
 * sidebar/AppLogo treatment.
 */
export interface TarmotoMarkProps {
  size?: number;
  color?: string;
  className?: string;
}

export function TarmotoMark({
  size = 18,
  color = "#1A120D",
  className,
}: TarmotoMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={cn(className)}
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
