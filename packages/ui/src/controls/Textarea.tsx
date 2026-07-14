import type { ReactNode } from "react";
import { cn } from "../utils/cn";
import { fieldChrome } from "./field/fieldChrome";
import { FieldHint } from "./field/FieldHint";

/**
 * Textarea · multi-line text field. Spec: §09.
 * Shares `fieldChrome` with Input/Select; `resize-none` keeps panel layouts
 * stable. See Input for the `tone`/labelling rationale.
 */
export interface TextareaProps {
  value: string;
  onChange: (value: string) => void;
  tone?: "paper" | "cream";
  id?: string;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  maxLength?: number;
  error?: boolean;
  hint?: ReactNode;
  hintId?: string | undefined;
  className?: string;
}

export function Textarea({
  value,
  onChange,
  tone = "paper",
  id,
  rows = 3,
  placeholder,
  disabled = false,
  ariaLabel,
  maxLength,
  error = false,
  hint,
  hintId,
  className,
}: TextareaProps) {
  // Mirror Input: honor an externally-supplied `hintId` even without a local
  // `hint`, so a `Field`-wrapped Textarea (Field renders the hint and passes
  // only `hintId`) still wires `aria-describedby`.
  const resolvedHintId =
    hintId ?? (hint ? (id ? `${id}-hint` : undefined) : undefined);
  return (
    <div className={cn("w-full", className)}>
      <textarea
        id={id}
        rows={rows}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={error || undefined}
        aria-describedby={resolvedHintId}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          fieldChrome({ tone, disabled, error }),
          "resize-none leading-relaxed",
        )}
      />
      {hint && (
        <FieldHint
          {...(resolvedHintId !== undefined ? { id: resolvedHintId } : {})}
          tone={error ? "error" : "default"}
        >
          {hint}
        </FieldHint>
      )}
    </div>
  );
}
