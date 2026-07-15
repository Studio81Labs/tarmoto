import type { ReactNode } from "react";
import { cn } from "../../utils/cn";
import { FieldLabel } from "./FieldLabel";
import { FieldHint } from "./FieldHint";

export interface FieldProps {
  id: string;
  label?: ReactNode;
  hint?: ReactNode;
  error?: boolean;
  children: (a: { id: string; hintId?: string; error: boolean }) => ReactNode;
  className?: string;
}

/** Composes label + control + hint and wires the a11y ids. */
export function Field({
  id,
  label,
  hint,
  error = false,
  children,
  className,
}: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={cn("w-full", className)}>
      {label && <FieldLabel htmlFor={id}>{label}</FieldLabel>}
      {children({ id, ...(hintId !== undefined ? { hintId } : {}), error })}
      {hint && (
        <FieldHint
          {...(hintId !== undefined ? { id: hintId } : {})}
          tone={error ? "error" : "default"}
        >
          {hint}
        </FieldHint>
      )}
    </div>
  );
}
