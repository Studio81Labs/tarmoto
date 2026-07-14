import type { ReactNode } from "react";
import { cn } from "../utils/cn";
import { fieldChrome } from "./field/fieldChrome";
import { FieldHint } from "./field/FieldHint";

/**
 * Input · single-line text field. Spec: §09.
 * Shares `fieldChrome` with Textarea/Select. `tone` matches the field
 * surface to its container. Pass an external `<label htmlFor>` + matching
 * `id`, or `ariaLabel`.
 */
export interface InputProps {
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "search" | "url" | "tel";
  tone?: "paper" | "cream";
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  ariaLabel?: string;
  maxLength?: number;
  leadingIcon?: ReactNode;
  error?: boolean;
  hint?: ReactNode;
  hintId?: string | undefined;
  className?: string;
}

export function Input({
  value,
  onChange,
  type = "text",
  tone = "paper",
  id,
  placeholder,
  disabled = false,
  readOnly = false,
  ariaLabel,
  maxLength,
  leadingIcon,
  error = false,
  hint,
  hintId,
  className,
}: InputProps) {
  const resolvedHintId =
    hintId ?? (hint ? (id ? `${id}-hint` : undefined) : undefined);
  return (
    <div className={cn("w-full", className)}>
      <div className="relative">
        {leadingIcon && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-mute"
          >
            {leadingIcon}
          </span>
        )}
        <input
          id={id}
          type={type}
          value={value}
          disabled={disabled}
          readOnly={readOnly}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-invalid={error || undefined}
          aria-describedby={resolvedHintId}
          maxLength={maxLength}
          onChange={(event) => onChange(event.target.value)}
          className={fieldChrome({
            tone,
            disabled,
            error,
            hasLeading: !!leadingIcon,
          })}
        />
      </div>
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
