import type { ReactNode } from "react";
import { cn } from "../../utils/cn";

export interface FieldHintProps {
  id?: string;
  tone?: "default" | "error";
  children: ReactNode;
  className?: string;
}

/** §09 field-hint: helper text below a field. `error` = Q1. */
export function FieldHint({
  id,
  tone = "default",
  children,
  className,
}: FieldHintProps) {
  return (
    <p
      id={id}
      className={cn(
        "mt-1.5 text-[11px] leading-snug",
        tone === "error" ? "text-quality-q1" : "text-fg-mute",
        className,
      )}
    >
      {children}
    </p>
  );
}
