import { cn } from "../utils/cn";

/** 6–14 px circular indicator. Pairs with Stamps and Pills. */
export interface DotProps {
  color?: string;
  size?: number;
  className?: string;
}

export function Dot({ color = "currentColor", size = 8, className }: DotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block shrink-0 rounded-full", className)}
      style={{ width: size, height: size, background: color }}
    />
  );
}
