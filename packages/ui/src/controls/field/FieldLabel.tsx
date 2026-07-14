import type { ReactNode } from "react";
import { cn } from "../../utils/cn";

export interface FieldLabelProps {
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

/** §09 field-label: small mono-ish caption above a field. */
export function FieldLabel({ htmlFor, children, className }: FieldLabelProps) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn(
        "mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.6px] text-fg-dim",
        className,
      )}
    >
      {children}
    </label>
  );
}
