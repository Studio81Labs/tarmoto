import { useId, type ReactNode } from "react";
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
  /** Optional for `readOnly` fields (e.g. copyable embed snippets). */
  onChange?: (value: string) => void;
  /** Read-only display (copyable code/links); pairs with `mono`. */
  readOnly?: boolean;
  /** Monospace content — embed snippets, code, tokens. */
  mono?: boolean;
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
  readOnly = false,
  mono = false,
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
  // `hint` (so a `Field`-wrapped Textarea still wires `aria-describedby`), and
  // fall back to a generated id for `ariaLabel`-only fields with a local hint
  // but no `id`/`hintId` (otherwise the hint is invisible to AT).
  const autoHintId = useId();
  const resolvedHintId =
    hintId ?? (hint ? (id ? `${id}-hint` : autoHintId) : undefined);
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
        readOnly={readOnly}
        onChange={(event) => onChange?.(event.target.value)}
        className={cn(
          fieldChrome({ tone, disabled, error }),
          "resize-none leading-relaxed",
          mono && "font-mono text-xs",
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
