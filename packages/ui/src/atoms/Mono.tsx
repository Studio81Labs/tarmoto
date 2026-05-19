import type { ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * Mono numeric/identifier text — distances, durations, coordinates.
 * Tabular numerics for table cells.
 */
export interface MonoProps {
  children: ReactNode;
  className?: string;
  as?: "span" | "div";
}

export function Mono({ children, className, as: Tag = "span" }: MonoProps) {
  return (
    <Tag className={cn("font-mono tabular-nums", className)}>{children}</Tag>
  );
}
